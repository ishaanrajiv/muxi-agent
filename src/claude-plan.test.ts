/**
 * The Claude backend's NATIVE plan tools (`TaskCreate`/`TaskUpdate`/`TaskList`/
 * `TaskGet`) — the counterpart of Codex's `update_plan`. They are the ONLY
 * built-ins the agent always has (isolation), they never reach the host as
 * approvals (a host policy would decline them), and they surface as
 * `agent.plan.updated` snapshots rather than tool-rail rows.
 *
 * Unlike Codex's whole-list `update_plan` these are INCREMENTAL, so the provider
 * folds them into a per-thread accumulator and every event still carries the
 * complete plan. The fixtures below are the payloads a real
 * `@anthropic-ai/claude-agent-sdk` 0.3.226 session produced — confirmation PROSE,
 * not the structured JSON the SDK's `sdk-tools.d.ts` declares. Driven through the
 * `queryFn` seam — no CLI is spawned.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { query } from "@anthropic-ai/claude-agent-sdk";

import { ClaudeAgentProvider } from "./claude-provider.ts";
import {
  parseTaskCreateResult,
  parseTaskListResult,
  readTaskInput,
  taskUpdateSucceeded,
} from "./claude/plan.ts";
import type { TurnStreamEvent, AgentPlanPart, StartThreadInput, TurnInput } from "./types/index.ts";

type QueryArgs = Parameters<typeof query>[0];

/** One observed tool call: the model's `tool_use` input + the CLI's prose result. */
interface Step {
  tool: string;
  input: Record<string, unknown>;
  result: string;
  /** The tool_result arrived with `is_error: true`. */
  isError?: boolean;
}

/** A `query()` double that replays `steps` as tool_use/tool_result pairs. */
function planQuery(captured: QueryArgs[], steps: Step[]): typeof query {
  return ((args: QueryArgs) => {
    captured.push(args);
    async function* run() {
      for (const [i, step] of steps.entries()) {
        const id = `call${i}`;
        yield {
          type: "assistant",
          uuid: `u${i}`,
          message: { content: [{ type: "tool_use", id, name: step.tool, input: step.input }] },
        };
        yield {
          type: "user",
          parent_tool_use_id: id,
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: id,
                content: step.result,
                ...(step.isError ? { is_error: true } : {}),
              },
            ],
          },
        };
      }
      yield {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "done",
        usage: { input_tokens: 1, output_tokens: 1 },
      };
    }
    return run();
  }) as unknown as typeof query;
}

/** Run one turn against the double and return the SDK options + drained events. */
async function runPlanTurn(steps: Step[]) {
  const captured: QueryArgs[] = [];
  const provider = new ClaudeAgentProvider({
   queryFn: planQuery(captured, steps),
  });
  const thread = await provider.startThread({ cwd: "/ws" } as StartThreadInput);
  const events: TurnStreamEvent[] = [];
  for await (const ev of provider.sendTurn(thread.id, { text: "q" } as TurnInput)) {
    events.push(ev);
  }
  return { options: captured[0].options ?? {}, events, provider, threadId: thread.id };
}

/** Every plan snapshot the turn emitted, in order. */
function snapshots(events: TurnStreamEvent[]): AgentPlanPart[][] {
  return events
    .filter((e): e is Extract<TurnStreamEvent, { type: "agent.plan.updated" }> =>
      e.type === "agent.plan.updated",
    )
    .map((e) => e.parts);
}

// ── observed fixtures (SDK 0.3.226, model claude-sonnet-5) ────────────────────

const CREATE_1: Step = {
  tool: "TaskCreate",
  input: { subject: "part 1: rainfall by day", description: "part 1", activeForm: "Reading rainfall" },
  result: "Task #1 created successfully: part 1: rainfall by day",
};
const CREATE_2: Step = {
  tool: "TaskCreate",
  input: { subject: "part 2: split by town", description: "part 2" },
  result: "Task #2 created successfully: part 2: split by town",
};

test("exactly the four native task tools and tool search are enabled", async () => {
  const { options } = await runPlanTurn([]);
  assert.deepEqual(options.tools, ["TaskCreate", "TaskUpdate", "TaskList", "TaskGet", "ToolSearch"]);
  // The rest of the isolation must not drift with it.
  assert.deepEqual(options.settingSources, []);
  // Auto-memory ignores settingSources and keys on the cwd's git root, so a dev
  // agent under the repo would read the developer's MEMORY.md without this.
  assert.deepEqual(options.settings, { autoMemoryEnabled: false });
  assert.deepEqual(options.skills, []);
  assert.equal(options.strictMcpConfig, true);
});

test("each TaskCreate grows the snapshot, and no plan tool makes a rail row", async () => {
  const { events, threadId } = await runPlanTurn([CREATE_1, CREATE_2]);
  assert.deepEqual(snapshots(events), [
    [{ text: "part 1: rainfall by day", status: "pending", active: "Reading rainfall" }],
    [
      { text: "part 1: rainfall by day", status: "pending", active: "Reading rainfall" },
      { text: "part 2: split by town", status: "pending" },
    ],
  ]);
  const plan = events.find((e) => e.type === "agent.plan.updated");
  assert.equal(plan?.threadId, threadId);
  assert.equal(plan?.provider, "claude");
  // Neither the calls nor their results may appear as tool rows.
  assert.equal(events.some((e) => e.type === "tool.started" || e.type === "tool.completed"), false);
});

test("loading a deferred tool through tool search draws no tool row", async () => {
  const { events } = await runPlanTurn([
    { tool: "ToolSearch", input: { query: "select:mcp__lab__search_notes" }, result: "loaded" },
  ]);
  assert.equal(events.some((e) => e.type === "tool.started" || e.type === "tool.completed"), false);
});

test("TaskUpdate mutates the matching part and leaves the rest of the snapshot", async () => {
  const { events } = await runPlanTurn([
    CREATE_1,
    CREATE_2,
    {
      tool: "TaskUpdate",
      input: { taskId: "1", status: "completed", subject: "part 1 (run 20260812_xyz): rainfall fell 8.4%" },
      result: "Updated task #1 status",
    },
    { tool: "TaskUpdate", input: { taskId: "2", status: "in_progress" }, result: "Updated task #2 status" },
  ]);
  assert.deepEqual(snapshots(events).at(-1), [
    { text: "part 1 (run 20260812_xyz): rainfall fell 8.4%", status: "completed", active: "Reading rainfall" },
    { text: "part 2: split by town", status: "in_progress" },
  ]);
});

test("status 'deleted' removes the part from the snapshot", async () => {
  const { events } = await runPlanTurn([
    CREATE_1,
    CREATE_2,
    { tool: "TaskUpdate", input: { taskId: "1", status: "deleted" }, result: "Updated task #1 deleted" },
  ]);
  assert.deepEqual(snapshots(events).at(-1), [{ text: "part 2: split by town", status: "pending" }]);
});

test("an update for an unknown id is ignored, and a failed update emits nothing", async () => {
  const { events } = await runPlanTurn([
    CREATE_1,
    // The CLI reports a bad id as ordinary (non-error) text.
    { tool: "TaskUpdate", input: { taskId: "99", status: "completed" }, result: "Task not found" },
    // A known id whose call failed must not move the plan either.
    { tool: "TaskUpdate", input: { taskId: "1", status: "completed" }, result: "Task not found" },
  ]);
  // Only the create emitted; neither doomed update produced a snapshot.
  assert.equal(snapshots(events).length, 1);
  assert.deepEqual(snapshots(events).at(-1), [
    { text: "part 1: rainfall by day", status: "pending", active: "Reading rainfall" },
  ]);
});

test("un-repaired key names still land (the stream shows the model's raw input)", async () => {
  // Claude Code repairs `id`/`task_id` → `taskId` and `active_form` → `activeForm`
  // before executing, but the repair never reaches the message stream.
  const { events } = await runPlanTurn([
    {
      tool: "TaskCreate",
      input: { subject: "part 1", description: "part 1", active_form: "Working part 1" },
      result: "Task #1 created successfully: part 1",
    },
    { tool: "TaskUpdate", input: { id: "1", status: "in_progress" }, result: "Updated task #1 status" },
    { tool: "TaskUpdate", input: { task_id: "1", status: "completed" }, result: "Updated task #1 status" },
  ]);
  assert.deepEqual(snapshots(events).at(-1), [
    { text: "part 1", status: "completed", active: "Working part 1" },
  ]);
});

test("a TaskList result resyncs the accumulator (provider-restart amnesia repair)", async () => {
  const { events } = await runPlanTurn([
    // The provider never saw these tasks created — a restart dropped the map
    // while the CLI session kept the tasks.
    {
      tool: "TaskList",
      input: {},
      result: "#1 [completed] part 1: rainfall by day\n#2 [in_progress] part 2: split by town",
    },
    // …and an update the accumulator could not have applied before now lands.
    { tool: "TaskUpdate", input: { taskId: "2", status: "completed" }, result: "Updated task #2 status" },
  ]);
  assert.deepEqual(snapshots(events), [
    [
      { text: "part 1: rainfall by day", status: "completed" },
      { text: "part 2: split by town", status: "in_progress" },
    ],
    [
      { text: "part 1: rainfall by day", status: "completed" },
      { text: "part 2: split by town", status: "completed" },
    ],
  ]);
});

test("a TaskList that changes nothing, and TaskGet, emit no snapshot", async () => {
  const { events } = await runPlanTurn([
    CREATE_1,
    { tool: "TaskList", input: {}, result: "#1 [pending] part 1: rainfall by day" },
    { tool: "TaskGet", input: { taskId: "1" }, result: "Task #1: part 1: rainfall by day\nStatus: pending" },
    // An unparseable listing is never trusted to mean "the plan is empty".
    { tool: "TaskList", input: {}, result: "No tasks yet." },
  ]);
  assert.equal(snapshots(events).length, 1);
});

test("an errored plan tool_result never moves the plan, whatever its prose says", async () => {
  const { events } = await runPlanTurn([
    // Failure prose that still leads with "Task #N …" — without the is_error
    // gate the create parser would mint a phantom pending item from it.
    {
      tool: "TaskCreate",
      input: { subject: "part 4" },
      result: "Task #4 could not be created: task limit reached",
      isError: true,
    },
    CREATE_1,
    {
      tool: "TaskUpdate",
      input: { taskId: "1", status: "completed" },
      result: "Updated task #1 status",
      isError: true,
    },
  ]);
  // Only the successful create emitted; the errored calls left the plan alone.
  assert.deepEqual(snapshots(events), [
    [{ text: "part 1: rainfall by day", status: "pending", active: "Reading rainfall" }],
  ]);
});

test("a fully settled plan is dropped at the next turn's start (no cross-turn bleed)", async () => {
  const captured: QueryArgs[] = [];
  let steps: Step[] = [
    CREATE_1,
    { tool: "TaskUpdate", input: { taskId: "1", status: "completed" }, result: "Updated task #1 status" },
  ];
  const provider = new ClaudeAgentProvider({
   queryFn: ((args: QueryArgs) => planQuery(captured, steps)(args)) as unknown as typeof query,
  });
  const thread = await provider.startThread({ cwd: "/ws" } as StartThreadInput);
  for await (const _ of provider.sendTurn(thread.id, { text: "q1" } as TurnInput));
  // Turn 2 starts its own plan: turn 1's finished agenda must not ride along —
  // the fold pins each whole snapshot to the CURRENT turn's card.
  steps = [CREATE_2];
  const events: TurnStreamEvent[] = [];
  for await (const ev of provider.sendTurn(thread.id, { text: "q2" } as TurnInput)) events.push(ev);
  assert.deepEqual(snapshots(events).at(-1), [{ text: "part 2: split by town", status: "pending" }]);
});

test("the plan accumulates ACROSS turns of the same thread", async () => {
  const captured: QueryArgs[] = [];
  let steps: Step[] = [CREATE_1];
  const provider = new ClaudeAgentProvider({
   queryFn: ((args: QueryArgs) => planQuery(captured, steps)(args)) as unknown as typeof query,
  });
  const thread = await provider.startThread({ cwd: "/ws" } as StartThreadInput);
  for await (const _ of provider.sendTurn(thread.id, { text: "q1" } as TurnInput));
  steps = [
    { tool: "TaskUpdate", input: { taskId: "1", status: "completed" }, result: "Updated task #1 status" },
  ];
  const events: TurnStreamEvent[] = [];
  for await (const ev of provider.sendTurn(thread.id, { text: "q2" } as TurnInput)) events.push(ev);
  assert.deepEqual(snapshots(events).at(-1), [
    { text: "part 1: rainfall by day", status: "completed", active: "Reading rainfall" },
  ]);
});

test("the task tools and tool search are allowed before the approval bridge; nothing else is", async () => {
  const { options, provider } = await runPlanTurn([]);
  const canUseTool = options.canUseTool;
  assert.ok(canUseTool);
  const opts = {
    toolUseID: "call1",
    signal: new AbortController().signal,
  } as Parameters<NonNullable<typeof canUseTool>>[2];

  for (const tool of ["TaskCreate", "TaskUpdate", "TaskList", "TaskGet", "ToolSearch"]) {
    const result = await canUseTool(tool, { taskId: "1" }, opts);
    // Allowed outright — no `approval.requested` round-trip to resolve, so a plan
    // call can never hit a host policy's decline.
    assert.equal(result?.behavior, "allow", tool);
  }

  // Any other built-in still parks on a real approval, which we decline here.
  const parked = canUseTool("Bash", { command: "ls" }, opts);
  // The turn that would carry its approval.requested event has ended, so read
  // the one parked id straight off the provider.
  const [parkedId] = (provider as unknown as { pending: Map<string, unknown> }).pending.keys();
  assert.ok(parkedId);
  await provider.resolveApproval(parkedId, { action: "decline" });
  assert.equal((await parked)?.behavior, "deny");
});

// ── pure parsers, against the observed payloads ──────────────────────────────

test("parsers read the observed confirmation prose", () => {
  assert.deepEqual(parseTaskCreateResult("Task #1 created successfully: Alpha"), {
    id: "1",
    subject: "Alpha",
  });
  assert.equal(parseTaskCreateResult("Task not found"), undefined);
  assert.equal(taskUpdateSucceeded("Updated task #1 status"), true);
  assert.equal(taskUpdateSucceeded("Updated task #3 deleted"), true);
  assert.equal(taskUpdateSucceeded("Task not found"), false);
  assert.deepEqual(parseTaskListResult("#1 [in_progress] Alpha\n#2 [pending] Beta renamed"), [
    { id: "1", text: "Alpha", status: "in_progress" },
    { id: "2", text: "Beta renamed", status: "pending" },
  ]);
});

test("parsers also accept the SDK's declared structured output", () => {
  assert.deepEqual(parseTaskCreateResult('{"task":{"id":7,"subject":"Alpha"}}'), {
    id: "7",
    subject: "Alpha",
  });
  assert.equal(taskUpdateSucceeded('{"success":false,"taskId":"1","error":"nope"}'), false);
  assert.deepEqual(parseTaskListResult('{"tasks":[{"id":1,"subject":"A","status":"weird"}]}'), [
    { id: "1", text: "A", status: "pending" },
  ]);
});

test("a CLI shape change degrades instead of crashing the turn", () => {
  assert.equal(parseTaskCreateResult(undefined), undefined);
  assert.deepEqual(parseTaskListResult(null), []);
  assert.deepEqual(readTaskInput(null), {});
  assert.deepEqual(readTaskInput({ taskId: "  ", id: "5" }), { taskId: "5" });
  // tool_result content also arrives as text blocks.
  assert.deepEqual(parseTaskCreateResult([{ type: "text", text: "Task #2 created successfully: B" }]), {
    id: "2",
    subject: "B",
  });
});
