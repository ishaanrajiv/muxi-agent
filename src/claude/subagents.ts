/**
 * Claude subagents: the CLI's own `Agent` subagents, run as the caller's one
 * subagent role. A `PreToolUse` hook pins each start to that role in the
 * foreground and holds the limits, the CLI's task events and the subagent's own
 * frames feed its state, and its tool result is its report.
 */

import type { SubagentRef, ToolDenial } from "../types/index.ts";
import { SUBAGENT_MAX_LIVE } from "../types/index.ts";
import type { AgentDefinition, HookInput, Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";

import type { SubagentRole, SubagentTracker } from "../subagents.ts";
import { CLAUDE_WEB_TOOLS } from "../web-search.ts";
import { parseToolName, PLAN_TOOLS, toContentBlocks } from "./tools.ts";
import type { LiveTurn } from "./turn.ts";

/** The CLI's subagent tool, which starts a subagent. A turn gets it only while
 *  subagents are on; `Task` is its old name. */
export const SUBAGENT_TOOL = "Agent";
export const SUBAGENT_TOOLS: ReadonlySet<string> = new Set([SUBAGENT_TOOL, "Task"]);

/** What a subagent turn's CLI adds to its env: no built-in agents (only the
 *  configured role exists), no forks of the whole conversation (a subagent starts
 *  from its brief), one level deep, and at most {@link SUBAGENT_MAX_LIVE} at once. */
export const SUBAGENT_ENV = {
  CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS: "1",
  CLAUDE_CODE_FORK_SUBAGENT: "0",
  CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: "1",
  CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: String(SUBAGENT_MAX_LIVE),
};

/** A turn's subagent bookkeeping, on its {@link LiveTurn}. */
export interface TurnSubagents {
  tracker: SubagentTracker;
  /** Each subagent's CLI task id, by subagent id (the `Agent` call's tool_use id),
   *  for `stopTask`. */
  tasks: Map<string, string>;
  /** The subagent behind a CLI agent id (its task id) or behind one of its own
   *  tool calls, so a permission request can name the subagent that asked. */
  owners: Map<string, string>;
}

export function turnSubagents(tracker: SubagentTracker): TurnSubagents {
  return { tracker, tasks: new Map(), owners: new Map() };
}

/**
 * The subagent role as a Claude agent definition. It runs in the foreground on
 * the thread's model, under the thread's permission mode, and sees the
 * thread's tools minus the role's refused tools, the plan tools, the web tools
 * and the subagent tool itself. A host's policy should refuse a subagent's
 * writes too (its approvals carry `subagent`); hiding them only saves the
 * subagent a refused call.
 */
export function subagentAgentDefinition(role: SubagentRole): AgentDefinition {
  return {
    description: role.description,
    prompt: role.instructions,
    disallowedTools: [
      ...SUBAGENT_TOOLS,
      ...PLAN_TOOLS,
      ...CLAUDE_WEB_TOOLS,
      ...(role.refusedTools ?? []).map(({ server, tool }) => (tool ? `mcp__${server}__${tool}` : `mcp__${server}`)),
    ],
    model: "inherit",
    background: false,
    omitClaudeMd: true,
  };
}

/** The SDK options a subagent turn adds: the one role, a one-line progress
 *  summary per subagent about every 30 seconds, and the CLI's own limits set to
 *  this package's. */
export function subagentTurnOptions(role: SubagentRole): Partial<Options> {
  return {
    agents: { [role.role]: subagentAgentDefinition(role) },
    agentProgressSummaries: true,
    env: { ...process.env, ...SUBAGENT_ENV },
  };
}

/**
 * Decide one `Agent` call: start it as a subagent with its input pinned to the
 * role in the foreground, or refuse it past the limits. A second decision on a
 * call already started (the hook and the permission callback can both see it)
 * allows it again without counting it twice.
 */
export function decideSubagentLaunch(
  subagents: SubagentTracker | null,
  toolUseId: string,
  input: Record<string, unknown>,
  fromSubagent: boolean,
): { allow: true; input: Record<string, unknown> } | { allow: false; reason: string } {
  if (!subagents) return { allow: false, reason: "Subagents are off in this thread." };
  if (fromSubagent) return { allow: false, reason: "A subagent can't start subagents. Do the work yourself." };
  const { model: _model, effort: _effort, isolation: _isolation, ...rest } = input;
  const pinned = { ...rest, subagent_type: subagents.role, run_in_background: false };
  if (subagents.has(toolUseId)) return { allow: true, input: pinned };
  const refusal = subagents.refusal();
  if (refusal) return { allow: false, reason: refusal };
  subagents.start(toolUseId, {
    name: typeof input.description === "string" ? input.description : typeof input.name === "string" ? input.name : null,
    brief: typeof input.prompt === "string" ? input.prompt : null,
  });
  return { allow: true, input: pinned };
}

/**
 * A subagent turn's `PreToolUse` hook on the subagent tool. Hooks run before
 * the permission mode, so the limits hold however the CLI would otherwise
 * decide the call, and the call's input is pinned to the subagent role in the
 * foreground (see {@link decideSubagentLaunch}). Every other call goes on to
 * `canUseTool` and the host.
 */
export function subagentHooks(subagentsOf: () => SubagentTracker | null): NonNullable<Options["hooks"]> {
  const handle = async (input: HookInput) => {
    if (input.hook_event_name !== "PreToolUse" || !SUBAGENT_TOOLS.has(input.tool_name)) return { continue: true };
    const decision = decideSubagentLaunch(
      subagentsOf(),
      input.tool_use_id,
      (input.tool_input ?? {}) as Record<string, unknown>,
      input.agent_id != null,
    );
    return {
      hookSpecificOutput: decision.allow
        ? { hookEventName: "PreToolUse" as const, permissionDecision: "allow" as const, updatedInput: decision.input }
        : { hookEventName: "PreToolUse" as const, permissionDecision: "deny" as const, permissionDecisionReason: decision.reason },
    };
  };
  return { PreToolUse: [{ hooks: [handle] }] };
}

/**
 * Which subagent made a permission request: the one the CLI agent id belongs
 * to, else the one that made the call. An agent the turn can't place still
 * counts as a subagent, so the gate refuses its writes all the same.
 */
export function subagentRefOf(subagents: TurnSubagents | null | undefined, agentId: string, toolUseId: string): SubagentRef {
  const subagentId = subagents?.owners.get(agentId) ?? subagents?.owners.get(toolUseId);
  const name = subagentId ? subagents?.tracker.name(subagentId) : undefined;
  return subagentId && name ? { id: subagentId, name } : { id: agentId, name: "Subagent" };
}

/** Stop one live subagent of a turn: mark it stopping, then the CLI stops its
 *  task. False when the turn has no such live subagent. */
export async function stopTurnSubagent(live: LiveTurn | undefined, subagentId: string): Promise<boolean> {
  const subagents = live?.subagents;
  const taskId = subagents?.tasks.get(subagentId);
  if (!live || !subagents || !taskId || live.isSettled() || !subagents.tracker.liveIds().includes(subagentId)) return false;
  if (!live.q.stopTask) return false;
  subagents.tracker.markStopping(subagentId);
  await live.q.stopTask(taskId);
  return true;
}

type SubagentTaskMessage = Extract<SDKMessage, { subtype: "task_started" | "task_progress" | "task_notification" }>;

/** Whether an SDK message is one of the CLI's task events. */
export function isSubagentTaskMessage(msg: SDKMessage): msg is SubagentTaskMessage {
  return (
    msg.type === "system" &&
    (msg.subtype === "task_started" || msg.subtype === "task_progress" || msg.subtype === "task_notification")
  );
}

/**
 * The CLI's task events for a subagent, joined to it by its `Agent` call's id:
 * the start (its task id, for Stop and for naming its permission requests),
 * its progress summary, and how it ended. A completed subagent's report comes
 * from the call's result instead, which carries the whole text.
 */
export function mapSubagentTask(msg: SubagentTaskMessage, subagents: TurnSubagents | null): void {
  const subagentId = msg.tool_use_id;
  if (!subagents || !subagentId) return;
  const { tracker } = subagents;
  if (msg.subtype === "task_started") {
    if (msg.task_type != null && msg.task_type !== "local_agent") return;
    tracker.start(subagentId, { name: msg.description, brief: msg.prompt ?? null });
    subagents.tasks.set(subagentId, msg.task_id);
    subagents.owners.set(msg.task_id, subagentId);
  } else if (msg.subtype === "task_progress") {
    tracker.action(subagentId, msg.summary);
  } else if (msg.status === "failed") {
    tracker.finish(subagentId, "failed", { error: msg.summary || "The subagent couldn't finish." });
  } else if (msg.status === "stopped") {
    // A stop's summary is the task's description, not a reason.
    tracker.finish(subagentId, "stopped");
  } else {
    tracker.finish(subagentId, "completed");
  }
}

/** A subagent's own tool calls and results: an MCP call opens a call on its
 *  subagent and its result settles it, refused when the host's side refused it
 *  (`denials`, by tool_use id). Its text and reasoning are its own. */
export function mapSubagentFrame(
  subagentId: string,
  content: unknown,
  subagents: TurnSubagents,
  denials?: ReadonlyMap<string, ToolDenial>,
): void {
  if (!Array.isArray(content)) return;
  for (const block of content as Array<Record<string, unknown>>) {
    if (block.type === "tool_use" && typeof block.id === "string") {
      const { server, tool } = parseToolName(String(block.name ?? ""));
      if (server === "builtin") continue;
      subagents.owners.set(block.id, subagentId);
      subagents.tracker.call(subagentId, block.id, tool);
    } else if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
      const ok = block.is_error !== true;
      subagents.tracker.settleCall(subagentId, block.tool_use_id, ok, ok ? undefined : denials?.get(block.tool_use_id));
    }
  }
}

/** A subagent's `Agent` call result is its report (a refused start never started
 *  one); an errored result is why it failed. */
export function finishSubagentFromResult(subagents: TurnSubagents | null, toolUseId: string, content: unknown, isError: boolean): void {
  const text = toContentBlocks(content)
    .map((b) => b.text)
    .join("\n")
    .trim();
  subagents?.tracker.finish(
    toolUseId,
    isError ? "failed" : "completed",
    isError ? { error: text || "The subagent couldn't finish." } : { report: text },
  );
}

/** The frames of one of the turn's subagents: they name its `Agent` call in
 *  `parent_tool_use_id`, and feed its row, never the turn's answer or rail. */
export function subagentFrameOwner(parentToolUseId: string | null | undefined, subagents: TurnSubagents | null): string | null {
  return parentToolUseId != null && subagents?.tracker.has(parentToolUseId) ? parentToolUseId : null;
}
