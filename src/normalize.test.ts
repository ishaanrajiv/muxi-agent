import assert from "node:assert/strict";
import { test } from "node:test";

import { AgentEvent } from "./types/index.ts";

import {
  codexErrorCode,
  notificationToEvent,
  requestToApproval,
  turnStatusEvent,
  withoutImageBlocks,
} from "./normalize.ts";
import type { ServerNotification } from "./generated/ServerNotification.ts";
import type { ServerRequest } from "./generated/ServerRequest.ts";
import type { Turn } from "./generated/v2/Turn.ts";

// Fixtures are constructed minimally and cast — we only exercise the fields the
// normalizer reads, not the full generated protocol shape.
const asNotif = (o: unknown) => o as ServerNotification;
const asReq = (o: unknown) => o as ServerRequest;

test("turn/started -> turn.started with turnId from turn.id", () => {
  const ev = notificationToEvent(
    asNotif({ method: "turn/started", params: { threadId: "t1", turn: { id: "turn1" } } }),
  );
  assert.deepEqual(ev, { type: "turn.started", threadId: "t1", turnId: "turn1" });
});

test("thread/started -> thread.started", () => {
  const ev = notificationToEvent(
    asNotif({ method: "thread/started", params: { thread: { id: "t9" } } }),
  );
  assert.deepEqual(ev, { type: "thread.started", threadId: "t9" });
});

test("item/agentMessage/delta -> agent.message.delta", () => {
  const ev = notificationToEvent(
    asNotif({
      method: "item/agentMessage/delta",
      params: { threadId: "t1", turnId: "u1", itemId: "i1", delta: "hi" },
    }),
  );
  assert.deepEqual(ev, { type: "agent.message.delta", threadId: "t1", delta: "hi" });
});

test("item/started(mcpToolCall) -> tool.started", () => {
  const ev = notificationToEvent(
    asNotif({
      method: "item/started",
      params: {
        threadId: "t1",
        turnId: "u1",
        startedAtMs: 0,
        item: {
          type: "mcpToolCall",
          id: "i1",
          server: "lab",
          tool: "search_context",
          status: "inProgress",
          arguments: { query: "signups" },
        },
      },
    }),
  );
  assert.deepEqual(ev, {
    type: "tool.started",
    threadId: "t1",
    itemId: "i1",
    server: "lab",
    tool: "search_context",
    arguments: { query: "signups" },
  });
});

test("thread/tokenUsage/updated -> context.usage (last total minus reasoning)", () => {
  const ev = notificationToEvent(
    asNotif({
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "t1",
        turnId: "u1",
        tokenUsage: {
          total: { totalTokens: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 },
          last: { totalTokens: 50_000, inputTokens: 42_000, cachedInputTokens: 30_000, outputTokens: 8_000, reasoningOutputTokens: 3_000 },
          modelContextWindow: 200_000,
        },
      },
    }),
  );
  assert.deepEqual(ev, {
    type: "context.usage",
    threadId: "t1",
    turnId: "u1",
    usedTokens: 47_000, // 50_000 total − 3_000 reasoning (dropped from next context)
    contextWindow: 200_000,
  });
  // And it's a valid domain event.
  assert.doesNotThrow(() => AgentEvent.parse(ev));
});

test("thread/tokenUsage/updated carries a null context window through", () => {
  const ev = notificationToEvent(
    asNotif({
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "t1",
        turnId: "u1",
        tokenUsage: {
          total: { totalTokens: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 },
          last: { totalTokens: 1_000, inputTokens: 1_000, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 },
          modelContextWindow: null,
        },
      },
    }),
  );
  assert.deepEqual(ev, {
    type: "context.usage",
    threadId: "t1",
    turnId: "u1",
    usedTokens: 1_000,
    contextWindow: null,
  });
});

test("item/completed(mcpToolCall) -> tool.completed", () => {
  const ev = notificationToEvent(
    asNotif({
      method: "item/completed",
      params: {
        threadId: "t1",
        turnId: "u1",
        completedAtMs: 0,
        item: {
          type: "mcpToolCall",
          id: "i1",
          server: "lab",
          tool: "search_context",
          status: "completed",
          arguments: {},
          result: { ok: true },
          error: null,
          durationMs: 42,
        },
      },
    }),
  );
  assert.deepEqual(ev, {
    type: "tool.completed",
    threadId: "t1",
    itemId: "i1",
    server: "lab",
    tool: "search_context",
    status: "completed",
    result: { ok: true },
    durationMs: 42,
  });
});

test("a Codex web search item reports as a builtin webSearch call, query first and pages on completion", () => {
  const item = (action: unknown) => ({
    type: "webSearch",
    id: "ws1",
    query: "monsoon onset 2026",
    action,
    results: [{ title: "IMD", url: "https://mausam.imd.gov.in/" }],
  });
  const at = (method: string, action: unknown) =>
    notificationToEvent(asNotif({ method, params: { threadId: "t1", turnId: "u1", item: item(action) } }));
  assert.deepEqual(at("item/started", null), {
    type: "tool.started",
    threadId: "t1",
    itemId: "ws1",
    server: "builtin",
    tool: "webSearch",
    arguments: { query: "monsoon onset 2026" },
  });
  assert.deepEqual(at("item/completed", { type: "search", query: "monsoon onset 2026" }), {
    type: "tool.completed",
    threadId: "t1",
    itemId: "ws1",
    server: "builtin",
    tool: "webSearch",
    status: "completed",
    result: { queries: ["monsoon onset 2026"], sources: [{ title: "IMD", url: "https://mausam.imd.gov.in/" }] },
  });
});

test("a tool's snapshot image never reaches the stored tool result, on either backend", () => {
  const text = { type: "text", text: '{"ok":true}' };
  const image = { type: "image", data: "/9j/AA==", mimeType: "image/jpeg" };
  // Claude hands over the block list; Codex an MCP result with `content`.
  assert.deepEqual(withoutImageBlocks([text, image]), [text]);
  assert.deepEqual(withoutImageBlocks({ content: [text, image], isError: false }), { content: [text], isError: false });
  assert.deepEqual(withoutImageBlocks({ ok: true }), { ok: true });
});

test("item/completed(agentMessage) -> agent.message.completed", () => {
  const ev = notificationToEvent(
    asNotif({
      method: "item/completed",
      params: {
        threadId: "t1",
        turnId: "u1",
        completedAtMs: 0,
        item: { type: "agentMessage", id: "i2", text: "done", phase: null, memoryCitation: null },
      },
    }),
  );
  assert.deepEqual(ev, {
    type: "agent.message.completed",
    threadId: "t1",
    itemId: "i2",
    text: "done",
  });
});

test("item/completed(reasoning) -> agent.reasoning.completed (summary text)", () => {
  const ev = notificationToEvent(
    asNotif({
      method: "item/completed",
      params: {
        threadId: "t1",
        turnId: "u1",
        completedAtMs: 0,
        item: { type: "reasoning", id: "r1", summary: ["Plan the query", "Run it"], content: [] },
      },
    }),
  );
  assert.deepEqual(ev, {
    type: "agent.reasoning.completed",
    threadId: "t1",
    itemId: "r1",
    text: "Plan the query\n\nRun it",
    summary: [{ label: "Plan the query" }, { label: "Run it" }],
  });
});

test("streamed summary parts join into the text the completed item carries", () => {
  // Part 0 opens silently, part 1 opens a paragraph: the live deltas spell
  // exactly the `summary.join("\n\n")` the completed item states.
  const frames = [
    { method: "item/reasoning/summaryPartAdded", params: { threadId: "t1", turnId: "u1", itemId: "r1", summaryIndex: 0 } },
    { method: "item/reasoning/summaryTextDelta", params: { threadId: "t1", turnId: "u1", itemId: "r1", summaryIndex: 0, delta: "Plan the " } },
    { method: "item/reasoning/summaryTextDelta", params: { threadId: "t1", turnId: "u1", itemId: "r1", summaryIndex: 0, delta: "query" } },
    { method: "item/reasoning/summaryPartAdded", params: { threadId: "t1", turnId: "u1", itemId: "r1", summaryIndex: 1 } },
    { method: "item/reasoning/summaryTextDelta", params: { threadId: "t1", turnId: "u1", itemId: "r1", summaryIndex: 1, delta: "Run it" } },
  ];
  const events = frames.map((f) => notificationToEvent(asNotif(f))).filter((e) => e !== null);
  for (const ev of events) assert.equal(ev.type, "agent.reasoning.delta");
  const text = events.map((e) => (e.type === "agent.reasoning.delta" ? e.delta : "")).join("");
  assert.equal(text, "Plan the query\n\nRun it");
});

test("the raw reasoning trace is not streamed", () => {
  const ev = notificationToEvent(
    asNotif({
      method: "item/reasoning/textDelta",
      params: { threadId: "t1", turnId: "u1", itemId: "r1", contentIndex: 0, delta: "raw" },
    }),
  );
  assert.equal(ev, null);
});

test("item/completed(reasoning) strips invisible bodies from display rows", () => {
  const ev = notificationToEvent(
    asNotif({
      method: "item/completed",
      params: {
        threadId: "t1",
        turnId: "u1",
        completedAtMs: 0,
        item: {
          type: "reasoning",
          id: "r2",
          summary: ["**Planning the query**\n\n<!-- -->"],
          content: [],
        },
      },
    }),
  );
  assert.deepEqual(ev, {
    type: "agent.reasoning.completed",
    threadId: "t1",
    itemId: "r2",
    text: "**Planning the query**\n\n<!-- -->",
    summary: [{ label: "Planning the query" }],
  });
});

test("error -> error.raised with the inner message", () => {
  const ev = notificationToEvent(
    asNotif({
      method: "error",
      params: { threadId: "t1", turnId: "u1", willRetry: false, error: { message: "boom" } },
    }),
  );
  assert.equal(ev?.type, "error.raised");
  if (ev?.type === "error.raised") assert.equal(ev.message, "boom");
});

test("error -> error.raised carries thread/turn ids, a code, and fatal", () => {
  const params = {
    threadId: "t1",
    turnId: "u1",
    willRetry: false,
    error: {
      message: "Signed out",
      codexErrorInfo: "unauthorized",
      additionalDetails: "token expired",
    },
  };
  const ev = notificationToEvent(asNotif({ method: "error", params }));
  assert.deepEqual(ev, {
    type: "error.raised",
    threadId: "t1",
    turnId: "u1",
    // `additionalDetails` is where Codex puts the actionable half of the prose.
    message: "Signed out — token expired",
    code: "not_logged_in",
    fatal: true,
    raw: params,
  });
  assert.doesNotThrow(() => AgentEvent.parse(ev));
});

// Codex retries transient failures itself: a `willRetry` error is a warning
// about a blip it recovered from, so it must NOT close the turn.
test("error with willRetry is a non-fatal warning", () => {
  const ev = notificationToEvent(
    asNotif({
      method: "error",
      params: {
        threadId: "t1",
        turnId: "u1",
        willRetry: true,
        error: {
          message: "connection reset",
          codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: null } },
          additionalDetails: null,
        },
      },
    }),
  );
  assert.equal(ev?.type, "error.raised");
  if (ev?.type !== "error.raised") return;
  assert.equal(ev.fatal, false);
  assert.equal(ev.code, "network");
  assert.equal(ev.message, "connection reset");
});

test("error.raised without ids omits them rather than inventing them", () => {
  const ev = notificationToEvent(
    asNotif({ method: "error", params: { willRetry: false, error: { message: "boom" } } }),
  );
  assert.equal(ev?.type, "error.raised");
  if (ev?.type !== "error.raised") return;
  assert.equal(ev.threadId, undefined);
  assert.equal(ev.turnId, undefined);
  assert.doesNotThrow(() => AgentEvent.parse(ev));
});

test("codexErrorCode maps Codex error kinds onto the neutral codes", () => {
  assert.equal(codexErrorCode("unauthorized"), "not_logged_in");
  assert.equal(codexErrorCode({ httpConnectionFailed: { httpStatusCode: 502 } }), "network");
  assert.equal(codexErrorCode({ responseTooManyFailedAttempts: { httpStatusCode: null } }), "network");
  assert.equal(codexErrorCode("usageLimitExceeded"), "usage_limit");
  assert.equal(codexErrorCode("rateLimitExceeded"), "usage_limit");
  assert.equal(codexErrorCode("serverOverloaded"), "overloaded");
  assert.equal(codexErrorCode("contextWindowExceeded"), "context_full");
  assert.equal(codexErrorCode({ responseStreamDisconnected: { httpStatusCode: 429 } }), "usage_limit");
  assert.equal(codexErrorCode("sandboxError"), "unknown");
  assert.equal(codexErrorCode(null), "unknown");
});

// A signed-out CLI fails at the transport layer: the variant says which leg broke,
// the status says why. 401/403 is who-you-are, not how-the-wire-went — reading only
// the variant told a signed-out user to check their connection.
test("codexErrorCode reads an auth status out of a transport variant", () => {
  assert.equal(
    codexErrorCode({ responseStreamDisconnected: { httpStatusCode: 401 } }),
    "not_logged_in",
  );
  assert.equal(
    codexErrorCode({ responseStreamConnectionFailed: { httpStatusCode: 403 } }),
    "not_logged_in",
  );
  assert.equal(codexErrorCode({ responseStreamDisconnected: { httpStatusCode: 503 } }), "network");
});

const asTurn = (o: unknown) => o as Turn;

test("turnStatusEvent: a failed turn yields a fatal error.raised", () => {
  const ev = turnStatusEvent(
    "t1",
    asTurn({
      id: "turn1",
      status: "failed",
      error: { message: "Signed out", codexErrorInfo: "unauthorized", additionalDetails: null },
    }),
  );
  assert.equal(ev?.type, "error.raised");
  if (ev?.type !== "error.raised") return;
  assert.equal(ev.threadId, "t1");
  assert.equal(ev.turnId, "turn1");
  assert.equal(ev.message, "Signed out");
  assert.equal(ev.code, "not_logged_in");
  assert.equal(ev.fatal, true);
  assert.doesNotThrow(() => AgentEvent.parse(ev));
});

test("turnStatusEvent: a failed turn with no reason still errors", () => {
  const ev = turnStatusEvent("t1", asTurn({ id: "turn1", status: "failed", error: null }));
  assert.equal(ev?.type, "error.raised");
  if (ev?.type !== "error.raised") return;
  assert.equal(ev.code, "turn_failed");
  assert.equal(ev.fatal, true);
  assert.ok(ev.message.length > 0);
});

test("turnStatusEvent: interrupted is always a warning, completed is silent", () => {
  const interrupted = turnStatusEvent(
    "t1",
    asTurn({
      id: "turn1",
      status: "interrupted",
      error: { message: "stopped", codexErrorInfo: null, additionalDetails: null },
    }),
  );
  assert.equal(interrupted?.type, "error.raised");
  if (interrupted?.type === "error.raised") {
    assert.equal(interrupted.code, "interrupted");
    assert.equal(interrupted.fatal, false);
  }
  // A Stop with no reason still says the turn was cut short.
  const bare = turnStatusEvent("t1", asTurn({ id: "turn1", status: "interrupted", error: null }));
  assert.ok(bare?.type === "error.raised" && bare.code === "interrupted" && bare.fatal === false);
  assert.match(bare.message, /Stopped on your request/);
  assert.equal(turnStatusEvent("t1", asTurn({ id: "turn1", status: "completed", error: null })), null);
});

test("item/started(userMessage) -> turn.steer.read only for a message the caller tagged", () => {
  const userMessage = (clientId: string | null) =>
    notificationToEvent(
      asNotif({
        method: "item/started",
        params: { threadId: "t1", turnId: "u1", startedAtMs: 0, item: { type: "userMessage", id: "m1", clientId, content: [] } },
      }),
    );
  assert.deepEqual(userMessage("sub-1"), { type: "turn.steer.read", threadId: "t1", steerId: "sub-1" });
  assert.equal(userMessage(null), null, "the turn's own prompt is an echo, not a steer");
});

test("unmapped notifications are dropped (null)", () => {
  assert.equal(
    notificationToEvent(asNotif({ method: "account/rateLimits/updated", params: {} })),
    null,
  );
  assert.equal(
    notificationToEvent(
      asNotif({
        method: "item/started",
        params: { threadId: "t1", turnId: "u1", startedAtMs: 0, item: { type: "reasoning", id: "r1", summary: [], content: [] } },
      }),
    ),
    null,
  );
});

test("every produced event validates against the AgentEvent contract", () => {
  const ev = notificationToEvent(
    asNotif({ method: "turn/completed", params: { threadId: "t1", turn: { id: "turn1" } } }),
  );
  assert.doesNotThrow(() => AgentEvent.parse(ev));
});

test("requestToApproval auto-rejects the agent's native write tools (read-only lockdown)", () => {
  // Shell / file-edit / permission-escalation requests are intentionally NOT
  // surfaced — requestToApproval returns null so the provider auto-rejects them.
  for (const method of [
    "execCommandApproval",
    "applyPatchApproval",
    "item/commandExecution/requestApproval",
    "item/fileChange/requestApproval",
    "item/permissions/requestApproval",
  ]) {
    assert.equal(
      requestToApproval(asReq({ method, id: 5, params: { conversationId: "t1" } })),
      null,
      `${method} must auto-reject`,
    );
  }
});

test("native shell and edit requests surface on repo threads only, in the repo gate's shapes", () => {
  const command = asReq({
    method: "item/commandExecution/requestApproval",
    id: 7,
    params: { threadId: "t1", turnId: "u1", itemId: "c1", command: "uv run pytest", cwd: "/wt", reason: "tests" },
  });
  const edit = asReq({
    method: "item/fileChange/requestApproval",
    id: 8,
    params: { threadId: "t1", turnId: "u1", itemId: "f1", grantRoot: "/elsewhere" },
  });
  const changes = new Map([
    ["f1", [{ path: "/wt/a.py", kind: { type: "update", move_path: "/wt/b.py" } }, { path: "/wt/c.py", kind: { type: "add" } }]],
  ]);
  const cases: Array<[string, ServerRequest, boolean, unknown]> = [
    ["command off a repo thread", command, false, null],
    ["edit off a repo thread", edit, false, null],
    [
      "command on a workspace thread",
      command,
      true,
      { kind: "command", detail: { command: "uv run pytest", cwd: "/wt", reason: "tests", itemId: "c1", _meta: { native_tool: "commandExecution" } } },
    ],
    [
      "edit on a workspace thread, with the move destination and grant root",
      edit,
      true,
      {
        kind: "fileChange",
        detail: {
          changes: [
            { path: "/wt/a.py", kind: "update" },
            { path: "/wt/b.py", kind: "add" },
            { path: "/wt/c.py", kind: "add" },
          ],
          grantRoot: "/elsewhere",
          itemId: "f1",
          _meta: { native_tool: "fileChange" },
        },
      },
    ],
  ];
  for (const [name, req, workspaceMode, want] of cases) {
    const got = requestToApproval(req, {
      workspaceMode,
      fileChanges: (id) => changes.get(id) as never,
    });
    assert.deepEqual(got ? { kind: got.kind, detail: got.detail } : null, want, name);
  }
  // The legacy and escalation methods stay refused even on a workspace thread.
  for (const method of ["execCommandApproval", "applyPatchApproval", "item/permissions/requestApproval"]) {
    assert.equal(requestToApproval(asReq({ method, id: 9, params: { threadId: "t1" } }), { workspaceMode: true }), null, method);
  }
});

test("requestToApproval normalizes MCP elicitation", () => {
  const req = requestToApproval(
    asReq({
      method: "mcpServer/elicitation/request",
      id: 6,
      params: { threadId: "t1", turnId: "u1", serverName: "lab", mode: "form", message: "ok?" },
    }),
  );
  assert.ok(req);
  assert.equal(req.kind, "mcpElicitation");
  assert.equal(req.threadId, "t1");
  assert.equal(req.turnId, "u1");
});

// The Inbox row for an ask_user gate used to read "MCP server requests
// confirmation" on Codex while Claude showed the question itself.
test("an ask_user elicitation is summarized by its question, on both wires", () => {
  const summaryFor = (envelope: unknown) =>
    requestToApproval(
      asReq({
        method: "mcpServer/elicitation/request",
        id: 7,
        params: { threadId: "t1", serverName: "lab", message: JSON.stringify(envelope) },
      }),
    )?.summary;

  assert.equal(
    summaryFor({
      kind: "question",
      version: 2,
      questions: [{ question: "Which definition of active users?" }, { question: "Which window?" }],
    }),
    "Which definition of active users? (+1 more)",
  );
  // The v1 single-question wire.
  assert.equal(
    summaryFor({ kind: "question", question: "Which app?" }),
    "Which app?",
  );
  // Anything that isn't the envelope keeps the static per-kind sentence.
  assert.equal(
    summaryFor({ kind: "other", question: "Which app?" }),
    "MCP server requests confirmation",
  );
  assert.equal(
    requestToApproval(
      asReq({
        method: "mcpServer/elicitation/request",
        id: 8,
        params: { threadId: "t1", message: 'Allow the lab MCP server to run tool "save_note"?' },
      }),
    )?.summary,
    "MCP server requests confirmation",
  );
});

test("requestToApproval still surfaces userInput + elicitation (the kept methods)", () => {
  assert.equal(
    requestToApproval(asReq({ method: "item/tool/requestUserInput", id: 3, params: {} }))?.kind,
    "userInput",
  );
  assert.equal(
    requestToApproval(
      asReq({ method: "mcpServer/elicitation/request", id: 4, params: { threadId: "t1" } }),
    )?.kind,
    "mcpElicitation",
  );
});

test("requestToApproval drops non-user-facing server requests", () => {
  assert.equal(
    requestToApproval(asReq({ method: "item/tool/call", id: 4, params: {} })),
    null,
  );
});

test("turn/plan/updated -> agent.plan.updated (native update_plan, camelCase status mapped)", () => {
  const ev = notificationToEvent(
    asNotif({
      method: "turn/plan/updated",
      params: {
        threadId: "t1",
        turnId: "u1",
        explanation: "decomposing the ask",
        plan: [
          { step: "part 1 (run 20260812_xyz): rainfall fell 8.4%", status: "completed" },
          { step: "part 2: split by town", status: "inProgress" },
          { step: "BLOCKED: part 3 — no table", status: "pending" },
        ],
      },
    }),
  );
  assert.deepEqual(ev, {
    type: "agent.plan.updated",
    threadId: "t1",
    provider: "codex",
    parts: [
      { text: "part 1 (run 20260812_xyz): rainfall fell 8.4%", status: "completed" },
      { text: "part 2: split by town", status: "in_progress" },
      { text: "BLOCKED: part 3 — no table", status: "pending" },
    ],
  });
  assert.doesNotThrow(() => AgentEvent.parse(ev));
});

test("configWarning -> non-fatal error.raised (an invalid config drops ALL managed settings)", () => {
  const ev = notificationToEvent(
    asNotif({
      method: "configWarning",
      params: {
        summary: "Invalid configuration; using defaults.",
        details:
          "config.toml:2:15: invalid type: boolean `true`, expected struct UpdatePlanToolConfig",
        path: "/home/codex-home/config.toml",
        range: { start: { line: 2, column: 15 }, end: { line: 2, column: 19 } },
      },
    }),
  );
  assert.equal(ev?.type, "error.raised");
  assert.equal(ev.fatal, false);
  assert.equal(ev.code, "config_invalid");
  assert.match(ev.message, /Invalid configuration/);
  assert.match(ev.message, /UpdatePlanToolConfig/);
  assert.doesNotThrow(() => AgentEvent.parse(ev));
});

// Recorded from codex 0.156.1 spawned in a folder holding a `.codex` directory:
// a notice about project-local config, with no file of ours behind it.
test("a configWarning with no path is not surfaced", () => {
  const ev = notificationToEvent(
    asNotif({
      method: "configWarning",
      params: {
        summary:
          "Project-local config, hooks, and exec policies are disabled in the following folders until the project is trusted, but skills still load.\n    1. /ws/.codex\n",
        details: null,
      },
    }),
  );
  assert.equal(ev, null);
});

test("a reroute and a deprecation notice are non-fatal notes that honor the contract", () => {
  const rerouted = notificationToEvent(
    asNotif({
      method: "model/rerouted",
      params: { threadId: "t1", turnId: "turn1", fromModel: "gpt-5.6-sol", toModel: "gpt-5.4", reason: "highRiskCyberActivity" },
    }),
  );
  assert.ok(rerouted?.type === "error.raised");
  assert.equal(rerouted.code, "model_rerouted");
  assert.equal(rerouted.fatal, false);
  assert.equal(rerouted.turnId, "turn1");
  assert.equal(
    rerouted.message,
    "Codex answered this turn with gpt-5.4 instead of gpt-5.6-sol, because it flagged the request as possible high-risk cyber activity.",
  );
  assert.doesNotThrow(() => AgentEvent.parse(rerouted));

  const notice = notificationToEvent(
    asNotif({ method: "deprecationNotice", params: { summary: "The foo setting is deprecated.", details: "Use bar." } }),
  );
  assert.ok(notice?.type === "error.raised");
  assert.equal(notice.code, "deprecated");
  assert.equal(notice.fatal, false);
  assert.equal(notice.threadId, undefined, "thread-less: the provider holds it for the next turn");
  assert.equal(notice.message, "Codex deprecation notice: The foo setting is deprecated. Use bar.");
  assert.doesNotThrow(() => AgentEvent.parse(notice));
});

test("requestToApproval names the tool a Codex MCP tool-call confirmation asks to run", () => {
  const got = requestToApproval(
    asReq({
      method: "mcpServer/elicitation/request",
      id: 7,
      params: {
        threadId: "t1",
        turnId: "u1",
        serverName: "lab",
        mode: "form",
        message: "Allow the lab MCP server to run tool \"echo\"?",
        _meta: { codex_approval_kind: "mcp_tool_call", tool_name: "echo" },
      },
    }),
  );
  assert.equal(got?.kind, "mcpElicitation");
  assert.equal(got?.summary, 'Run lab tool "echo"');
});
