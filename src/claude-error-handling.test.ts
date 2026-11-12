/**
 * Error handling on the Claude backend: a failed first turn must stay retryable
 * (the SDK session it never created must not be resumed), `error.raised` must
 * carry thread/turn + a canonical code and say whether it's terminal, a stream
 * that ends without a result must not read as success, a consumer that walks away
 * must not leave the CLI turn running, and the login probe must not report a
 * failed probe as "signed out". Driven through the `queryFn` seam — no CLI runs.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { query } from "@anthropic-ai/claude-agent-sdk";
import type { TurnStreamEvent, StartThreadInput, TurnInput } from "./types/index.ts";

import { ClaudeAgentProvider } from "./claude-provider.ts";
import { claudeLoginVerdict } from "./claude/auth.ts";
import { claudeResultOutcome, classifyClaudeFailure } from "./claude/failures.ts";
import type { ClaudeResultOutcome } from "./claude/failures.ts";

type QueryArgs = Parameters<typeof query>[0];
type ErrorRaised = Extract<TurnStreamEvent, { type: "error.raised" }>;

/** A `query()` double whose stream is scripted per call, capturing the args. */
function scriptedQuery(
  captured: QueryArgs[],
  script: (call: number, args: QueryArgs) => AsyncGenerator<unknown>,
): typeof query {
  return ((args: QueryArgs) => {
    const call = captured.push(args) - 1;
    return script(call, args);
  }) as unknown as typeof query;
}

const initConnected = {
  type: "system",
  subtype: "init",
  mcp_servers: [{ name: "lab", status: "connected" }],
};
const assistantText = {
  type: "assistant",
  uuid: "u1",
  message: { content: [{ type: "text", text: "hi" }] },
};
const resultOk = {
  type: "result",
  subtype: "success",
  is_error: false,
  result: "hi",
  usage: { input_tokens: 1, output_tokens: 1 },
};

async function* okTurn(): AsyncGenerator<unknown> {
  yield initConnected;
  yield assistantText;
  yield resultOk;
}

/** The CLI never starts (missing binary / broken install). */
async function* spawnFailure(): AsyncGenerator<unknown> {
  await Promise.resolve();
  throw new Error("spawn claude ENOENT");
}

/** A turn that streams its init and then hangs until the provider aborts it. */
function hangingTurn(args: QueryArgs): AsyncGenerator<unknown> {
  return (async function* () {
    yield initConnected;
    await new Promise<void>((resolve) => {
      args.options?.abortController?.signal.addEventListener("abort", () => resolve());
    });
  })();
}

function providerWith(
  script: (call: number, args: QueryArgs) => AsyncGenerator<unknown>,
): { provider: ClaudeAgentProvider; captured: QueryArgs[] } {
  const captured: QueryArgs[] = [];
  const provider = new ClaudeAgentProvider({
    queryFn: scriptedQuery(captured, script),
  });
  return { provider, captured };
}

/** Consume a turn stream to the end, keeping the events and any failure. */
async function drain(
  stream: AsyncIterable<TurnStreamEvent>,
): Promise<{ events: TurnStreamEvent[]; error: Error | null }> {
  const events: TurnStreamEvent[] = [];
  try {
    for await (const ev of stream) events.push(ev);
    return { events, error: null };
  } catch (err) {
    return { events, error: err instanceof Error ? err : new Error(String(err)) };
  }
}

const errorsOf = (events: TurnStreamEvent[]): ErrorRaised[] =>
  events.filter((e): e is ErrorRaised => e.type === "error.raised");

// ── C2: a failed first turn must not brick the thread ────────────────────────

test("a first turn that dies at spawn leaves the thread fresh for the retry", async () => {
  const { provider, captured } = providerWith((call) => (call === 0 ? spawnFailure() : okTurn()));
  const thread = await provider.startThread({ cwd: "/ws" } as StartThreadInput);

  const first = await drain(provider.sendTurn(thread.id, { text: "q" } as TurnInput));
  assert.match(String(first.error?.message), /ENOENT/);
  assert.equal(captured[0].options?.sessionId, thread.id);
  assert.equal(captured[0].options?.resume, undefined);

  // The SDK session was never created, so the retry must create it — resuming a
  // session that doesn't exist fails forever.
  const retry = await drain(provider.sendTurn(thread.id, { text: "q" } as TurnInput));
  assert.equal(retry.error, null);
  assert.equal(captured[1].options?.sessionId, thread.id);
  assert.equal(captured[1].options?.resume, undefined);

  // Once a turn has actually streamed, later turns resume that session.
  await drain(provider.sendTurn(thread.id, { text: "q2" } as TurnInput));
  assert.equal(captured[2].options?.resume, thread.id);
  assert.equal(captured[2].options?.sessionId, undefined);
});

// ── C3: error.raised carries thread/turn, a code, and its severity ───────────

test("an unavailable MCP server raises a non-fatal warning and the turn still completes", async () => {
  const { provider } = providerWith(() =>
    (async function* () {
      yield { type: "system", subtype: "init", mcp_servers: [{ name: "lab", status: "failed" }] };
      yield assistantText;
      yield resultOk;
    })(),
  );
  const thread = await provider.startThread({ cwd: "/ws", mcpServers: { lab: { type: "http", url: "http://127.0.0.1:1/mcp" } } } as StartThreadInput);
  const { events, error } = await drain(provider.sendTurn(thread.id, { text: "q" } as TurnInput));

  assert.equal(error, null);
  const [raised] = errorsOf(events);
  assert.ok(raised, "the degraded server must be reported");
  assert.equal(raised.code, "mcp_unavailable");
  assert.equal(raised.fatal, false, "a degraded turn keeps running — this is a warning");
  assert.equal(raised.threadId, thread.id);
  assert.equal(typeof raised.turnId, "string");
  assert.ok(events.some((e) => e.type === "turn.completed"));
});

// The real error shape: sentences in `errors[]`, no `result` field.
const failedResult = {
  type: "result",
  subtype: "error_during_execution",
  is_error: true,
  errors: ["[ede_diagnostic] result_type=user", "Invalid API key · Please run /login"],
  usage: { input_tokens: 1, output_tokens: 0 },
};

test("a failed result raises ONE fatal error and no completion", async () => {
  const { provider } = providerWith(() =>
    (async function* () {
      yield initConnected;
      yield failedResult;
    })(),
  );
  const thread = await provider.startThread({ cwd: "/ws" } as StartThreadInput);
  const { events } = await drain(provider.sendTurn(thread.id, { text: "q" } as TurnInput));

  const [raised, ...extra] = errorsOf(events);
  assert.ok(raised);
  assert.equal(extra.length, 0, "one failure is one error event");
  assert.equal(raised.fatal, true);
  assert.equal(raised.code, "not_logged_in");
  assert.match(raised.message, /Invalid API key/);
  assert.equal(raised.threadId, thread.id);
  // The fatal error IS the terminal event; a `turn.completed` behind it would
  // settle the turn twice and open a stray transcript bubble.
  assert.equal(
    events.some((e) => e.type === "turn.completed"),
    false,
  );
});

test("the SDK re-throwing a failed result's own sentence does not duplicate the error", async () => {
  // What the real SDK does when the CLI is signed out: yield the `result` with
  // `is_error`, then reject the iterator with that same sentence ("Claude Code
  // returned an error result: …"). Rethrowing it makes the orchestrator persist a
  // SECOND error.raised, which the client folds into a promptless second turn.
  const { provider } = providerWith(() =>
    (async function* () {
      yield initConnected;
      yield failedResult;
      throw new Error("Claude Code returned an error result: Invalid API key · Please run /login");
    })(),
  );
  const thread = await provider.startThread({ cwd: "/ws" } as StartThreadInput);
  const { events, error } = await drain(provider.sendTurn(thread.id, { text: "q" } as TurnInput));

  assert.equal(error, null, "the failure was already reported as an event — don't throw it too");
  assert.equal(errorsOf(events).length, 1);
});

test("a stream error BEFORE any terminal event still surfaces as a throw", async () => {
  const { provider } = providerWith(() =>
    (async function* () {
      yield initConnected;
      throw new Error("Claude Code process exited with code 1");
    })(),
  );
  const thread = await provider.startThread({ cwd: "/ws" } as StartThreadInput);
  const { events, error } = await drain(provider.sendTurn(thread.id, { text: "q" } as TurnInput));

  assert.match(String(error?.message), /exited with code 1/);
  assert.equal(errorsOf(events).length, 0, "the orchestrator writes this one");
});

test("claudeResultOutcome reads each result shape", () => {
  const cases: Array<[string, Parameters<typeof claudeResultOutcome>[0], ClaudeResultOutcome]> = [
    ["clean success", { subtype: "success", is_error: false, result: "ok" }, { kind: "completed" }],
    [
      "Stop mid-stream",
      { subtype: "error_during_execution", is_error: true, errors: [], terminal_reason: "aborted_streaming" },
      { kind: "interrupted" },
    ],
    [
      "Stop mid-tool",
      { subtype: "error_during_execution", is_error: true, errors: [], terminal_reason: "aborted_tools" },
      { kind: "interrupted" },
    ],
    [
      "error result states itself in errors[], skipping diagnostics",
      {
        subtype: "error_during_execution",
        is_error: true,
        errors: ["[ede_diagnostic] x", "Connection error: ECONNRESET"],
      },
      { kind: "failed", code: "network", message: "Connection error: ECONNRESET" },
    ],
    [
      "API error on a success states itself in result",
      { subtype: "success", is_error: true, result: "Invalid API key · Please run /login" },
      { kind: "failed", code: "not_logged_in", message: "Invalid API key · Please run /login" },
    ],
    [
      "nothing stated falls back to the subtype",
      { subtype: "error_max_turns", is_error: true, errors: [] },
      { kind: "failed", code: "turn_failed", message: "Claude turn ended: error_max_turns" },
    ],
  ];
  for (const [name, msg, want] of cases) assert.deepEqual(claudeResultOutcome(msg), want, name);
});

test("classifyClaudeFailure maps auth and network prose, else stays generic", () => {
  assert.equal(classifyClaudeFailure("OAuth token has expired"), "not_logged_in");
  assert.equal(classifyClaudeFailure("Request failed: fetch failed"), "network");
  assert.equal(classifyClaudeFailure("The model declined to answer"), "turn_failed");
});

// ── the stream ended with no result ──────────────────────────────────────────

test("a stream that ends without a result raises a fatal error, not a clean turn", async () => {
  const { provider } = providerWith(() =>
    (async function* () {
      yield initConnected;
      yield assistantText;
    })(),
  );
  const thread = await provider.startThread({ cwd: "/ws" } as StartThreadInput);
  const { events, error } = await drain(provider.sendTurn(thread.id, { text: "q" } as TurnInput));

  assert.equal(error, null);
  const [raised] = errorsOf(events);
  assert.ok(raised, "an answerless turn must not settle silently");
  assert.equal(raised.fatal, true);
  assert.equal(raised.code, "unknown");
  assert.equal(
    events.some((e) => e.type === "turn.completed"),
    false,
  );
});

// ── M7: consumer exit must not leak a running CLI turn ───────────────────────

test("exiting the turn stream early aborts the CLI turn", async () => {
  const { provider, captured } = providerWith((_call, args) => hangingTurn(args));
  const thread = await provider.startThread({ cwd: "/ws" } as StartThreadInput);
  for await (const ev of provider.sendTurn(thread.id, { text: "q" } as TurnInput)) {
    if (ev.type === "turn.started") break; // the consumer gives up mid-turn
  }
  assert.equal(captured[0].options?.abortController?.signal.aborted, true);
});

// A turn abandoned at the timeout must also be STOPPED: the CLI's own
// `interrupt()` is what halts in-flight tool work, and the abort alone only
// tears down our end of the stream.
test("a timed-out turn interrupts the CLI, and still fails with the timeout", { timeout: 5_000 }, async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const captured: QueryArgs[] = [];
  let interrupts = 0;
  const provider = new ClaudeAgentProvider({
    turnTimeoutMs: 100,
    queryFn: ((args: QueryArgs) => {
      captured.push(args);
      const gen = hangingTurn(args) as AsyncGenerator<unknown> & {
        interrupt?: () => Promise<void>;
      };
      gen.interrupt = async () => {
        interrupts++;
      };
      return gen;
    }) as unknown as typeof import("@anthropic-ai/claude-agent-sdk").query,
  });
  const thread = await provider.startThread({ cwd: "/ws" } as StartThreadInput);
  const drained = drain(provider.sendTurn(thread.id, { text: "q" } as TurnInput));
  // The turn timer is armed in the same synchronous step as the query() call.
  while (captured.length === 0) await new Promise((r) => setImmediate(r));
  t.mock.timers.tick(100);
  const { error } = await drained;
  assert.match(String(error?.message), /Turn timed out after 100ms/);
  // The interrupt poll below waits on real time.
  t.mock.timers.reset();
  for (let i = 0; i < 50 && interrupts === 0; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(interrupts, 1, "the CLI was asked to stop the turn");
  assert.equal(captured[0].options?.abortController?.signal.aborted, true, "and then torn down");
});

// ── M4: a failed login probe is not a logged-out verdict ─────────────────────

test("claudeLoginVerdict trusts the CLI's own envelope either way", () => {
  assert.deepEqual(
    claudeLoginVerdict('{"loggedIn":true,"authMethod":"oauth","apiProvider":"firstParty"}'),
    { loggedIn: true },
  );
  // `claude auth status` exits 1 while signed out, but the JSON is the verdict.
  assert.deepEqual(
    claudeLoginVerdict(
      '{"loggedIn":false,"authMethod":"none","apiProvider":"firstParty"}',
      new Error("Command failed with exit code 1"),
    ),
    { loggedIn: false },
  );
});

test("claudeLoginVerdict reports a broken probe as unknown, never as signed out", () => {
  const timedOut = claudeLoginVerdict("", new Error("Command failed: timeout"));
  assert.equal(timedOut.loggedIn, null, "a timeout says nothing about the login");
  assert.match(String(timedOut.detail), /Could not verify/);

  // An older CLI with no `auth` subcommand prints usage text, not the envelope.
  const noSubcommand = claudeLoginVerdict(
    "Usage: claude [options] [command]",
    new Error("unknown command 'auth'"),
  );
  assert.equal(noSubcommand.loggedIn, null);
  assert.ok(noSubcommand.detail);

  // An unmistakable auth failure in the error text still settles it.
  assert.equal(
    claudeLoginVerdict("", new Error("Invalid API key · Please run /login")).loggedIn,
    false,
  );
});
