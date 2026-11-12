/**
 * The plan behind Claude's `agent.plan.updated` snapshots. Claude's native task
 * tools are incremental (create or update one task by id), unlike Codex's
 * whole-list `update_plan`, so each thread keeps an accumulator that the CLI's
 * task hooks and the task tools' results both fold into, and every change
 * mirrors out the COMPLETE plan.
 */

import type { AgentEvent, AgentPlanPart } from "../types/index.ts";
import type {
  HookInput,
  Options,
  TaskCompletedHookInput,
  TaskCreatedHookInput,
} from "@anthropic-ai/claude-agent-sdk";

/** A thread's plan accumulator, part of its `ThreadState`. */
export interface PlanState {
  /** The thread's live plan, keyed by the CLI's task id in creation order — the
   *  accumulator behind every `agent.plan.updated` snapshot. Claude's task tools
   *  are incremental, so this is the only place the WHOLE plan exists. It is
   *  in-memory: after a provider restart it starts empty while the CLI session
   *  still holds the tasks, and the agent's next `TaskList` resyncs it. A plan
   *  whose every part is completed is dropped at the next turn's start (see
   *  `sendTurn`) so a finished agenda never bleeds into a later turn's plan. */
  plan: Map<string, AgentPlanPart>;
  /** Task id → the {@link plan} key it addresses, for the rare case where the
   *  `TaskCreated` hook and the tool result spell the same task's id differently.
   *  Empty in the normal case (both spell it the same). */
  planAliases: Map<string, string>;
}

/** Prefixed to the USER message of the first turn after a cold resume — not the
 *  system prompt, which is snapshotted for the conversation (see the
 *  `systemPrompt` turn option) and so cannot take a late append. The plan
 *  accumulator lives in memory only, so a restarted process holds no plan while
 *  the CLI session still does; one `TaskList` refills it (the tool's result is
 *  what {@link applyPlanResult} resyncs from). */
export const PLAN_RESYNC_HINT =
  "This session was reloaded. Before creating or updating any task, call TaskList " +
  "once to re-read the task list you already have.";

/**
 * The task-lifecycle hooks a chat turn registers. `TaskCreated` and
 * `TaskCompleted` are the CLI's own structural notices (task id and subject as
 * fields, no prose to parse), so they are the source of truth for a task
 * appearing and finishing. Everything else about a task still comes from the
 * tool result (see {@link applyPlanResult}), because no hook reports it: the
 * in-progress transition, a deletion, a renamed subject, the `activeForm` label,
 * and the whole-list `TaskList` resync.
 *
 * Snapshots emitted from a hook are the same whole-plan `agent.plan.updated`
 * events the tool path emits. `isSettled` guards the tail: a hook firing after
 * the turn's terminal event must not append to a closed turn.
 */
export function planHooks(
  threadId: string,
  plan: () => PlanState,
  isSettled: () => boolean,
  push: (ev: AgentEvent) => void,
): NonNullable<Options["hooks"]> {
  const handle = async (input: HookInput) => {
    if (
      (input.hook_event_name === "TaskCreated" || input.hook_event_name === "TaskCompleted") &&
      // Subagent tasks belong to a nested transcript, never to this turn's plan.
      input.agent_id == null
    ) {
      const parts = applyPlanHook(plan(), input);
      if (parts && !isSettled()) {
        push({ type: "agent.plan.updated", threadId, provider: "claude", parts });
      }
    }
    return { continue: true };
  };
  return {
    TaskCreated: [{ hooks: [handle] }],
    TaskCompleted: [{ hooks: [handle] }],
  };
}

/**
 * Fold one task-lifecycle hook into the thread's accumulator, returning the
 * COMPLETE plan when it changed (same contract as {@link applyPlanResult}) or
 * `undefined` when nothing moved.
 */
function applyPlanHook(
  state: PlanState,
  input: TaskCreatedHookInput | TaskCompletedHookInput,
): AgentPlanPart[] | undefined {
  const before = JSON.stringify([...state.plan]);
  const subject = input.task_subject?.trim();
  if (!input.task_id || !subject) return undefined;
  const key = planKey(state.plan, input.task_id, subject);
  const prev = state.plan.get(key);
  state.plan.set(key, {
    text: subject,
    // `TaskCreated` says nothing about status beyond "it exists"; a task the
    // parsers already moved to in_progress must not be pulled back to pending.
    status:
      input.hook_event_name === "TaskCompleted" ? "completed" : (prev?.status ?? "pending"),
    // No hook carries `activeForm`, so whatever the tool result gave us stands.
    ...(prev?.active ? { active: prev.active } : {}),
  });
  const parts = [...state.plan.values()];
  return JSON.stringify([...state.plan]) === before ? undefined : parts;
}

/**
 * Fold one settled plan-tool call into the thread's accumulator and return the
 * COMPLETE plan when it changed (the contract's `agent.plan.updated` is always
 * a full snapshot, matching Codex's whole-list `update_plan`), or `undefined`
 * when nothing moved.
 *
 * Applied on the RESULT, not the call: the CLI mints the task id there, and a
 * call that failed (`Task not found`) must leave the plan untouched.
 *
 *  - `TaskCreate` → append as pending, keyed by the minted id.
 *  - `TaskUpdate` → patch by id; status `deleted` removes it; an id we never saw
 *    is ignored (the next `TaskList` repairs the accumulator).
 *  - `TaskList`   → resync from the CLI's own snapshot, which is what recovers
 *    the plan after a provider restart drops this in-memory map while the CLI
 *    session still holds the tasks.
 *  - `TaskGet`    → read-only, never moves the plan.
 */
export function applyPlanResult(
  state: PlanState,
  tool: string,
  input: unknown,
  content: unknown,
): AgentPlanPart[] | undefined {
  const before = JSON.stringify([...state.plan]);

  if (tool === "TaskCreate") {
    const created = parseTaskCreateResult(content);
    const fields = readTaskInput(input);
    const text = fields.subject ?? created?.subject;
    if (created && text) {
      // The `TaskCreated` hook usually got here first with the same task; the
      // result adds the one field no hook reports (`activeForm`) and is the whole
      // source on a CLI that fires no hook.
      const key = planKey(state.plan, created.id, text);
      // The hook keyed the row under the CLI's task id; the model addresses later
      // updates by the id it read off this result. They are normally the same
      // string; when they aren't, remember which row the update means.
      if (key !== created.id) state.planAliases.set(created.id, key);
      const prev = state.plan.get(key);
      state.plan.set(key, {
        text: prev?.text ?? text,
        status: prev?.status ?? "pending",
        ...(fields.active ? { active: fields.active } : prev?.active ? { active: prev.active } : {}),
      });
    }
  } else if (tool === "TaskUpdate") {
    const fields = readTaskInput(input);
    const id = fields.taskId
      ? (state.planAliases.get(fields.taskId) ?? fields.taskId)
      : undefined;
    const entry = id ? state.plan.get(id) : undefined;
    if (id && entry && taskUpdateSucceeded(content)) {
      if (fields.status === "deleted") {
        state.plan.delete(id);
      } else {
        state.plan.set(id, {
          ...entry,
          ...(fields.subject ? { text: fields.subject } : {}),
          ...(fields.active ? { active: fields.active } : {}),
          ...(fields.status ? { status: planStatus(fields.status) } : {}),
        });
      }
    }
  } else if (tool === "TaskList") {
    const rows = parseTaskListResult(content);
    // A zero-row read is never trusted as "the plan is empty": an unparseable
    // or unexpected message would look identical, and removals already arrive
    // as explicit `deleted` updates.
    if (rows.length > 0) {
      state.plan = new Map(
        rows.map((row) => {
          const prev = state.plan.get(row.id);
          // The listing carries no activeForm — keep the one we already hold.
          return [
            row.id,
            { text: row.text, status: row.status, ...(prev?.active ? { active: prev.active } : {}) },
          ] as const;
        }),
      );
    }
  }

  const parts = [...state.plan.values()];
  return JSON.stringify([...state.plan]) === before ? undefined : parts;
}

/** A plan status the contract accepts; anything else normalizes to "pending". */
function planStatus(raw: unknown): AgentPlanPart["status"] {
  return raw === "in_progress" || raw === "completed" ? raw : "pending";
}

/** A non-empty trimmed string, or undefined. */
function str(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const t = raw.trim();
  return t ? t : undefined;
}

/**
 * The fields a task tool's INPUT carries. The streamed `tool_use` block holds the
 * raw shape the model emitted: Claude Code repairs near-miss key names
 * (`id`/`task_id` → `taskId`, `active_form` → `activeForm`) before executing the
 * tool, but that repair never reaches the message stream — so every alias the CLI
 * accepts must be read here too, or a repaired call would silently no-op the plan.
 */
export function readTaskInput(input: unknown): {
  taskId?: string;
  subject?: string;
  active?: string;
  status?: string;
} {
  const i = (input ?? {}) as Record<string, unknown>;
  const taskId = str(i.taskId) ?? str(i.id) ?? str(i.task_id);
  return {
    ...(taskId ? { taskId } : {}),
    ...(str(i.subject) ? { subject: str(i.subject) } : {}),
    ...(str(i.activeForm) ?? str(i.active_form)
      ? { active: str(i.activeForm) ?? str(i.active_form) }
      : {}),
    ...(str(i.status) ? { status: str(i.status) } : {}),
  };
}

/** A tool_result's `content` as plain text (a string, or joined text blocks). */
function taskResultText(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) {
    return raw
      .map((b) => (typeof b === "string" ? b : (str((b as { text?: unknown })?.text) ?? "")))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

/** The SDK's *declared* structured output, when the CLI sends JSON rather than the
 *  confirmation prose it emits today. Both shapes are handled by the parsers below. */
function taskResultJson(text: string): Record<string, unknown> | undefined {
  if (!text.trimStart().startsWith("{")) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The accumulator key a task refers to: its id when the plan already holds it,
 * otherwise a row carrying the same subject, otherwise the id itself (a new row).
 * The subject fallback is what keeps a task to ONE row when it arrives twice (once
 * from the `TaskCreated` hook, once from the tool result) on a CLI that spells the
 * two ids differently.
 */
export function planKey(
  plan: Map<string, AgentPlanPart>,
  id: string,
  subject?: string,
): string {
  if (plan.has(id)) return id;
  if (subject) {
    for (const [key, part] of plan) {
      if (part.text === subject) return key;
    }
  }
  return id;
}

/** `TaskCreate` confirmation → the id the CLI minted (+ the subject it echoed).
 *  Observed prose: `Task #1 created successfully: Pull revenue by region`.
 *  Declared JSON: `{ task: { id, subject } }`. */
export function parseTaskCreateResult(
  content: unknown,
): { id: string; subject?: string } | undefined {
  const text = taskResultText(content);
  const task = taskResultJson(text)?.task as { id?: unknown; subject?: unknown } | undefined;
  if (task) {
    const id = str(task.id) ?? (typeof task.id === "number" ? String(task.id) : undefined);
    return id ? { id, ...(str(task.subject) ? { subject: str(task.subject) } : {}) } : undefined;
  }
  const m = /^\s*task\s+#([A-Za-z0-9_-]+)\b[^:\n]*(?::\s*([^\n]+))?/i.exec(text);
  if (!m) return undefined;
  return { id: m[1], ...(str(m[2]) ? { subject: str(m[2]) } : {}) };
}

/** Did a `TaskUpdate` actually land? Observed success prose is
 *  `Updated task #1 status`; a bad id comes back as `Task not found` — with
 *  `is_error` UNSET, so the text is the only signal. */
export function taskUpdateSucceeded(content: unknown): boolean {
  const text = taskResultText(content);
  const json = taskResultJson(text);
  if (json && "success" in json) return json.success === true;
  return /\bupdated\s+task\b/i.test(text);
}

/** `TaskList` → the CLI's full snapshot. Observed prose is one line per task,
 *  `#1 [in_progress] Alpha` (deleted tasks are already omitted); declared JSON is
 *  `{ tasks: [{ id, subject, status }] }`. Neither carries `activeForm`. */
export function parseTaskListResult(
  content: unknown,
): Array<{ id: string; text: string; status: AgentPlanPart["status"] }> {
  const text = taskResultText(content);
  const tasks = taskResultJson(text)?.tasks;
  if (Array.isArray(tasks)) {
    const out = [];
    for (const raw of tasks) {
      const t = (raw ?? {}) as { id?: unknown; subject?: unknown; status?: unknown };
      const id = str(t.id) ?? (typeof t.id === "number" ? String(t.id) : undefined);
      const subject = str(t.subject);
      if (id && subject) out.push({ id, text: subject, status: planStatus(t.status) });
    }
    return out;
  }
  const out = [];
  for (const line of text.split("\n")) {
    const m = /^\s*#([A-Za-z0-9_-]+)\s*\[([a-z_]+)\]\s*(.+)$/i.exec(line);
    if (m) out.push({ id: m[1], text: m[3].trim(), status: planStatus(m[2]) });
  }
  return out;
}
