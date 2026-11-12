import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentEvent } from "./types/index.ts";

import { CODEX_WEB_AND_SHELL, CodexAgentProvider } from "./codex-provider.ts";
import { testCodexHome } from "./testing/codex-home.ts";

/**
 * A fake `codex app-server`: answers every JSON-RPC request and, on `turn/start`,
 * replays the notification script handed to it in `FAKE_NOTIFS`. Enough of the
 * protocol to drive `sendTurn` end to end without a real Codex install.
 */
const FAKE_SERVER = (() => {
  const file = join(mkdtempSync(join(tmpdir(), "muxi-agent-codex-fake-server-")), "fake-codex");
  writeFileSync(
    file,
    `#!/usr/bin/env node
const notifs = JSON.parse(process.env.FAKE_NOTIFS ?? "[]");
// Notifications sent right after the initialize handshake, before any turn.
const bootNotifs = JSON.parse(process.env.FAKE_BOOT_NOTIFS ?? "[]");
// Turn pages served to thread/turns/list, one per call, in order.
const turnsPages = JSON.parse(process.env.FAKE_TURNS_PAGES ?? "[]");
function resultFor(method) {
  if (method === "thread/start" || method === "thread/resume") {
    return { thread: { id: "t1", modelProvider: "openai" }, model: "gpt-5.6-sol" };
  }
  if (method === "thread/fork") {
    return { thread: { id: "t2", modelProvider: "openai" }, model: "gpt-5.6-sol" };
  }
  if (method === "turn/start") return { turn: { id: "turn1" } };
  if (method === "model/list") {
    return JSON.parse(process.env.FAKE_MODELS ?? '{"data":[],"nextCursor":null}');
  }
  if (method === "thread/turns/list") {
    return turnsPages.shift() ?? { data: [], nextCursor: null };
  }
  if (method === "thread/revert") return { thread: { id: "t1", turns: [] } };
  if (method === "account/rateLimits/read") {
    return JSON.parse(process.env.FAKE_RATE_LIMITS ?? '{"rateLimits":null,"rateLimitsByLimitId":null}');
  }
  return {};
}
let buf = "";
let heldUnsubscribe = null;
process.stdin.on("data", (chunk) => {
  buf += chunk;
  const lines = buf.split("\\n");
  buf = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    // Record every request method so a test can assert what the provider sent
    // (e.g. turn/interrupt on a timeout).
    if (process.env.FAKE_METHOD_LOG && msg.method) {
      require("node:fs").appendFileSync(process.env.FAKE_METHOD_LOG, msg.method + "\\n");
    }
    if (process.env.FAKE_REQUEST_LOG && msg.id !== undefined) {
      require("node:fs").appendFileSync(process.env.FAKE_REQUEST_LOG, JSON.stringify(msg) + "\\n");
    }
    if (msg.id === undefined) continue; // client notification (e.g. "initialized")
    // A codex that can't pause timeout accounting (no such method, or gated
    // behind a capability): the question still forwards, the clock keeps running.
    if (msg.method === "thread/increment_elicitation" && process.env.FAKE_NO_PAUSE) {
      const error = {
        code: -32600,
        message: "thread/increment_elicitation requires experimentalApi capability",
      };
      process.stdout.write(JSON.stringify({ id: msg.id, error }) + "\\n");
      continue;
    }
    // A codex without permission profiles: config writes fail.
    if (msg.method === "config/batchWrite" && process.env.FAKE_NO_PROFILES) {
      const error = { code: -32600, message: "Invalid request: unknown field \`permissions\`" };
      process.stdout.write(JSON.stringify({ id: msg.id, error }) + "\\n");
      continue;
    }
    // Codex 0.156 removed thread/rollback; answer the way it does.
    if (msg.method === "thread/rollback") {
      const error = { code: -32600, message: "Invalid request: unknown variant \`thread/rollback\`" };
      process.stdout.write(JSON.stringify({ id: msg.id, error }) + "\\n");
      continue;
    }
    // A slow unload: the reply waits for a \`test/release\` request on the same
    // pipe, and the method log marks when it lands, so a test can order a resume
    // against everything the provider sent before the release.
    if (msg.method === "thread/unsubscribe" && process.env.FAKE_HOLD_UNSUBSCRIBE) {
      heldUnsubscribe = msg.id;
      continue;
    }
    if (msg.method === "test/release" && heldUnsubscribe !== null) {
      if (process.env.FAKE_METHOD_LOG) {
        require("node:fs").appendFileSync(process.env.FAKE_METHOD_LOG, "unsubscribe:answered\\n");
      }
      process.stdout.write(JSON.stringify({ id: heldUnsubscribe, result: { status: "unsubscribed" } }) + "\\n");
      heldUnsubscribe = null;
    }
    // A codex whose thread/revert fails: FAKE_REVERT_ERROR carries the message.
    if (msg.method === "thread/revert" && process.env.FAKE_REVERT_ERROR) {
      const error = { code: -32600, message: process.env.FAKE_REVERT_ERROR };
      process.stdout.write(JSON.stringify({ id: msg.id, error }) + "\\n");
      continue;
    }
    process.stdout.write(JSON.stringify({ id: msg.id, result: resultFor(msg.method) }) + "\\n");
    if (msg.method === "initialize") {
      for (const n of bootNotifs) process.stdout.write(JSON.stringify(n) + "\\n");
    }
    if (msg.method === "turn/start") {
      for (const n of notifs) process.stdout.write(JSON.stringify(n) + "\\n");
    }
  }
});
`,
    { mode: 0o755 },
  );
  return file;
})();

/** Drive one turn against the fake app-server and collect its domain events. */
async function runTurn(
  notifs: unknown[],
  opts: { bootNotifs?: unknown[] } = {},
): Promise<AgentEvent[]> {
  const provider = new CodexAgentProvider({
    ...testCodexHome(),
    codexBin: FAKE_SERVER,
    env: {
      FAKE_NOTIFS: JSON.stringify(notifs),
      ...(opts.bootNotifs ? { FAKE_BOOT_NOTIFS: JSON.stringify(opts.bootNotifs) } : {}),
    },
    // Keep a wedged expectation a short failure instead of a 30-minute hang.
    turnTimeoutMs: 10_000,
  });
  try {
    const thread = await provider.startThread({ cwd: process.cwd() });
    const events: AgentEvent[] = [];
    for await (const ev of provider.sendTurn(thread.id, { text: "hi" })) {
      events.push(ev);
    }
    return events;
  } finally {
    await provider.stop();
  }
}

const started = { method: "turn/started", params: { threadId: "t1", turn: { id: "turn1" } } };
const delta = {
  method: "item/agentMessage/delta",
  params: { threadId: "t1", turnId: "turn1", itemId: "i1", delta: "partial" },
};
const completed = (turn: Record<string, unknown>) => ({
  method: "turn/completed",
  params: { threadId: "t1", turn: { id: "turn1", ...turn } },
});

test("thread model comes from the response model, not modelProvider", async () => {
  const provider = new CodexAgentProvider({
    ...testCodexHome(), codexBin: FAKE_SERVER });
  try {
    const thread = await provider.startThread({ cwd: process.cwd() });
    assert.equal(thread.model, "gpt-5.6-sol");
  } finally {
    await provider.stop();
  }
});

test("forwards both Fast and an explicit return to Standard on turn/start", async () => {
  const log = newLog("muxi-agent-service-tier-");
  const provider = new CodexAgentProvider({
    ...testCodexHome(),
    codexBin: FAKE_SERVER,
    env: {
      FAKE_NOTIFS: JSON.stringify([started, completed({ status: "completed", error: null })]),
      FAKE_REQUEST_LOG: log,
    },
    turnTimeoutMs: 10_000,
  });
  try {
    const thread = await provider.startThread({ cwd: process.cwd() });
    for await (const _ of provider.sendTurn(thread.id, { text: "hi", serviceTier: "priority" }));
    for await (const _ of provider.sendTurn(thread.id, { text: "hi", serviceTier: null }));
  } finally {
    await provider.stop();
  }
  const [fast, standard] = requestsIn(log).filter((request) => request.method === "turn/start");
  assert.equal(fast?.params?.serviceTier, "priority");
  assert.equal("serviceTier" in (standard?.params ?? {}), true);
  assert.equal(standard?.params?.serviceTier, null);
});

// A turn Codex marks `failed` used to close as `turn.completed`: thread idle, no
// error bubble, an answer that just stops. It must terminate with the failure.
test("a failed turn ends in a fatal error.raised, not a clean completion", async () => {
  const events = await runTurn([
    started,
    delta,
    completed({
      status: "failed",
      error: { message: "Signed out", codexErrorInfo: "unauthorized", additionalDetails: null },
    }),
  ]);
  assert.deepEqual(
    events.map((e) => e.type),
    ["turn.started", "agent.message.delta", "error.raised"],
  );
  const err = events.at(-1)!;
  assert.equal(err.type, "error.raised");
  if (err.type !== "error.raised") return;
  assert.equal(err.message, "Signed out");
  assert.equal(err.code, "not_logged_in");
  assert.equal(err.fatal, true);
  assert.equal(err.threadId, "t1");
  assert.equal(err.turnId, "turn1");
});

test("an interrupted turn completes, with its reason as a warning", async () => {
  const events = await runTurn([
    started,
    completed({
      status: "interrupted",
      error: { message: "stopped by user", codexErrorInfo: null, additionalDetails: null },
    }),
  ]);
  assert.deepEqual(
    events.map((e) => e.type),
    ["turn.started", "error.raised", "turn.completed"],
  );
  const warning = events[1]!;
  assert.equal(warning.type, "error.raised");
  if (warning.type !== "error.raised") return;
  assert.equal(warning.code, "interrupted");
  assert.equal(warning.fatal, false);
});

test("a non-retry error followed by its failed turn raises once", async () => {
  const error = { message: "You've hit your usage limit.", codexErrorInfo: "usageLimitExceeded", additionalDetails: null };
  const events = await runTurn([
    started,
    { method: "error", params: { threadId: "t1", turnId: "turn1", willRetry: false, error } },
    completed({ status: "failed", error }),
  ]);
  assert.deepEqual(
    events.map((e) => e.type),
    ["turn.started", "error.raised"],
  );
});

test("a non-retry error on a turn that completes anyway is still its one terminal", async () => {
  const error = { message: "stream broke", codexErrorInfo: null, additionalDetails: null };
  const events = await runTurn([
    started,
    { method: "error", params: { threadId: "t1", turnId: "turn1", willRetry: false, error } },
    completed({ status: "completed", error: null }),
  ]);
  assert.deepEqual(
    events.map((e) => e.type),
    ["turn.started", "error.raised"],
  );
  const err = events.at(-1)!;
  assert.ok(err.type === "error.raised" && err.fatal === true && err.message === "stream broke");
});

// A stopped turn can still get a late non-retry error after the next turn on the
// same thread has started. It must neither fail nor close that next turn.
test("a late error for an earlier turn on the thread does not touch this one", async () => {
  const error = { message: "turn0 gave up", codexErrorInfo: null, additionalDetails: null };
  const events = await runTurn([
    started,
    { method: "error", params: { threadId: "t1", turnId: "turn0", willRetry: false, error } },
    completed({ status: "completed", error: null }),
  ]);
  assert.deepEqual(
    events.map((e) => e.type),
    ["turn.started", "turn.completed"],
  );
});

// The app-server is one shared process: before `error.raised` carried a thread
// id, every error was forwarded to every in-flight turn, so thread B's auth
// failure errored (and was persisted into) thread A.
test("an error addressed to another thread is not forwarded", async () => {
  const events = await runTurn([
    started,
    {
      method: "error",
      params: {
        threadId: "other-thread",
        turnId: "other-turn",
        willRetry: false,
        error: { message: "other thread died", codexErrorInfo: null, additionalDetails: null },
      },
    },
    completed({ status: "completed", error: null }),
  ]);
  assert.deepEqual(
    events.map((e) => e.type),
    ["turn.started", "turn.completed"],
  );
});

// Codex retries transient blips itself; a `willRetry` error is a warning about
// one it recovered from and must not truncate the turn.
test("a retryable error is a warning and the turn still completes", async () => {
  const events = await runTurn([
    started,
    {
      method: "error",
      params: {
        threadId: "t1",
        turnId: "turn1",
        willRetry: true,
        error: {
          message: "connection reset",
          codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: null } },
          additionalDetails: null,
        },
      },
    },
    delta,
    completed({ status: "completed", error: null }),
  ]);
  assert.deepEqual(
    events.map((e) => e.type),
    ["turn.started", "error.raised", "agent.message.delta", "turn.completed"],
  );
  const warning = events[1]!;
  assert.equal(warning.type, "error.raised");
  if (warning.type !== "error.raised") return;
  assert.equal(warning.fatal, false);
  assert.equal(warning.code, "network");
});

// Codex retries a failing request five times (each attempt a `willRetry` warning),
// then reports the turn `completed` — with no answer and no error. That used to
// render as four identical warnings and no outcome at all.
test("retries exhausted with nothing produced promotes the warning to the turn's failure", async () => {
  const retry = (attempt: number) => ({
    method: "error",
    params: {
      threadId: "t1",
      turnId: "turn1",
      willRetry: true,
      error: {
        message: `Reconnecting... ${attempt}/5`,
        codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 503 } },
        additionalDetails: "unexpected status 503 Service Unavailable",
      },
    },
  });
  const events = await runTurn([
    started,
    retry(2),
    retry(3),
    retry(4),
    retry(5),
    completed({ status: "completed", error: null }),
  ]);

  const types = events.map((e) => e.type);
  assert.equal(types.filter((t) => t === "turn.completed").length, 0, "an empty turn isn't a success");
  const raised = events.filter((e) => e.type === "error.raised");
  assert.equal(raised.length, 5, "the four warnings, then the promoted terminal failure");
  const terminal = raised.at(-1)!;
  if (terminal.type !== "error.raised") return;
  assert.equal(terminal.fatal, true);
  assert.equal(terminal.code, "network");
  assert.match(terminal.message, /5\/5/, "the last attempt's wording is the informative one");
});

test("a turn that produced an answer still completes cleanly after a warning", async () => {
  const events = await runTurn([
    started,
    {
      method: "error",
      params: {
        threadId: "t1",
        turnId: "turn1",
        willRetry: true,
        error: {
          message: "Reconnecting... 1/5",
          codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: null } },
          additionalDetails: null,
        },
      },
    },
    delta,
    completed({ status: "completed", error: null }),
  ]);
  assert.equal(events.at(-1)?.type, "turn.completed", "content means the turn really did finish");
});

// Codex flags an auth failure `willRetry` and walks its whole ladder against a
// credential that can't appear mid-turn. One attempt is the useful number.
test("an auth failure ends the turn on the first report, without the retry ladder", async () => {
  const authError = (attempt: number) => ({
    method: "error",
    params: {
      threadId: "t1",
      turnId: "turn1",
      willRetry: true,
      error: {
        message: `Reconnecting... ${attempt}/5`,
        codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 401 } },
        additionalDetails: "unexpected status 401 Unauthorized: Missing bearer",
      },
    },
  });
  const events = await runTurn([
    started,
    authError(1),
    authError(2),
    authError(3),
    completed({ status: "completed", error: null }),
  ]);

  assert.deepEqual(
    events.map((e) => e.type),
    ["turn.started", "error.raised"],
    "the turn ends at the first auth failure — later attempts never reach the chat",
  );
  const err = events.at(-1)!;
  if (err.type !== "error.raised") return;
  assert.equal(err.fatal, true, "not a warning: retrying cannot fix a missing login");
  assert.equal(err.code, "not_logged_in");
});

const askUser = {
  method: "item/started",
  params: {
    threadId: "t1",
    turnId: "turn1",
    item: { type: "mcpToolCall", id: "i9", server: "lab", tool: "ask_user", arguments: {} },
  },
};

// A turn that times out used to be abandoned, not stopped: the app-server kept
// executing it for minutes after the UI had already shown the failure.
test("a timed-out turn interrupts the app-server before it fails", async (t) => {
  const log = join(mkdtempSync(join(tmpdir(), "muxi-agent-codex-methods-")), "methods.log");
  const provider = new CodexAgentProvider({
    ...testCodexHome(),
    codexBin: FAKE_SERVER,
    // No `turn/completed`: the turn wedges exactly like the incident's did.
    env: { FAKE_NOTIFS: JSON.stringify([started]), FAKE_METHOD_LOG: log },
    turnTimeoutMs: 200,
  });
  try {
    const thread = await provider.startThread({ cwd: process.cwd() });
    // The turn's clock is mocked, so the timeout fires the moment the turn is
    // known to be running instead of 200ms of real time later.
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const turn = provider.sendTurn(thread.id, { text: "hi" })[Symbol.asyncIterator]();
    assert.equal((await turn.next()).value?.type, "turn.started");
    t.mock.timers.tick(200);
    await assert.rejects(
      (async () => {
        while (!(await turn.next()).done);
      })(),
      /Turn timed out after 200ms/,
      "the timeout is still the failure the reader sees",
    );
    t.mock.timers.reset();
    // The interrupt is fire-and-forget, so wait for the write to land.
    await flush(provider);
    assert.match(readFileSync(log, "utf8"), /turn\/interrupt/, "codex was told to stop the turn");
  } finally {
    t.mock.timers.reset();
    await provider.stop();
  }
});

test("ask_user is an ordinary tool row; the provider adds no warning of its own", async () => {
  const events = await runTurn([started, askUser, completed({ status: "completed", error: null })]);
  assert.deepEqual(
    events.map((e) => e.type),
    ["turn.started", "tool.started", "turn.completed"],
  );
});

/** Every JSON-RPC line the fake app-server received, in order. */
function requestsIn(log: string): Array<{ id?: unknown; method?: string; params?: Record<string, unknown>; result?: Record<string, unknown> }> {
  return readFileSync(log, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function newLog(prefix: string): string {
  return join(mkdtempSync(join(tmpdir(), prefix)), "requests.jsonl");
}

// A gate the user never answers: the turn ends (stopped, failed, or just done)
// with the approval still parked. Codex holds its request open until it gets a
// reply, and our record would outlive the turn that could route one.
test("an approval the UI never answered is declined at turn end", async () => {
  const log = newLog("muxi-agent-codex-gate-");
  const gate = {
    id: 77,
    method: "mcpServer/elicitation/request",
    params: {
      threadId: "t1",
      turnId: "turn1",
      serverName: "lab",
      message: 'Allow the lab MCP server to run tool "save_note"?',
    },
  };
  const provider = new CodexAgentProvider({
    ...testCodexHome(),
    codexBin: FAKE_SERVER,
    env: {
      FAKE_NOTIFS: JSON.stringify([started, gate, completed({ status: "completed", error: null })]),
      FAKE_REQUEST_LOG: log,
    },
    turnTimeoutMs: 10_000,
  });
  try {
    const thread = await provider.startThread({ cwd: process.cwd() });
    const events: AgentEvent[] = [];
    for await (const ev of provider.sendTurn(thread.id, { text: "hi" })) events.push(ev);
    assert.equal(
      events.filter((e) => e.type === "approval.requested").length,
      1,
      "the gate did reach the UI",
    );
    // The decline is written to the app-server, which appends it to the log.
    await flush(provider);
    const reply = requestsIn(log).find((m) => m.id === 77)?.result;
    assert.equal(reply?.action, "decline", "the unanswered gate was released, not left hanging");
    const pending = (provider as unknown as { pendingApprovals: Map<string, unknown> })
      .pendingApprovals;
    assert.equal(pending.size, 0, "and its record is gone");
  } finally {
    await provider.stop();
  }
});

// A subagent thread loads with multi-agent on, and a child's approval
// request reaches the UI on the parent's thread and turn, naming its subagent.
test("a subagent thread starts with subagents on and brings a child's approval to the parent turn", async () => {
  const log = newLog("muxi-agent-codex-subagent-");
  const child = {
    method: "thread/started",
    params: { thread: { id: "c1", parentThreadId: "t1", source: { subAgent: { thread_spawn: { agent_path: "/root/region" } } } } },
  };
  const childTurn = { method: "turn/started", params: { threadId: "c1", turn: { id: "c1-turn" } } };
  const childGate = {
    id: 80,
    method: "mcpServer/elicitation/request",
    params: { threadId: "c1", turnId: "c1-turn", serverName: "lab", message: 'Allow the lab MCP server to run tool "echo"?' },
  };
  const provider = new CodexAgentProvider({
    ...testCodexHome(),
    codexBin: FAKE_SERVER,
    env: {
      FAKE_NOTIFS: JSON.stringify([started, child, childTurn, childGate, completed({ status: "completed", error: null })]),
      FAKE_REQUEST_LOG: log,
    },
    turnTimeoutMs: 10_000,
    subagent: { role: "helper", description: "A read-only helper.", instructions: "You are a read-only helper." },
  });
  try {
    const thread = await provider.startThread({ cwd: process.cwd(), subagents: true });
    const events: AgentEvent[] = [];
    for await (const ev of provider.sendTurn(thread.id, { text: "hi" })) events.push(ev);
    await flush(provider);
    const start = requestsIn(log).find((m) => m.method === "thread/start");
    assert.equal((start?.params?.config as Record<string, unknown> | undefined)?.["agents.enabled"], true);
    const asked = events.find((e) => e.type === "approval.requested");
    assert.ok(asked?.type === "approval.requested");
    assert.equal(asked.request.threadId, "t1");
    assert.equal(asked.request.turnId, "turn1");
    assert.deepEqual(asked.request.subagent, { id: "c1", name: "Region" });
  } finally {
    await provider.stop();
  }
});

// Codex reuses a thread it still holds when a resume carries no config, so a
// thread resumed with subagents off has to reload with the override explicit.
test("resuming a Codex thread with subagents off reloads it with multi-agent off, not as it was", async () => {
  const log = newLog("muxi-agent-codex-subagent-off-");
  const provider = new CodexAgentProvider({
    ...testCodexHome(),
    codexBin: FAKE_SERVER,
    env: { FAKE_NOTIFS: JSON.stringify([started, completed({ status: "completed", error: null })]), FAKE_REQUEST_LOG: log },
    turnTimeoutMs: 10_000,
    subagent: { role: "helper", description: "A read-only helper.", instructions: "You are a read-only helper." },
  });
  try {
    const thread = await provider.startThread({ cwd: process.cwd(), subagents: true });
    for await (const _ of provider.sendTurn(thread.id, { text: "hi" }));
    await provider.resumeThread(thread.id, { subagents: false });
    for await (const _ of provider.sendTurn(thread.id, { text: "again" }));
    await flush(provider);
    const start = requestsIn(log).find((m) => m.method === "thread/start");
    assert.equal((start?.params?.config as Record<string, unknown> | undefined)?.["agents.enabled"], true);
    const resume = requestsIn(log).find((m) => m.method === "thread/resume");
    assert.equal((resume?.params?.config as Record<string, unknown> | undefined)?.["agents.enabled"], false);
  } finally {
    await provider.stop();
  }
});

// Codex has no per-turn tool switch, so web search turned on for a thread must
// reload it with search on, and keep the subagent setting the thread had.
test("resuming a Codex thread with web search on reloads it with live search and its subagents kept", async () => {
  const log = newLog("muxi-agent-codex-web-search-");
  const provider = new CodexAgentProvider({
    ...testCodexHome(),
    codexBin: FAKE_SERVER,
    env: { FAKE_NOTIFS: JSON.stringify([started, completed({ status: "completed", error: null })]), FAKE_REQUEST_LOG: log },
    turnTimeoutMs: 10_000,
    subagent: { role: "helper", description: "A read-only helper.", instructions: "You are a read-only helper." },
  });
  try {
    const thread = await provider.startThread({ cwd: process.cwd(), subagents: true });
    for await (const _ of provider.sendTurn(thread.id, { text: "hi" }));
    await provider.resumeThread(thread.id, { webSearch: true });
    for await (const _ of provider.sendTurn(thread.id, { text: "again" }));
    await flush(provider);
    const start = requestsIn(log).find((m) => m.method === "thread/start");
    assert.equal((start?.params?.config as Record<string, unknown> | undefined)?.web_search, "disabled");
    const resume = requestsIn(log).find((m) => m.method === "thread/resume");
    const config = resume?.params?.config as Record<string, unknown> | undefined;
    assert.equal(config?.web_search, "live");
    assert.equal(config?.["agents.enabled"], true);
  } finally {
    await provider.stop();
  }
});

test("a Codex thread's MCP servers load as HTTP servers that prompt on every call", async () => {
  const log = newLog("muxi-agent-codex-mcp-");
  const provider = new CodexAgentProvider({
    ...testCodexHome(),
    codexBin: FAKE_SERVER,
    env: { FAKE_NOTIFS: JSON.stringify([started, completed({ status: "completed", error: null })]), FAKE_REQUEST_LOG: log },
    turnTimeoutMs: 10_000,
  });
  try {
    await provider.startThread({
      cwd: process.cwd(),
      mcpServers: { lab: { type: "http", url: "http://127.0.0.1:8787/mcp", headers: { authorization: "Bearer t" } } },
    });
    await flush(provider);
    const start = requestsIn(log).find((m) => m.method === "thread/start");
    const config = start?.params?.config as Record<string, unknown> | undefined;
    assert.deepEqual(config?.mcp_servers, {
      lab: {
        url: "http://127.0.0.1:8787/mcp",
        http_headers: { authorization: "Bearer t" },
        default_tools_approval_mode: "prompt",
        omit_tools_from: ["deferred"],
      },
    });
    assert.equal(config?.web_search, "disabled");
    assert.equal(config?.["agents.enabled"], false, "no subagent role, so no subagents");
    assert.equal(start?.params?.sandbox, "read-only");
    assert.equal(start?.params?.approvalPolicy, "on-request");
  } finally {
    await provider.stop();
  }
});

/** A question from an MCP server, as codex forwards it. */
const question = {
  id: 78,
  method: "mcpServer/elicitation/request",
  params: {
    threadId: "t1",
    turnId: "turn1",
    serverName: "lab",
    message: 'Allow the lab MCP server to run tool "ask_user"?',
  },
};

// Every running turn hears every server request. A workspace thread's shell
// approval reaching another thread's turn must be left for its owner, not rejected.
test("a turn leaves another thread's command approval alone", async () => {
  const log = newLog("muxi-agent-codex-foreign-");
  const foreign = {
    id: 91,
    method: "item/commandExecution/requestApproval",
    params: { threadId: "t-other", turnId: "turn9", itemId: "c1", command: "pnpm test" },
  };
  const provider = new CodexAgentProvider({
    ...testCodexHome(),
    codexBin: FAKE_SERVER,
    env: {
      FAKE_NOTIFS: JSON.stringify([started, foreign, completed({ status: "completed", error: null })]),
      FAKE_REQUEST_LOG: log,
    },
    turnTimeoutMs: 10_000,
  });
  try {
    const thread = await provider.startThread({ cwd: process.cwd() });
    const events: AgentEvent[] = [];
    for await (const ev of provider.sendTurn(thread.id, { text: "hi" })) events.push(ev);
    assert.equal(events.filter((e) => e.type === "approval.requested").length, 0);
    const replies = requestsIn(log).filter((m) => m.method === undefined && m.id === 91);
    assert.deepEqual(replies, [], "no reply, so no rejection, for a request this turn doesn't own");
  } finally {
    await provider.stop();
  }
});

// Codex 0.156 deprecates full-history hydration on resume and fork, and says so
// in a notice the chat shows. This package never reads that history, so it never asks.
test("resume and fork ask for thread metadata only", async () => {
  const log = newLog("muxi-agent-codex-exclude-turns-");
  const provider = new CodexAgentProvider({
    ...testCodexHome(), codexBin: FAKE_SERVER, env: { FAKE_REQUEST_LOG: log } });
  try {
    await provider.forkThread("t-cold");
    const wire = requestsIn(log).filter((m) => m.method === "thread/resume" || m.method === "thread/fork");
    assert.deepEqual(
      wire.map((m) => [m.method, m.params?.excludeTurns]),
      [
        ["thread/resume", true],
        ["thread/fork", true],
      ],
    );
  } finally {
    await provider.stop();
  }
});

// `thread/increment_elicitation` pauses the thread's timeout accounting; it is
// not a "forward questions to me" switch. Loading a thread used to increment it
// once and never decrement, and a permanently paused thread never finishes a
// code-mode exec on codex 0.155. Nothing about loading a thread is a question.
test("loading a thread leaves the elicitation counter alone", async () => {
  const log = newLog("muxi-agent-codex-load-");
  const provider = new CodexAgentProvider({
    ...testCodexHome(),
    codexBin: FAKE_SERVER,
    env: {
      FAKE_NOTIFS: JSON.stringify([started, completed({ status: "completed", error: null })]),
      FAKE_REQUEST_LOG: log,
    },
    turnTimeoutMs: 10_000,
  });
  try {
    const thread = await provider.startThread({ cwd: process.cwd() });
    for await (const _ of provider.sendTurn(thread.id, { text: "hi" }));
    const methods = requestsIn(log).map((m) => m.method);
    assert.ok(!methods.includes("thread/increment_elicitation"), methods.join(","));
    assert.ok(!methods.includes("thread/decrement_elicitation"), methods.join(","));
  } finally {
    await provider.stop();
  }
});

test("a surfaced question pauses the thread's clock until it is answered", async () => {
  const log = newLog("muxi-agent-codex-pause-");
  const provider = new CodexAgentProvider({
    ...testCodexHome(),
    codexBin: FAKE_SERVER,
    env: {
      FAKE_NOTIFS: JSON.stringify([started, question, completed({ status: "completed", error: null })]),
      FAKE_REQUEST_LOG: log,
    },
    turnTimeoutMs: 10_000,
  });
  try {
    const thread = await provider.startThread({ cwd: process.cwd() });
    for await (const ev of provider.sendTurn(thread.id, { text: "hi" })) {
      if (ev.type === "approval.requested") {
        await provider.resolveApproval(ev.request.requestId, { action: "accept" });
      }
    }
    const wire = requestsIn(log);
    const shape = wire.map((m) => m.method ?? `reply:${String(m.id)}`);
    const inc = wire.findIndex((m) => m.method === "thread/increment_elicitation");
    const reply = wire.findIndex((m) => m.method === undefined && m.id === 78);
    const dec = wire.findIndex((m) => m.method === "thread/decrement_elicitation");
    assert.ok(inc >= 0 && reply >= 0 && dec >= 0, shape.join(" "));
    assert.ok(inc < reply && reply < dec, `paused before the human saw it, resumed after the answer: ${shape.join(" ")}`);
    assert.equal(wire[inc].params?.threadId, "t1");
    assert.equal(
      wire.filter((m) => m.method === "thread/increment_elicitation").length,
      wire.filter((m) => m.method === "thread/decrement_elicitation").length,
      "every pause is matched by a resume",
    );
  } finally {
    await provider.stop();
  }
});

// An interrupt, a server-side timeout, or another client can settle a request
// before the UI does. Codex then only says `serverRequest/resolved`; with no
// reply left to send, the clock the question paused still has to restart.
test("a question codex settles itself releases the pause without a reply", async () => {
  const log = newLog("muxi-agent-codex-resolved-");
  const resolved = {
    method: "serverRequest/resolved",
    params: { threadId: "t1", requestId: 78 },
  };
  const provider = new CodexAgentProvider({
    ...testCodexHome(),
    codexBin: FAKE_SERVER,
    env: {
      FAKE_NOTIFS: JSON.stringify([
        started,
        question,
        resolved,
        completed({ status: "completed", error: null }),
      ]),
      FAKE_REQUEST_LOG: log,
    },
    turnTimeoutMs: 10_000,
  });
  try {
    const thread = await provider.startThread({ cwd: process.cwd() });
    const events: AgentEvent[] = [];
    // The UI never answers: codex already did.
    for await (const ev of provider.sendTurn(thread.id, { text: "hi" })) events.push(ev);
    assert.equal(events.filter((e) => e.type === "approval.requested").length, 1);
    let wire = requestsIn(log);
    for (let i = 0; i < 50 && !wire.some((m) => m.method === "thread/decrement_elicitation"); i++) {
      await new Promise((r) => setTimeout(r, 20));
      wire = requestsIn(log);
    }
    const shape = wire.map((m) => m.method ?? `reply:${String(m.id)}`);
    assert.ok(wire.some((m) => m.method === "thread/decrement_elicitation"), `clock restarted: ${shape.join(" ")}`);
    assert.equal(
      wire.filter((m) => m.method === undefined && m.id === 78).length,
      0,
      `no reply is sent for a request codex already settled: ${shape.join(" ")}`,
    );
    const pending = (provider as unknown as { pendingApprovals: Map<string, unknown> })
      .pendingApprovals;
    assert.equal(pending.size, 0, "and its record is gone");
  } finally {
    await provider.stop();
  }
});

test("a build that cannot pause the clock still surfaces the question", async () => {
  const log = newLog("muxi-agent-codex-nopause-");
  const provider = new CodexAgentProvider({
    ...testCodexHome(),
    codexBin: FAKE_SERVER,
    env: {
      FAKE_NOTIFS: JSON.stringify([started, question, completed({ status: "completed", error: null })]),
      FAKE_REQUEST_LOG: log,
      FAKE_NO_PAUSE: "1",
    },
    turnTimeoutMs: 10_000,
  });
  try {
    const thread = await provider.startThread({ cwd: process.cwd() });
    let surfaced = 0;
    for await (const ev of provider.sendTurn(thread.id, { text: "hi" })) {
      if (ev.type === "approval.requested") {
        surfaced += 1;
        await provider.resolveApproval(ev.request.requestId, { action: "accept" });
      }
    }
    assert.equal(surfaced, 1, "the question reached the UI");
    const methods = requestsIn(log).map((m) => m.method);
    assert.ok(!methods.includes("thread/decrement_elicitation"), "nothing to resume when the pause never took");
  } finally {
    await provider.stop();
  }
});

/** One catalog row: two effort levels, "high" the model's own default. */
const CATALOG = JSON.stringify({
  data: [
    {
      id: "gpt-5.5",
      model: "gpt-5.5",
      upgrade: null,
      upgradeInfo: null,
      availabilityNux: null,
      displayName: "GPT-5.5",
      description: "",
      hidden: false,
      supportedReasoningEfforts: [
        { reasoningEffort: "low", description: "" },
        { reasoningEffort: "high", description: "" },
      ],
      defaultReasoningEffort: "high",
      inputModalities: [],
      supportsPersonality: false,
      additionalSpeedTiers: [],
      serviceTiers: [],
      defaultServiceTier: null,
      isDefault: true,
    },
  ],
  nextCursor: null,
});

/** Run one turn against a provider whose catalog is loaded, and report the
 *  `effort` it put on turn/start (undefined when it sent none). */
async function effortsOnTurns(inputs: Array<{ model?: string; effort?: string }>): Promise<unknown[]> {
  const log = newLog("muxi-agent-codex-effort-");
  const provider = new CodexAgentProvider({
    ...testCodexHome(),
    codexBin: FAKE_SERVER,
    env: {
      FAKE_NOTIFS: JSON.stringify([started, completed({ status: "completed", error: null })]),
      FAKE_MODELS: CATALOG,
      FAKE_REQUEST_LOG: log,
    },
    turnTimeoutMs: 10_000,
  });
  try {
    await provider.listModels();
    const thread = await provider.startThread({ cwd: process.cwd() });
    for (const input of inputs) {
      for await (const _ of provider.sendTurn(thread.id, { text: "hi", ...input }));
    }
    return requestsIn(log)
      .filter((m) => m.method === "turn/start")
      .map((turn) => turn.params?.effort);
  } finally {
    await provider.stop();
  }
}

// An effort the model doesn't offer used to go through untouched: Codex either
// ignores it (a silently different run than the picker showed) or rejects the turn.
test("a requested effort is clamped to the model's own scale", async () => {
  const [supported, unsupported, uncatalogued] = await effortsOnTurns([
    { model: "gpt-5.5", effort: "low" },
    { model: "gpt-5.5", effort: "xhigh" },
    // No catalog entry for the model — nothing to clamp against, so Codex decides.
    { model: "some-new-model", effort: "xhigh" },
  ]);
  assert.equal(supported, "low", "a supported level passes through");
  assert.equal(unsupported, "high", "an unsupported one falls back to the model's default");
  assert.equal(uncatalogued, "xhigh");
});

test("a model with a named successor is flagged superseded, with its retirement date", async () => {
  const [current] = JSON.parse(CATALOG).data;
  const retiring = {
    ...current,
    id: "gpt-5.4",
    model: "gpt-5.4",
    displayName: "GPT-5.4",
    isDefault: false,
    upgrade: "gpt-5.5",
    upgradeInfo: {
      model: "gpt-5.5",
      upgradeCopy: null,
      modelLink: null,
      migrationMarkdown: null,
      retirementAt: 1_792_004_400,
    },
  };
  const provider = new CodexAgentProvider({
    ...testCodexHome(),
    codexBin: FAKE_SERVER,
    env: { FAKE_MODELS: JSON.stringify({ data: [current, retiring], nextCursor: null }) },
    turnTimeoutMs: 10_000,
  });
  try {
    const models = await provider.listModels();
    const byId = new Map(models.map((m) => [m.id, m]));
    assert.equal(byId.get("gpt-5.5")?.superseded, undefined, "a current model carries no flag");
    assert.equal(byId.get("gpt-5.4")?.superseded, true);
    assert.equal(byId.get("gpt-5.4")?.retiresAt, "2026-10-14T19:00:00.000Z");
  } finally {
    await provider.stop();
  }
});

/** Roll back `numTurns` against the fake server and return every request sent. */
async function rollbackRequests(
  numTurns: number,
  env: Record<string, string>,
): Promise<ReturnType<typeof requestsIn>> {
  const log = newLog("muxi-agent-codex-rollback-");
  const provider = new CodexAgentProvider({
    ...testCodexHome(),
    codexBin: FAKE_SERVER,
    env: { FAKE_REQUEST_LOG: log, ...env },
    turnTimeoutMs: 10_000,
  });
  try {
    const thread = await provider.startThread({ cwd: process.cwd() });
    await provider.rollbackThread(thread.id, numTurns);
    return requestsIn(log);
  } finally {
    await provider.stop();
  }
}

// Rollback is thread/revert, keyed by the Nth-newest turn id. thread/rollback is
// gone from codex 0.156 and must never be sent.
test("rollback reverts to before the Nth-newest turn", async () => {
  const sent = await rollbackRequests(2, {
    FAKE_TURNS_PAGES: JSON.stringify([
      { data: [{ id: "turn_3" }, { id: "turn_2" }], nextCursor: null },
    ]),
  });
  const list = sent.find((m) => m.method === "thread/turns/list");
  assert.equal(list?.params?.sortDirection, "desc");
  const revert = sent.find((m) => m.method === "thread/revert");
  // Dropping the last 2 of turns 1..3 = keep strictly before turn_2.
  assert.deepEqual(revert?.params, { threadId: "t1", beforeTurnId: "turn_2" });
  assert.equal(sent.some((m) => m.method === "thread/rollback"), false);
});

test("rollback pages turns until the boundary is found", async () => {
  const sent = await rollbackRequests(3, {
    FAKE_TURNS_PAGES: JSON.stringify([
      { data: [{ id: "turn_5" }, { id: "turn_4" }], nextCursor: "older" },
      { data: [{ id: "turn_3" }], nextCursor: null },
    ]),
  });
  const lists = sent.filter((m) => m.method === "thread/turns/list");
  assert.equal(lists.length, 2, "kept paging past the short first page");
  assert.equal(lists[1]?.params?.cursor, "older");
  const revert = sent.find((m) => m.method === "thread/revert");
  assert.deepEqual(revert?.params, { threadId: "t1", beforeTurnId: "turn_3" });
});

// numTurns beyond the history clears everything: revert to before the oldest
// turn there is.
test("a rollback past the oldest turn reverts to before it", async () => {
  const sent = await rollbackRequests(5, {
    FAKE_TURNS_PAGES: JSON.stringify([
      { data: [{ id: "turn_2" }, { id: "turn_1" }], nextCursor: null },
    ]),
  });
  const revert = sent.find((m) => m.method === "thread/revert");
  assert.deepEqual(revert?.params, { threadId: "t1", beforeTurnId: "turn_1" });
});

test("a thread with no turns is refused before any revert", async () => {
  await assert.rejects(rollbackRequests(1, {}), /has no turns to roll back/);
});

// Codex's own revert failure (e.g. a pre-0.151 legacy thread) surfaces untouched.
test("a revert error propagates unchanged", async () => {
  await assert.rejects(
    rollbackRequests(1, {
      FAKE_REVERT_ERROR: "thread/revert only supports paginated threads",
      FAKE_TURNS_PAGES: JSON.stringify([{ data: [{ id: "turn_1" }], nextCursor: null }]),
    }),
    /only supports paginated threads/,
  );
});

// Codex folds a mid-turn message into the running turn through `turn/steer`,
// which takes the turn id as a PRECONDITION (`expectedTurnId`) — send the wrong
// one and the app-server refuses rather than steering the wrong turn.
test("steerTurn sends the text and the expected turn id to turn/steer", async () => {
  const log = join(mkdtempSync(join(tmpdir(), "muxi-agent-codex-steer-")), "requests.jsonl");
  const provider = new CodexAgentProvider({
    ...testCodexHome(),
    codexBin: FAKE_SERVER,
    env: { FAKE_REQUEST_LOG: log },
  });
  try {
    const thread = await provider.startThread({ cwd: process.cwd() });
    await provider.steerTurn(thread.id, "turn1", "weekly, not daily");
  } finally {
    await provider.stop();
  }
  const steer = readFileSync(log, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { method: string; params: Record<string, unknown> })
    .find((request) => request.method === "turn/steer");
  assert.deepEqual(steer?.params, {
    threadId: "t1",
    input: [{ type: "text", text: "weekly, not daily", text_elements: [] }],
    expectedTurnId: "turn1",
  });
});

// ── error signals: notices, reroutes, usage limits ───────────────────────────

test("a notice Codex sends at spawn shows on the first turn, once it has started", async () => {
  const notice = { method: "deprecationNotice", params: { summary: "The foo setting is deprecated.", details: null } };
  const events = await runTurn([started, completed({ status: "completed", error: null })], {
    bootNotifs: [notice, notice],
  });
  assert.deepEqual(
    events.map((e) => (e.type === "error.raised" ? `${e.type}:${e.code}:${e.fatal}` : e.type)),
    ["turn.started", "error.raised:deprecated:false", "turn.completed"],
    "held until the turn opens, and shown once",
  );
});

test("a reroute is a visible note and never promoted to the turn's failure", async () => {
  const rerouted = {
    method: "model/rerouted",
    params: { threadId: "t1", turnId: "turn1", fromModel: "gpt-5.6-sol", toModel: "gpt-5.4", reason: "highRiskCyberActivity" },
  };
  const events = await runTurn([started, rerouted, completed({ status: "completed", error: null })]);
  assert.equal(events.at(-1)?.type, "turn.completed", "a turn with only a notice still completes");
  const note = events.find((e) => e.type === "error.raised");
  assert.ok(note?.type === "error.raised");
  assert.equal(note.code, "model_rerouted");
  assert.equal(note.fatal, false);
  assert.match(note.message, /with gpt-5\.4 instead of gpt-5\.6-sol/);
});

test("a usage-limit stop names the exhausted window from the pushed snapshot", async () => {
  const resetsAt = Math.floor(Date.now() / 1000) + 2 * 3600;
  const pushed = {
    method: "account/rateLimits/updated",
    params: {
      rateLimits: {
        limitId: "codex",
        primary: { usedPercent: 100, windowDurationMins: 300, resetsAt },
        secondary: null,
        planType: null,
      },
    },
  };
  const limitError = {
    message: "You've hit your usage limit.",
    codexErrorInfo: "usageLimitExceeded",
    additionalDetails: null,
  };
  const events = await runTurn([
    started,
    pushed,
    { method: "error", params: { threadId: "t1", turnId: "turn1", willRetry: false, error: limitError } },
    completed({ status: "failed", error: limitError }),
  ]);
  const errors = events.filter((e) => e.type === "error.raised");
  assert.equal(errors.length, 1, "one terminal");
  const terminal = errors[0]!;
  assert.ok(terminal.type === "error.raised");
  assert.equal(terminal.code, "usage_limit");
  assert.match(terminal.message, /^Codex hit its 5-hour usage limit\. It resets at /);
});

test("getUsage reads the codex bucket rather than the single-bucket view", async () => {
  const window = (usedPercent: number, windowDurationMins: number) => ({ usedPercent, windowDurationMins, resetsAt: 1790198031 });
  const provider = new CodexAgentProvider({
    ...testCodexHome(),
    codexBin: FAKE_SERVER,
    env: {
      FAKE_RATE_LIMITS: JSON.stringify({
        rateLimits: { limitId: "other", primary: window(90, 300), secondary: null, planType: "team" },
        rateLimitsByLimitId: {
          codex: { limitId: "codex", primary: window(4, 300), secondary: window(30, 10080), planType: "team" },
        },
      }),
    },
  });
  try {
    const usage = await provider.getUsage();
    assert.deepEqual(
      usage?.windows.map((w) => w.usedPercent),
      [4, 30],
    );
    assert.equal(usage?.plan, "Team");
  } finally {
    await provider.stop();
  }
});

// ── compaction ───────────────────────────────────────────────────────────────

test("a compaction reports the size before and the size Codex reports after", async () => {
  const usage = (totalTokens: number) => ({
    method: "thread/tokenUsage/updated",
    params: {
      threadId: "t1",
      turnId: "turn1",
      tokenUsage: {
        last: { totalTokens, inputTokens: totalTokens, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 },
        total: { totalTokens, inputTokens: totalTokens, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 },
        modelContextWindow: 258_400,
      },
    },
  });
  const item = (method: string) => ({
    method,
    params: { threadId: "t1", turnId: "turn1", item: { type: "contextCompaction", id: "c1" } },
  });
  const events = await runTurn([
    started,
    usage(240_000),
    item("item/started"),
    usage(9_000),
    item("item/completed"),
    completed({ status: "completed", error: null }),
  ]);
  const phases = events.flatMap((e) =>
    e.type === "context.compaction" ? [[e.phase, e.trigger, e.preTokens, e.postTokens]] : [],
  );
  assert.deepEqual(phases, [
    ["started", "auto", 240_000, undefined],
    ["completed", "auto", 240_000, 9_000],
  ]);
});

// ── idle unload ──────────────────────────────────────────────────────────────

/** The methods the fake app-server logged, in order ([] before it spawned). */
function methodsIn(log: string): string[] {
  return existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : [];
}

/** Poll until `ready()` holds, or fail after ~2s. */
async function until(ready: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 400 && !ready(); i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(ready(), what);
}

function liveThreadsOf(provider: CodexAgentProvider): Map<string, { lastActiveAt: number; busy: number }> {
  return (provider as unknown as { liveThreads: Map<string, { lastActiveAt: number; busy: number }> })
    .liveThreads;
}

/** Run one idle sweep now, instead of waiting for the interval to fire. */
function sweepNow(provider: CodexAgentProvider): void {
  (provider as unknown as { sweepIdleThreads(): void }).sweepIdleThreads();
}

/** Send a raw request to the fake app-server on the provider's own pipe. */
function rawRequest(provider: CodexAgentProvider, method: string): Promise<unknown> {
  return (provider as unknown as { client: { request(m: string, p: unknown): Promise<unknown> } }).client
    .request(method, {});
}

/** Round-trip a no-op, so everything sent before it is in the method log. */
const flush = (provider: CodexAgentProvider) => rawRequest(provider, "test/flush");

test("an idle thread is unloaded, and its next turn resumes it", async () => {
  const log = join(mkdtempSync(join(tmpdir(), "muxi-agent-codex-idle-")), "methods.log");
  const provider = new CodexAgentProvider({
    ...testCodexHome(),
    codexBin: FAKE_SERVER,
    env: {
      FAKE_NOTIFS: JSON.stringify([started, completed({ status: "completed", error: null })]),
      FAKE_METHOD_LOG: log,
    },
    turnTimeoutMs: 10_000,
    idleSweepMs: 5,
    idleUnloadMs: 1,
  });
  try {
    const thread = await provider.startThread({ cwd: process.cwd() });
    await until(() => methodsIn(log).includes("thread/unsubscribe"), "the idle thread was unloaded");
    assert.equal(liveThreadsOf(provider).has(thread.id), false);
    const events: AgentEvent[] = [];
    for await (const ev of provider.sendTurn(thread.id, { text: "hi" })) events.push(ev);
    assert.equal(events.at(-1)?.type, "turn.completed");
    const methods = methodsIn(log);
    const unload = methods.indexOf("thread/unsubscribe");
    const resume = methods.indexOf("thread/resume");
    assert.ok(unload >= 0 && resume > unload, `resumed after the unload: ${methods.join(" ")}`);
    assert.ok(resume < methods.indexOf("turn/start"), methods.join(" "));
  } finally {
    await provider.stop();
  }
});

test("a turn arriving mid-unload waits for the unload before it resumes", async () => {
  const log = join(mkdtempSync(join(tmpdir(), "muxi-agent-codex-unloading-")), "methods.log");
  const provider = new CodexAgentProvider({
    ...testCodexHome(),
    codexBin: FAKE_SERVER,
    env: {
      FAKE_NOTIFS: JSON.stringify([started, completed({ status: "completed", error: null })]),
      FAKE_METHOD_LOG: log,
      FAKE_HOLD_UNSUBSCRIBE: "1",
    },
    turnTimeoutMs: 10_000,
    // Sweeps run by hand; the interval never fires inside the test.
    idleSweepMs: 60_000,
    idleUnloadMs: 0,
  });
  try {
    const thread = await provider.startThread({ cwd: process.cwd() });
    sweepNow(provider);
    await until(() => methodsIn(log).includes("thread/unsubscribe"), "the unload was sent");
    assert.equal(methodsIn(log).includes("unsubscribe:answered"), false, "and is still in flight");
    const turn = (async () => {
      for await (const _ of provider.sendTurn(thread.id, { text: "hi" }));
    })();
    // Let the turn go as far as it can on its own. A resume that skipped the wait
    // is written now, ahead of the release on the same pipe.
    await new Promise((r) => setImmediate(r));
    await rawRequest(provider, "test/release");
    await turn;
    const methods = methodsIn(log);
    assert.ok(
      methods.indexOf("unsubscribe:answered") < methods.indexOf("thread/resume"),
      `the resume waited for the unload to land: ${methods.join(" ")}`,
    );
  } finally {
    await provider.stop();
  }
});

test("a busy thread, or one with a question waiting, is never unloaded", async () => {
  const log = join(mkdtempSync(join(tmpdir(), "muxi-agent-codex-busy-")), "methods.log");
  const provider = new CodexAgentProvider({
    ...testCodexHome(),
    codexBin: FAKE_SERVER,
    // No `turn/completed`: the turn stays in flight with its question open.
    env: { FAKE_NOTIFS: JSON.stringify([started, question]), FAKE_METHOD_LOG: log },
    turnTimeoutMs: 10_000,
    // Sweeps run by hand; with no idle grace, only a hold can keep the thread.
    idleSweepMs: 60_000,
    idleUnloadMs: 0,
  });
  try {
    const thread = await provider.startThread({ cwd: process.cwd() });
    for await (const ev of provider.sendTurn(thread.id, { text: "hi" })) {
      if (ev.type !== "approval.requested") continue;
      // Hide the question for one sweep: only the running turn is left to keep it.
      const approvals = (provider as unknown as { pendingApprovals: Map<unknown, unknown> }).pendingApprovals;
      const parked = new Map(approvals);
      approvals.clear();
      sweepNow(provider);
      for (const [key, value] of parked) approvals.set(key, value);
      await flush(provider);
      assert.equal(methodsIn(log).includes("thread/unsubscribe"), false, "a running turn keeps its thread");
      // Take the turn's hold away: only the open question is left to keep it.
      const live = liveThreadsOf(provider).get(thread.id)!;
      live.busy -= 1;
      live.lastActiveAt = 0;
      sweepNow(provider);
      await flush(provider);
      assert.equal(methodsIn(log).includes("thread/unsubscribe"), false, "an open question keeps its thread");
      assert.equal(liveThreadsOf(provider).has(thread.id), true);
      live.busy += 1;
      break;
    }
  } finally {
    await provider.stop();
  }
});

test("thread/closed drops the thread, so the next turn resumes it", async () => {
  const log = join(mkdtempSync(join(tmpdir(), "muxi-agent-codex-closed-")), "methods.log");
  const closed = { method: "thread/closed", params: { threadId: "t1" } };
  const provider = new CodexAgentProvider({
    ...testCodexHome(),
    codexBin: FAKE_SERVER,
    env: {
      FAKE_NOTIFS: JSON.stringify([started, completed({ status: "completed", error: null }), closed]),
      FAKE_METHOD_LOG: log,
    },
    turnTimeoutMs: 10_000,
  });
  try {
    const thread = await provider.startThread({ cwd: process.cwd() });
    for await (const _ of provider.sendTurn(thread.id, { text: "hi" }));
    await until(() => !liveThreadsOf(provider).has(thread.id), "the closed thread was dropped");
    assert.equal(methodsIn(log).includes("thread/resume"), false);
    for await (const _ of provider.sendTurn(thread.id, { text: "again" }));
    assert.ok(methodsIn(log).includes("thread/resume"), "the next turn loaded it again");
  } finally {
    await provider.stop();
  }
});

test("retiring the app-server waits for the running turn, then the next one spawns fresh", async () => {
  const log = join(mkdtempSync(join(tmpdir(), "muxi-agent-codex-retire-")), "methods.log");
  const provider = new CodexAgentProvider({
    ...testCodexHome(),
    codexBin: FAKE_SERVER,
    env: {
      FAKE_NOTIFS: JSON.stringify([started, completed({ status: "completed", error: null })]),
      FAKE_METHOD_LOG: log,
    },
    turnTimeoutMs: 10_000,
  });
  const running = () => (provider as unknown as { client: { isRunning: boolean } }).client.isRunning;
  try {
    const thread = await provider.startThread({ cwd: process.cwd() });
    for await (const ev of provider.sendTurn(thread.id, { text: "hi" })) {
      if (ev.type !== "turn.started") continue;
      provider.retireAppServer();
      assert.equal(running(), true, "a turn in flight keeps the app-server");
    }
    assert.equal(running(), false, "retired once the turn ended");
    for await (const _ of provider.sendTurn(thread.id, { text: "again" }));
    assert.equal(methodsIn(log).filter((m) => m === "initialize").length, 2, "a fresh app-server served it");
  } finally {
    await provider.stop();
  }
});

// Workspace mode: a loaded thread is unloaded and loaded again with the
// workspace overrides (the shell on, the thread's permission profile, the new
// developer instructions), and every turn on it carries the root as cwd and
// that profile, which denies the credential and protected paths. A Codex that
// can't write the profile keeps the legacy no-network sandbox, which can't
// limit reads. The first turn after the switch opens with the workspace
// steering, since the reload keeps the rollout's old developer message. A
// thread outside workspace mode sends none of it.
test("a workspace thread reloads with the workspace overrides, its next turn opens with the steering, and its turns carry the root's permission profile", async () => {
  for (const profiles of [true, false]) {
    const log = newLog("muxi-agent-codex-workspace-");
    const provider = new CodexAgentProvider({
    ...testCodexHome(),
      codexBin: FAKE_SERVER,
      env: {
        FAKE_NOTIFS: JSON.stringify([started, completed({ status: "completed" })]),
        FAKE_REQUEST_LOG: log,
        ...(profiles ? {} : { FAKE_NO_PROFILES: "1" }),
      },
      turnTimeoutMs: 10_000,
    });
    try {
      const thread = await provider.startThread({ cwd: process.cwd() });
      for await (const _ of provider.sendTurn(thread.id, { text: "before" }));
      await provider.configureWorkspace(thread.id, {
        root: "/wt",
        protectedPaths: ["/data"],
        developerInstructions: "dev + workspace",
        systemPrompt: "",
        instructions: "workspace",
        introduce: true,
        refusal: () => null,
        cacheDir: "/cache",
      });
      for await (const _ of provider.sendTurn(thread.id, { text: "after" }));
      for await (const _ of provider.sendTurn(thread.id, { text: "later" }));
    } finally {
      await provider.stop();
    }
    const requests = requestsIn(log);
    const methods = requests.map((r) => r.method).filter((m) => m && m.startsWith("thread/") || m === "turn/start");
    assert.deepEqual(methods, ["thread/start", "turn/start", "thread/unsubscribe", "thread/resume", "turn/start", "turn/start"]);
    const edits = requests.find((r) => r.method === "config/batchWrite")?.params?.edits as
      | Array<{ keyPath: string; value: unknown }>
      | undefined;
    // Codex fails every turn on a config with profiles but no default.
    assert.deepEqual(edits?.map((e) => e.keyPath), ["default_permissions", "permissions.muxi-agent-workspace-t1"]);
    assert.equal(edits?.[0].value, ":read-only");
    const profile = edits?.[1].value as { extends: string; filesystem: Record<string, string> } | undefined;
    assert.equal(profile?.extends, ":workspace");
    assert.equal(profile?.filesystem["/wt"], "write");
    assert.equal(profile?.filesystem["/wt/.git"], "read", "the shell can't repoint the root's .git");
    for (const denied of ["/data", "/wt/.env", "/wt/.env.*"]) {
      assert.equal(profile?.filesystem[denied], "deny", `the profile denies ${denied}`);
    }
    assert.ok(Object.entries(profile?.filesystem ?? {}).some(([p, a]) => p.endsWith("/.config/gh") && a === "deny"));
    const resume = requests.find((r) => r.method === "thread/resume");
    assert.deepEqual(resume?.params, {
      threadId: "t1",
      excludeTurns: true,
      cwd: "/wt",
      ...(profiles ? { permissions: "muxi-agent-workspace-t1" } : { sandbox: "workspace-write" }),
      approvalPolicy: "on-request",
      developerInstructions: "dev + workspace",
      config: {
        mcp_servers: {},
        web_search: "disabled",
        "agents.enabled": false,
        "features.multi_agent_v2": false,
        "features.shell_tool": true,
        include_permissions_instructions: true,
        "sandbox_workspace_write.network_access": false,
        "shell_environment_policy.set": {
          GIT_CONFIG_COUNT: "2",
          GIT_CONFIG_KEY_0: "credential.helper",
          GIT_CONFIG_VALUE_0: "",
          GIT_CONFIG_KEY_1: "core.hooksPath",
          GIT_CONFIG_VALUE_1: "/dev/null",
        },
      },
    });
    const [before, after, later] = requests.filter((r) => r.method === "turn/start");
    const textOf = (r: typeof before) => (r?.params?.input as Array<{ text?: string }> | undefined)?.[0]?.text;
    assert.deepEqual([textOf(before), textOf(after), textOf(later)], ["before", "workspace\n\nafter", "later"]);
    for (const key of ["cwd", "sandboxPolicy", "permissions", "approvalPolicy"]) {
      assert.equal(key in (before?.params ?? {}), false, `a turn outside workspace mode sends no ${key}`);
    }
    assert.equal(after?.params?.cwd, "/wt");
    if (profiles) {
      assert.equal(after?.params?.permissions, "muxi-agent-workspace-t1");
      assert.equal("sandboxPolicy" in (after?.params ?? {}), false, "a profile and a sandbox policy can't be combined");
    } else {
      assert.deepEqual(after?.params?.sandboxPolicy, {
        type: "workspaceWrite",
        writableRoots: ["/wt", "/cache"],
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      });
    }
  }
});

// A turn can start while the host is still setting up workspace mode (a turn
// it started on its own). The switch then fails, and the host rolls back, so
// the thread must come out of it exactly as it went in.
test("workspace mode refused on a busy thread leaves the thread's later turns unchanged", async () => {
  const log = newLog("muxi-agent-codex-workspace-busy-");
  const provider = new CodexAgentProvider({
    ...testCodexHome(),
    codexBin: FAKE_SERVER,
    env: { FAKE_NOTIFS: JSON.stringify([started, completed({ status: "completed" })]), FAKE_REQUEST_LOG: log },
    turnTimeoutMs: 10_000,
  });
  try {
    const thread = await provider.startThread({ cwd: process.cwd() });
    for await (const ev of provider.sendTurn(thread.id, { text: "first" })) {
      if (ev.type !== "turn.started") continue;
      await assert.rejects(
        provider.configureWorkspace(thread.id, {
          root: "/wt",
          protectedPaths: ["/data"],
          developerInstructions: "dev + workspace",
          systemPrompt: "",
          instructions: "workspace",
          introduce: true,
          refusal: () => null,
          cacheDir: "/cache",
        }),
        /busy/,
      );
    }
    for await (const _ of provider.sendTurn(thread.id, { text: "next" }));
  } finally {
    await provider.stop();
  }
  const next = requestsIn(log).filter((r) => r.method === "turn/start")[1];
  assert.equal((next?.params?.input as Array<{ text?: string }> | undefined)?.[0]?.text, "next");
  for (const key of ["cwd", "sandboxPolicy", "approvalPolicy"]) {
    assert.equal(key in (next?.params ?? {}), false, `no ${key} after the refused switch`);
  }
});

test("a Codex turn.started carries the prompt, the selection and the caller's trigger", async () => {
  const provider = new CodexAgentProvider({
    ...testCodexHome(),
    codexBin: FAKE_SERVER,
    env: { FAKE_NOTIFS: JSON.stringify([started, completed({ status: "completed", error: null })]) },
    turnTimeoutMs: 10_000,
  });
  try {
    const thread = await provider.startThread({ cwd: process.cwd() });
    const events: AgentEvent[] = [];
    const trigger = { kind: "schedule", scheduleId: "nightly" };
    for await (const ev of provider.sendTurn(thread.id, { text: "hi", model: "m1", effort: "low", trigger })) events.push(ev);
    const begun = events.find((e) => e.type === "turn.started");
    assert.ok(begun?.type === "turn.started");
    assert.equal(begun.provider, "codex");
    assert.deepEqual(begun.prompt, { text: "hi" });
    assert.equal(begun.model, "m1");
    assert.deepEqual(begun.trigger, trigger);
  } finally {
    await provider.stop();
  }
});

// A Codex workspace has a shell, so a thread started with web search can't
// switch into one, nor be resumed with the web once it has: refused, not
// quietly narrowed to no web.
test("a Codex thread with web search can't have a workspace", async () => {
  const provider = new CodexAgentProvider({ ...testCodexHome(), codexBin: FAKE_SERVER, turnTimeoutMs: 10_000 });
  const ws = { root: "/wt", developerInstructions: "", systemPrompt: "", instructions: "", introduce: false, refusal: () => null };
  try {
    const web = await provider.startThread({ cwd: process.cwd(), webSearch: true });
    await assert.rejects(provider.configureWorkspace(web.id, ws), new RegExp(CODEX_WEB_AND_SHELL.slice(0, 30)));
  } finally {
    await provider.stop();
  }
  const fresh = new CodexAgentProvider({ ...testCodexHome(), codexBin: FAKE_SERVER, turnTimeoutMs: 10_000 });
  try {
    const plain = await fresh.startThread({ cwd: process.cwd() });
    await fresh.configureWorkspace(plain.id, ws);
    await assert.rejects(fresh.resumeThread(plain.id, { webSearch: true }), /web search/);
  } finally {
    await fresh.stop();
  }
});
