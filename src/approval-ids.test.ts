/**
 * The server registers the Codex and Claude providers side by side and stores
 * every approval they raise in one table keyed by the id they mint. Both used to
 * count from "1", so the second backend's first approval overwrote the first's
 * row and a decision in one chat settled the other chat's gate. Driven without
 * a CLI: Claude through its `queryFn` seam, Codex through a stand-in client.
 */

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";

import type { query } from "@anthropic-ai/claude-agent-sdk";
import type { AgentEvent } from "./types/index.ts";

import { ClaudeAgentProvider } from "./claude-provider.ts";
import { CodexAgentProvider } from "./codex-provider.ts";
import { testCodexHome } from "./testing/codex-home.ts";
import { PendingApprovalNotFoundError } from "./shared.ts";

type QueryArgs = Parameters<typeof query>[0];
type ApprovalRequest = Extract<AgentEvent, { type: "approval.requested" }>["request"];

/** Raise one approval on a Claude turn and return it with its turn still parked. */
async function claudeApproval(): Promise<{
  provider: ClaudeAgentProvider;
  request: ApprovalRequest;
  finish: Promise<void>;
}> {
  const provider = new ClaudeAgentProvider({
    queryFn: ((args: QueryArgs) =>
      (async function* () {
        yield { type: "system", subtype: "init", mcp_servers: [{ name: "lab", status: "connected" }] };
        await args.options?.onElicitation?.(
          { serverName: "lab", message: "Which unit?", mode: "form", requestedSchema: { type: "object" } },
          { signal: new AbortController().signal, requestId: "elicit-1" },
        );
        yield { type: "result", subtype: "success", is_error: false, result: "ok", usage: { input_tokens: 1, output_tokens: 1 } };
      })()) as unknown as typeof query,
  });
  const thread = await provider.startThread({ cwd: "/tmp" } as Parameters<ClaudeAgentProvider["startThread"]>[0]);
  let resolveRequest!: (r: ApprovalRequest) => void;
  const requested = new Promise<ApprovalRequest>((r) => (resolveRequest = r));
  const finish = (async () => {
    for await (const ev of provider.sendTurn(thread.id, { text: "q" } as Parameters<ClaudeAgentProvider["sendTurn"]>[1])) {
      if (ev.type === "approval.requested") resolveRequest(ev.request);
    }
  })();
  return { provider, request: await requested, finish };
}

/** The slice of the app-server client a Codex turn with one question touches. */
class StandInCodexClient extends EventEmitter {
  isRunning = true;
  readonly replies: unknown[] = [];
  async start(): Promise<void> {}
  async initialize(): Promise<void> {}
  async stop(): Promise<void> {}
  async request(): Promise<unknown> {
    return {};
  }
  async threadStart(): Promise<unknown> {
    return { thread: { id: "t1", cwd: "/tmp", status: "idle" }, model: "gpt" };
  }
  async turnStart(): Promise<unknown> {
    setImmediate(() => {
      this.emit("notification", { method: "turn/started", params: { threadId: "t1", turn: { id: "turn1" } } });
      this.emit("approval", {
        id: 1,
        method: "mcpServer/elicitation/request",
        params: { threadId: "t1", turnId: "turn1", serverName: "lab", message: "Which unit?" },
      });
    });
    return { turn: { id: "turn1" } };
  }
  async resolveApproval(rawId: unknown): Promise<void> {
    this.replies.push(rawId);
    setImmediate(() =>
      this.emit("notification", {
        method: "turn/completed",
        params: { threadId: "t1", turn: { id: "turn1", status: "completed", error: null } },
      }),
    );
  }
}

async function codexApproval(): Promise<{
  provider: CodexAgentProvider;
  client: StandInCodexClient;
  request: ApprovalRequest;
  finish: Promise<void>;
}> {
  const provider = new CodexAgentProvider({
    ...testCodexHome(), turnTimeoutMs: 10_000 });
  const client = new StandInCodexClient();
  (provider as unknown as { client: StandInCodexClient }).client = client;
  const thread = await provider.startThread({ cwd: "/tmp" });
  let resolveRequest!: (r: ApprovalRequest) => void;
  const requested = new Promise<ApprovalRequest>((r) => (resolveRequest = r));
  const finish = (async () => {
    for await (const ev of provider.sendTurn(thread.id, { text: "q" })) {
      if (ev.type === "approval.requested") resolveRequest(ev.request);
    }
  })();
  return { provider, client, request: await requested, finish };
}

test("a Codex and a Claude approval never share an id, so each decision reaches its own chat", async () => {
  const claude = await claudeApproval();
  const codex = await codexApproval();
  const decline = { action: "decline" } as const;
  let crossed: unknown;
  let codexRepliesAfterCrossedDecision: unknown[] = [];
  try {
    // A decision carrying the Codex id, sent to Claude. Under the old counters
    // both first ids were "1", so this settled Claude's own gate.
    crossed = await claude.provider.resolveApproval(codex.request.requestId, decline).then(
      () => "settled a Claude gate",
      (err: unknown) => err,
    );
    codexRepliesAfterCrossedDecision = [...codex.client.replies];
  } finally {
    await Promise.allSettled([
      claude.provider.resolveApproval(claude.request.requestId, decline),
      codex.provider.resolveApproval(codex.request.requestId, decline),
    ]);
    await Promise.all([claude.finish, codex.finish]);
    await codex.provider.stop();
  }

  assert.notEqual(String(codex.request.requestId), String(claude.request.requestId));
  assert.ok(crossed instanceof PendingApprovalNotFoundError, `Claude took the Codex id: ${String(crossed)}`);
  assert.deepEqual(codexRepliesAfterCrossedDecision, [], "the Codex question was still waiting");
  assert.deepEqual(codex.client.replies, [1], "the Codex decision reached the Codex app-server");
});
