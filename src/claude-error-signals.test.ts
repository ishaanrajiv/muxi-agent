/**
 * Claude error signals: which code a failed turn gets when the CLI reports
 * something more specific than prose, and what a rejected rate limit does to a
 * turn. Driven through the `queryFn` seam, so no CLI runs.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { query } from "@anthropic-ai/claude-agent-sdk";
import type { TurnStreamEvent, StartThreadInput, TurnInput } from "./types/index.ts";

import { ClaudeAgentProvider } from "./claude-provider.ts";
import { claudeResultOutcome, isRateLimitBlocked } from "./claude/failures.ts";

type QueryArgs = Parameters<typeof query>[0];
type ErrorRaised = Extract<TurnStreamEvent, { type: "error.raised" }>;

const errorResult = (extra: Record<string, unknown> = {}) => ({
  subtype: "error_during_execution",
  is_error: true,
  errors: ["Something went wrong"],
  ...extra,
});

test("claudeResultOutcome prefers the most specific signal over the prose", () => {
  const cases: Array<[string, Parameters<typeof claudeResultOutcome>, string]> = [
    ["a startup auth failure", [errorResult({ startup_failure_reason: "org_verify_failed" })], "not_logged_in"],
    ["a CLI too old to start", [errorResult({ startup_failure_reason: "cli_version_too_old" })], "cli_outdated"],
    ["an unknown startup failure", [errorResult({ startup_failure_reason: "cwd_unavailable" })], "turn_failed"],
    ["the blocking limit", [errorResult({ terminal_reason: "blocking_limit" })], "usage_limit"],
    ["a prompt that no longer fits", [errorResult({ terminal_reason: "prompt_too_long" })], "context_full"],
    ["the refill breaker", [errorResult({ terminal_reason: "rapid_refill_breaker" })], "context_full"],
    [
      "the assistant's error when the terminal reason is generic",
      [errorResult({ terminal_reason: "api_error" }), { assistantError: "overloaded" }],
      "overloaded",
    ],
    ["an auth error on the assistant", [errorResult(), { assistantError: "authentication_failed" }], "not_logged_in"],
    ["a rate-limit error on the assistant", [errorResult(), { assistantError: "rate_limit" }], "usage_limit"],
    [
      "the startup reason outranks the assistant's error",
      [errorResult({ startup_failure_reason: "org_verify_failed" }), { assistantError: "overloaded" }],
      "not_logged_in",
    ],
    [
      "an API status on an errored success",
      [{ subtype: "success", is_error: true, result: "API Error", api_error_status: 529 }],
      "overloaded",
    ],
    ["a 429", [{ subtype: "success", is_error: true, result: "API Error", api_error_status: 429 }], "usage_limit"],
    ["a 502", [{ subtype: "success", is_error: true, result: "API Error", api_error_status: 502 }], "network"],
    ["prose alone falls back to the regexes", [errorResult({ errors: ["OAuth token has expired"] })], "not_logged_in"],
    ["usage-limit prose", [errorResult({ errors: ["Claude AI usage limit reached"] })], "usage_limit"],
    [
      "a blocking rate limit earlier in the turn",
      [errorResult(), { usageLimitMessage: "Claude Code hit its usage limit." }],
      "usage_limit",
    ],
    ["an unplaceable failure stays generic", [errorResult({ terminal_reason: "max_turns" })], "turn_failed"],
  ];
  for (const [name, args, code] of cases) {
    const outcome = claudeResultOutcome(...args);
    assert.equal(outcome.kind, "failed", name);
    if (outcome.kind === "failed") assert.equal(outcome.code, code, name);
  }
});

test("a usage-limit failure takes the rate-limit sentence; other failures keep their own", () => {
  const evidence = { usageLimitMessage: "Claude Code hit its 5-hour usage limit. It resets at 3:40 PM." };
  const limited = claudeResultOutcome(errorResult({ terminal_reason: "blocking_limit" }), evidence);
  assert.deepEqual(limited, { kind: "failed", code: "usage_limit", message: evidence.usageLimitMessage });
  const other = claudeResultOutcome(errorResult({ errors: ["fetch failed"] }), evidence);
  assert.deepEqual(other, { kind: "failed", code: "network", message: "fetch failed" });
});

test("isRateLimitBlocked keys on status, with extra usage able to cover it", () => {
  // The shape a normal turn carries: allowed, with overage off for the org.
  assert.equal(
    isRateLimitBlocked({ status: "allowed", overageStatus: "rejected", isUsingOverage: false }),
    false,
  );
  assert.equal(isRateLimitBlocked({ status: "allowed_warning" }), false);
  assert.equal(isRateLimitBlocked({ status: "rejected", rateLimitType: "five_hour" }), true);
  assert.equal(isRateLimitBlocked({ status: "rejected", overageStatus: "rejected" }), true);
  assert.equal(isRateLimitBlocked({ status: "rejected", overageStatus: "allowed" }), false);
  assert.equal(isRateLimitBlocked({ status: "rejected", isUsingOverage: true }), false);
});

// ── through the provider ─────────────────────────────────────────────────────

const initConnected = {
  type: "system",
  subtype: "init",
  mcp_servers: [{ name: "lab", status: "connected" }],
};
/** Tomorrow-ish, so the sentence carries a date either way; tests match loosely. */
const RESETS_AT = Math.floor(Date.now() / 1000) + 3 * 3600;
const rejected = {
  type: "rate_limit_event",
  rate_limit_info: { status: "rejected", rateLimitType: "five_hour", resetsAt: RESETS_AT },
};

function providerWith(script: (args: QueryArgs) => AsyncGenerator<unknown>, rateLimitParkMs = 40) {
  const interrupted = { called: false };
  const provider = new ClaudeAgentProvider({
    rateLimitParkMs,
    queryFn: ((args: QueryArgs) => {
      const it = script(args) as AsyncGenerator<unknown> & { interrupt?: () => Promise<void> };
      it.interrupt = async () => {
        interrupted.called = true;
        args.options?.abortController?.abort();
      };
      return it;
    }) as unknown as typeof query,
  });
  return { provider, interrupted };
}

async function runTurn(provider: ClaudeAgentProvider): Promise<TurnStreamEvent[]> {
  const thread = await provider.startThread({ cwd: "/ws" } as StartThreadInput);
  const events: TurnStreamEvent[] = [];
  for await (const ev of provider.sendTurn(thread.id, { text: "q" } as TurnInput)) events.push(ev);
  return events;
}

const errorsOf = (events: TurnStreamEvent[]) => events.filter((e): e is ErrorRaised => e.type === "error.raised");

/** Yields `frames`, then waits for the provider to abort. `onHang` fires once the
 *  provider has consumed the last frame, right before the wait. */
function thenHang(frames: unknown[], onHang?: () => void) {
  return (args: QueryArgs) =>
    (async function* () {
      for (const f of frames) yield f;
      onHang?.();
      await new Promise<void>((resolve) =>
        args.options?.abortController?.signal.addEventListener("abort", () => resolve()),
      );
    })();
}

test("a rejected rate limit the CLI goes quiet on ends the turn after the park", { timeout: 5_000 }, async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let hung!: () => void;
  const hanging = new Promise<void>((resolve) => (hung = resolve));
  const { provider, interrupted } = providerWith(thenHang([initConnected, rejected, rejected], hung));
  const turn = runTurn(provider);
  await hanging;
  t.mock.timers.tick(40);
  const events = await turn;
  const errors = errorsOf(events);
  assert.deepEqual(
    errors.map((e) => [e.code, e.fatal]),
    [
      ["usage_limit", false],
      ["usage_limit", true],
    ],
    "one warning for the window despite two events, then the stop",
  );
  assert.match(errors[1]!.message, /^Claude Code hit its 5-hour usage limit\. It resets (at|on) /);
  assert.equal(events.at(-1), errors[1], "the stop is the terminal; the aborted end adds nothing");
  assert.equal(interrupted.called, true, "the CLI is stopped, not left waiting");
  t.mock.timers.reset();
});

test("a rejected rate limit followed by the CLI's own error result ends once, with the named window", { timeout: 5_000 }, async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { provider, interrupted } = providerWith(async function* () {
    yield initConnected;
    yield rejected;
    yield { type: "result", ...errorResult({ errors: ["You're out of extra usage"] }) };
  });
  const events = await runTurn(provider);
  // Outlast the park: it must have been cleared by the result.
  t.mock.timers.tick(80);
  await new Promise((r) => setImmediate(r));
  const errors = errorsOf(events);
  assert.deepEqual(
    errors.map((e) => [e.code, e.fatal]),
    [
      ["usage_limit", false],
      ["usage_limit", true],
    ],
  );
  assert.match(errors[1]!.message, /5-hour usage limit/);
  assert.equal(interrupted.called, false);
  t.mock.timers.reset();
});

test("a later message clears the park, so a turn that carries on is not cut off", { timeout: 5_000 }, async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let reached!: () => void;
  const atGate = new Promise<void>((resolve) => (reached = resolve));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const { provider } = providerWith(async function* () {
    yield initConnected;
    yield rejected;
    yield { type: "assistant", uuid: "a1", parent_tool_use_id: null, message: { content: [{ type: "text", text: "hi" }] } };
    // Resumed only once the provider has consumed the assistant message.
    reached();
    await gate;
    yield { type: "result", subtype: "success", is_error: false, result: "hi" };
  });
  const turn = runTurn(provider);
  await atGate;
  // Past the park: it fires here unless the assistant message cleared it.
  t.mock.timers.tick(80);
  release();
  const events = await turn;
  assert.equal(events.at(-1)?.type, "turn.completed");
  assert.deepEqual(errorsOf(events).map((e) => e.fatal), [false]);
  t.mock.timers.reset();
});

test("the assistant message's error names the failure; a subagent's does not", async () => {
  const run = async (parent: string | null) => {
    const { provider } = providerWith(async function* () {
      yield initConnected;
      yield {
        type: "assistant",
        uuid: "a1",
        parent_tool_use_id: parent,
        error: "overloaded",
        message: { content: [{ type: "text", text: "API Error: 529" }] },
      };
      yield { type: "result", ...errorResult({ terminal_reason: "api_error" }) };
    });
    return errorsOf(await runTurn(provider)).at(-1)?.code;
  };
  assert.equal(await run(null), "overloaded");
  assert.equal(await run("toolu_1"), "turn_failed");
});
