/**
 * Claude-backend robustness (agent-parity wave 3a): a user Stop takes the CLI's
 * graceful `interrupt()` path and says so on the turn, API retries and model
 * refusals surface as non-fatal warnings (and become the turn's stated failure
 * when nothing else arrives), subscription usage comes from the SDK's structured
 * call with the `/usage` scrape behind it, and the plan accumulator is fed by the
 * CLI's `TaskCreated`/`TaskCompleted` hooks rather than confirmation prose.
 *
 * Driven through the `queryFn` seam: no CLI is spawned.
 */

import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { query } from "@anthropic-ai/claude-agent-sdk";
import type { TurnStreamEvent, AgentPlanPart, StartThreadInput, TurnInput } from "./types/index.ts";

import { ClaudeAgentProvider } from "./claude-provider.ts";
import { structuredClaudeUsage } from "./claude/usage.ts";

type QueryArgs = Parameters<typeof query>[0];
type ErrorRaised = Extract<TurnStreamEvent, { type: "error.raised" }>;

const initConnected = {
  type: "system",
  subtype: "init",
  mcp_servers: [{ name: "lab", status: "connected" }],
};
const resultOk = {
  type: "result",
  subtype: "success",
  is_error: false,
  result: "hi",
  usage: { input_tokens: 1, output_tokens: 1 },
};

function warnings(events: TurnStreamEvent[]): ErrorRaised[] {
  return events.filter((e): e is ErrorRaised => e.type === "error.raised");
}

function snapshots(events: TurnStreamEvent[]): AgentPlanPart[][] {
  return events
    .filter((e): e is Extract<TurnStreamEvent, { type: "agent.plan.updated" }> =>
      e.type === "agent.plan.updated",
    )
    .map((e) => e.parts);
}

// ── 1. Stop is graceful ───────────────────────────────────────────────────────

/** A turn that streams its init and then waits for the abort. `graceful` records
 *  whether the SDK's own `interrupt()` was the leg that stopped it. */
function stoppableQuery(
  graceful: { called: boolean },
  opts: { exposeInterrupt: boolean; abortedResult?: "aborted_streaming" | "aborted_tools" },
  reached: () => void = () => {},
): typeof query {
  return ((args: QueryArgs) => {
    const controller = args.options?.abortController;
    const it = (async function* () {
      yield initConnected;
      // Resumed only once the provider has consumed the init message.
      reached();
      await new Promise<void>((resolve) => {
        controller?.signal.addEventListener("abort", () => resolve());
      });
      // What the real CLI sends after `interrupt()`: an error result naming the
      // abort, with no `result` text.
      if (opts.abortedResult) {
        yield {
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          errors: [],
          terminal_reason: opts.abortedResult,
          usage: { input_tokens: 1, output_tokens: 0 },
        };
      }
    })() as AsyncGenerator<unknown> & { interrupt?: () => Promise<void> };
    if (opts.exposeInterrupt) {
      it.interrupt = async () => {
        graceful.called = true;
        // The real CLI unwinds its work and closes the stream; the SDK stream ends
        // on its own, which for this double means letting the abort land.
        controller?.abort();
      };
    }
    return it;
  }) as unknown as typeof query;
}

async function runStoppedTurn(
  exposeInterrupt: boolean,
  abortedResult?: "aborted_streaming" | "aborted_tools",
) {
  const graceful = { called: false };
  let reached!: () => void;
  const firstMessage = new Promise<void>((resolve) => (reached = resolve));
  const provider = new ClaudeAgentProvider({
    queryFn: stoppableQuery(graceful, { exposeInterrupt, abortedResult }, reached),
  });
  const thread = await provider.startThread({ cwd: "/ws" } as StartThreadInput);
  const events: TurnStreamEvent[] = [];
  const drain = (async () => {
    for await (const ev of provider.sendTurn(thread.id, { text: "q" } as TurnInput)) {
      events.push(ev);
    }
  })();
  // Let the turn reach its first message before stopping it.
  await firstMessage;
  await provider.interrupt(thread.id, "unused");
  await drain;
  return { events, graceful };
}

test("a user Stop asks the CLI to interrupt before anything is aborted", async () => {
  const { events, graceful } = await runStoppedTurn(true);
  assert.equal(graceful.called, true, "the graceful leg ran");
  const stop = warnings(events).at(-1);
  assert.ok(stop, "the stop is stated on the turn");
  assert.equal(stop.code, "interrupted");
  assert.equal(stop.fatal, false, "Codex reports a stopped turn as a warning, not a failure");
  assert.equal(events.at(-1)?.type, "turn.completed", "the turn still settles");
});

test("a Stop on an SDK without interrupt() still tears the turn down", async () => {
  const { events, graceful } = await runStoppedTurn(false);
  assert.equal(graceful.called, false);
  assert.equal(events.at(-1)?.type, "turn.completed");
  assert.equal(warnings(events).at(-1)?.code, "interrupted");
});

test("a stopped turn is never promoted to a failure", async () => {
  const { events } = await runStoppedTurn(true);
  assert.ok(
    !warnings(events).some((w) => w.fatal !== false),
    "the interrupt warning must not become this turn's stated failure",
  );
});

for (const reason of ["aborted_streaming", "aborted_tools"] as const) {
  test(`a Stop the CLI answers with an ${reason} result ends the turn cleanly`, async () => {
    const { events } = await runStoppedTurn(true, reason);
    assert.equal(events.at(-1)?.type, "turn.completed");
    assert.equal(events.filter((e) => e.type === "turn.completed").length, 1);
    assert.ok(
      !warnings(events).some((w) => w.fatal !== false),
      "an aborted result is the Stop landing, not a failure",
    );
  });
}

test("interrupt on a thread with no live turn is a no-op", async () => {
  const provider = new ClaudeAgentProvider({
    queryFn: stoppableQuery({ called: false }, { exposeInterrupt: true }),
  });
  const thread = await provider.startThread({ cwd: "/ws" } as StartThreadInput);
  await provider.interrupt(thread.id, "unused");
});

// ── 2. retries and refusals ───────────────────────────────────────────────────

/** A `query()` double that replays `msgs` and then ends the stream (no result
 *  message unless `msgs` carries one). */
function scriptQuery(msgs: Array<Record<string, unknown>>): typeof query {
  return (() => {
    async function* run() {
      for (const msg of msgs) yield msg;
    }
    return run();
  }) as unknown as typeof query;
}

async function runTurn(msgs: Array<Record<string, unknown>>) {
  const provider = new ClaudeAgentProvider({
    queryFn: scriptQuery(msgs),
  });
  const thread = await provider.startThread({ cwd: "/ws" } as StartThreadInput);
  const events: TurnStreamEvent[] = [];
  for await (const ev of provider.sendTurn(thread.id, { text: "q" } as TurnInput)) {
    events.push(ev);
  }
  return events;
}

const retry = (attempt: number) => ({
  type: "system",
  subtype: "api_retry",
  attempt,
  max_retries: 5,
  retry_delay_ms: 2000,
  error_status: 503,
  error: "overloaded",
  uuid: `r${attempt}`,
  session_id: "s1",
});

test("an api_retry frame is a non-fatal network warning", async () => {
  const events = await runTurn([
    initConnected,
    retry(1),
    { type: "assistant", uuid: "u1", message: { content: [{ type: "text", text: "hi" }] } },
    resultOk,
  ]);
  const warning = warnings(events)[0];
  assert.ok(warning);
  assert.equal(warning.code, "network");
  assert.equal(warning.fatal, false);
  assert.match(warning.message, /attempt 1\/5/);
  assert.equal(events.at(-1)?.type, "turn.completed", "a retried turn that answered still completes");
});

test("retries exhausted with nothing produced promotes the warning to the turn's failure", async () => {
  const events = await runTurn([initConnected, retry(4), retry(5), resultOk]);
  assert.equal(
    events.filter((e) => e.type === "turn.completed").length,
    0,
    "an empty turn isn't a success",
  );
  const raised = warnings(events);
  assert.equal(raised.length, 3, "the two warnings, then the promoted terminal failure");
  const terminal = raised.at(-1)!;
  assert.equal(terminal.fatal, true);
  assert.equal(terminal.code, "network");
  assert.match(terminal.message, /5\/5/, "the last attempt's wording is the informative one");
});

test("a retry storm that ends without a result message states the retry, not the generic sentence", async () => {
  const events = await runTurn([initConnected, retry(5)]);
  const terminal = warnings(events).at(-1)!;
  assert.equal(terminal.fatal, true);
  assert.equal(terminal.code, "network");
  assert.match(terminal.message, /attempt 5\/5/);
});

test("a plan-only turn that ran out of retries still fails (a plan is not an answer)", async () => {
  const events = await runTurn([
    initConnected,
    {
      type: "assistant",
      uuid: "u1",
      message: {
        content: [
          { type: "tool_use", id: "c1", name: "TaskCreate", input: { subject: "Read rainfall" } },
        ],
      },
    },
    {
      type: "user",
      message: {
        content: [
          { type: "tool_result", tool_use_id: "c1", content: "Task #1 created successfully: Read rainfall" },
        ],
      },
    },
    retry(5),
    resultOk,
  ]);
  assert.equal(warnings(events).at(-1)?.fatal, true);
});

test("a model refusal with a fallback warns and names the retracted content", async () => {
  const events = await runTurn([
    initConnected,
    {
      type: "system",
      subtype: "model_refusal_fallback",
      trigger: "refusal",
      direction: "retry",
      original_model: "claude-opus-4-8",
      fallback_model: "claude-sonnet-5",
      request_id: "req_1",
      api_refusal_category: "cyber",
      retracted_message_uuids: ["u1", "u2"],
      uuid: "f1",
      session_id: "s1",
    },
    { type: "assistant", uuid: "u3", message: { content: [{ type: "text", text: "here" }] } },
    resultOk,
  ]);
  const warning = warnings(events)[0];
  assert.ok(warning);
  assert.equal(warning.fatal, false);
  assert.match(warning.message, /claude-sonnet-5/);
  assert.match(warning.message, /withdrew 2 messages/);
  assert.equal(events.at(-1)?.type, "turn.completed");
});

test("a refusal with no fallback and no answer becomes the turn's stated failure", async () => {
  const events = await runTurn([
    initConnected,
    {
      type: "system",
      subtype: "model_refusal_no_fallback",
      original_model: "claude-opus-4-8",
      request_id: null,
      api_refusal_category: "bio",
      content: "refused",
      uuid: "f1",
      session_id: "s1",
    },
    resultOk,
  ]);
  const terminal = warnings(events).at(-1)!;
  assert.equal(terminal.fatal, true);
  assert.match(terminal.message, /no fallback model/);
});

// ── 3. structured usage ───────────────────────────────────────────────────────

const STRUCTURED = {
  session: {},
  subscription_type: "max",
  rate_limits_available: true,
  rate_limits: {
    five_hour: { utilization: 34.4, resets_at: "2026-06-17T12:49:00Z" },
    seven_day: { utilization: 10, resets_at: "2026-06-23T01:29:00Z" },
    seven_day_sonnet: { utilization: 0, resets_at: null },
    model_scoped: [
      { display_name: "Fable", utilization: 13, resets_at: null },
      { display_name: "Haiku", utilization: 2, resets_at: null },
    ],
  },
};

/** A `query()` double for the idle control session: iterable, plus whatever
 *  control methods the test wants to expose. */
function controlQuery(methods: Record<string, unknown>): typeof query {
  return (() => {
    const it = (async function* () {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    })() as AsyncGenerator<unknown> & Record<string, unknown>;
    for (const [name, fn] of Object.entries(methods)) it[name] = fn;
    return it;
  }) as unknown as typeof query;
}

test("getUsage reads the SDK's structured usage response", async () => {
  const provider = new ClaudeAgentProvider({
    queryFn: controlQuery({
      usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => STRUCTURED,
    }),
  });
  const usage = await provider.getUsage();
  assert.ok(usage);
  assert.equal(usage.plan, "Max");
  assert.equal(usage.scope, "account");
  assert.deepEqual(
    usage.windows.map((w) => [w.label, w.usedPercent, w.resetsAt]),
    [
      ["Session", 34, "2026-06-17T12:49:00Z"],
      ["Week", 10, "2026-06-23T01:29:00Z"],
      ["Week · Sonnet", 0, null],
      ["Week · Haiku", 2, null],
    ],
  );
  assert.deepEqual(usage.windows.map((w) => w.windowMins), [300, 10080, 10080, 10080]);
});

test("structuredClaudeUsage returns null when plan limits do not apply", () => {
  assert.equal(structuredClaudeUsage(null, "claude-code"), null);
  assert.equal(
    structuredClaudeUsage({ rate_limits_available: false, rate_limits: null }, "claude-code"),
    null,
  );
  assert.equal(
    structuredClaudeUsage({ rate_limits_available: true, rate_limits: {} }, "claude-code"),
    null,
  );
});

/** One stand-in `claude` binary for the file, written once: it answers `-p /usage`
 *  with whatever envelope sits in the data file beside it. A new executable per
 *  test costs a cold first exec each time. */
const FAKE_CLAUDE_DIR = mkdtempSync(join(tmpdir(), "muxi-agent-claude-usage-"));
const FAKE_CLAUDE = join(FAKE_CLAUDE_DIR, "claude");
writeFileSync(FAKE_CLAUDE, `#!/bin/sh\ncat "$(dirname "$0")/usage.json"\n`);
chmodSync(FAKE_CLAUDE, 0o755);

/** Point the stand-in binary at `usageText` and return its path. */
function fakeClaudeBin(usageText: string): string {
  writeFileSync(join(FAKE_CLAUDE_DIR, "usage.json"), JSON.stringify({ result: usageText }));
  return FAKE_CLAUDE;
}

test("getUsage falls back to the /usage scrape when the experimental call is absent", async () => {
  const provider = new ClaudeAgentProvider({
    // No experimental method on the query: an older CLI.
    queryFn: controlQuery({}),
    pathToClaudeCodeExecutable: fakeClaudeBin("Current session: 12% used"),
  });
  const usage = await provider.getUsage();
  assert.ok(usage);
  assert.equal(usage.scope, "machine", "the scrape's numbers are this machine's");
  assert.deepEqual(usage.windows.map((w) => [w.label, w.usedPercent]), [["Session", 12]]);
});

test("getUsage falls back when the experimental call throws", async () => {
  const provider = new ClaudeAgentProvider({
    queryFn: controlQuery({
      usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => {
        throw new Error("unknown control request");
      },
    }),
    pathToClaudeCodeExecutable: fakeClaudeBin("Current week (all models): 40% used"),
  });
  const usage = await provider.getUsage();
  assert.ok(usage);
  assert.deepEqual(usage.windows.map((w) => [w.label, w.usedPercent]), [["Week", 40]]);
});

// ── 4. plan from hooks ────────────────────────────────────────────────────────

interface HookCall {
  event: "TaskCreated" | "TaskCompleted";
  task_id: string;
  task_subject: string;
}

/** A `query()` double that fires the registered task hooks (as the CLI does),
 *  optionally followed by the tool_use/tool_result pair for the same task. */
function hookQuery(
  calls: HookCall[],
  tail: Array<Record<string, unknown>> = [],
): typeof query {
  return ((args: QueryArgs) => {
    async function* run() {
      yield initConnected;
      const hooks = args.options?.hooks;
      for (const call of calls) {
        const matchers = hooks?.[call.event] ?? [];
        for (const matcher of matchers) {
          for (const hook of matcher.hooks) {
            await hook(
              {
                hook_event_name: call.event,
                task_id: call.task_id,
                task_subject: call.task_subject,
                session_id: "s1",
                transcript_path: "/t",
                cwd: "/ws",
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
              } as any,
              undefined,
              { signal: new AbortController().signal },
            );
          }
        }
      }
      for (const msg of tail) yield msg;
      yield resultOk;
    }
    return run();
  }) as unknown as typeof query;
}

async function runHookTurn(calls: HookCall[], tail: Array<Record<string, unknown>> = []) {
  const provider = new ClaudeAgentProvider({
    queryFn: hookQuery(calls, tail),
  });
  const thread = await provider.startThread({ cwd: "/ws" } as StartThreadInput);
  const events: TurnStreamEvent[] = [];
  for await (const ev of provider.sendTurn(thread.id, { text: "q" } as TurnInput)) {
    events.push(ev);
  }
  return events;
}

test("a TaskCreated hook adds the task to the plan and mirrors the whole snapshot", async () => {
  const events = await runHookTurn([
    { event: "TaskCreated", task_id: "1", task_subject: "Read rainfall by day" },
    { event: "TaskCreated", task_id: "2", task_subject: "Split by app" },
  ]);
  assert.deepEqual(snapshots(events), [
    [{ text: "Read rainfall by day", status: "pending" }],
    [
      { text: "Read rainfall by day", status: "pending" },
      { text: "Split by app", status: "pending" },
    ],
  ]);
});

test("a TaskCompleted hook completes exactly that task", async () => {
  const events = await runHookTurn([
    { event: "TaskCreated", task_id: "1", task_subject: "Read rainfall by day" },
    { event: "TaskCreated", task_id: "2", task_subject: "Split by app" },
    { event: "TaskCompleted", task_id: "1", task_subject: "Read rainfall by day" },
  ]);
  assert.deepEqual(snapshots(events).at(-1), [
    { text: "Read rainfall by day", status: "completed" },
    { text: "Split by app", status: "pending" },
  ]);
});

test("a hook and the tool result for one task stay one plan row, and the result adds activeForm", async () => {
  const events = await runHookTurn(
    [{ event: "TaskCreated", task_id: "1", task_subject: "Read rainfall by day" }],
    [
      {
        type: "assistant",
        uuid: "u1",
        message: {
          content: [
            {
              type: "tool_use",
              id: "c1",
              name: "TaskCreate",
              input: { subject: "Read rainfall by day", activeForm: "Reading rainfall" },
            },
          ],
        },
      },
      {
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "c1",
              content: "Task #1 created successfully: Read rainfall by day",
            },
          ],
        },
      },
    ],
  );
  assert.deepEqual(snapshots(events).at(-1), [
    { text: "Read rainfall by day", status: "pending", active: "Reading rainfall" },
  ]);
});

test("the in-progress transition still comes from the tool result (no hook reports it)", async () => {
  const events = await runHookTurn(
    [{ event: "TaskCreated", task_id: "1", task_subject: "Read rainfall by day" }],
    [
      {
        type: "assistant",
        uuid: "u1",
        message: {
          content: [
            {
              type: "tool_use",
              id: "c1",
              name: "TaskUpdate",
              input: { taskId: "1", status: "in_progress" },
            },
          ],
        },
      },
      {
        type: "user",
        message: {
          content: [
            { type: "tool_result", tool_use_id: "c1", content: "Updated task #1 status" },
          ],
        },
      },
    ],
  );
  assert.deepEqual(snapshots(events).at(-1), [
    { text: "Read rainfall by day", status: "in_progress" },
  ]);
});

test("a TaskCreated hook does not pull an in-progress task back to pending", async () => {
  const events = await runHookTurn(
    [{ event: "TaskCreated", task_id: "1", task_subject: "Read rainfall by day" }],
    [
      {
        type: "assistant",
        uuid: "u1",
        message: {
          content: [
            {
              type: "tool_use",
              id: "c1",
              name: "TaskUpdate",
              input: { taskId: "1", status: "in_progress" },
            },
          ],
        },
      },
      {
        type: "user",
        message: {
          content: [
            { type: "tool_result", tool_use_id: "c1", content: "Updated task #1 status" },
          ],
        },
      },
      {
        type: "assistant",
        uuid: "u2",
        message: {
          content: [
            { type: "tool_use", id: "c2", name: "TaskCreate", input: { subject: "Read rainfall by day" } },
          ],
        },
      },
      {
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "c2",
              content: "Task #1 created successfully: Read rainfall by day",
            },
          ],
        },
      },
    ],
  );
  assert.deepEqual(snapshots(events).at(-1), [
    { text: "Read rainfall by day", status: "in_progress" },
  ]);
});

test("chat turns register the task hooks", async () => {
  const captured: QueryArgs[] = [];
  const provider = new ClaudeAgentProvider({
    queryFn: ((args: QueryArgs) => {
      captured.push(args);
      return (async function* () {
        yield resultOk;
      })();
    }) as unknown as typeof query,
  });
  const thread = await provider.startThread({ cwd: "/ws" } as StartThreadInput);
  for await (const _ of provider.sendTurn(thread.id, { text: "q" } as TurnInput)) void _;
  const hooks = captured[0].options?.hooks ?? {};
  assert.deepEqual(Object.keys(hooks).sort(), ["TaskCompleted", "TaskCreated"]);
});
