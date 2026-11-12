/**
 * Provider parity for `runUtilityTurn` (title generation): both backends must
 * reuse the exact main-turn model, produce structured output, expose no
 * tools/MCP/workspace context, persist no session, and honor the short
 * timeout. Codex is driven through a scripted fake app-server client; Claude
 * through the `queryFn` test seam — no CLI is spawned in either case.
 */

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";

import type { query } from "@anthropic-ai/claude-agent-sdk";

import { CodexAgentProvider } from "./codex-provider.ts";
import { testCodexHome } from "./testing/codex-home.ts";
import { ClaudeAgentProvider } from "./claude-provider.ts";
import type { UtilityTurnInput } from "./provider.ts";

const TITLE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["title"],
  properties: { title: { type: "string", minLength: 3, maxLength: 80 } },
};

function utilityInput(overrides: Partial<UtilityTurnInput> = {}): UtilityTurnInput {
  return {
    model: "main-turn-model",
    effort: "low",
    cwd: "/workspace",
    systemInstructions: "You write a short title.",
    prompt: "Question:\nWhy did DAU dip?",
    outputSchema: TITLE_SCHEMA,
    timeoutMs: 5_000,
    ...overrides,
  };
}

// ── Codex ────────────────────────────────────────────────────────────────────

/** A scripted stand-in for the Codex app-server client: captures thread/turn
 *  params and (unless `hang`) completes the turn with a structured answer. */
class FakeCodexClient extends EventEmitter {
  isRunning = true;
  threadStarts: Record<string, unknown>[] = [];
  turnStarts: Record<string, unknown>[] = [];
  requests: Array<{ method: string; params: unknown }> = [];
  hang = false;

  async threadStart(params: Record<string, unknown>) {
    this.threadStarts.push(params);
    return { thread: { id: "utility-thread-1", cwd: null, status: "idle" } };
  }

  /** Token counts to report on `thread/tokenUsage/updated`, when the app-server
   *  build sends them (older ones don't). */
  tokenUsage: Record<string, number> | null = null;

  async turnStart(params: Record<string, unknown>) {
    this.turnStarts.push(params);
    if (!this.hang) {
      setImmediate(() => {
        if (this.tokenUsage) {
          this.emit("notification", {
            method: "thread/tokenUsage/updated",
            params: {
              threadId: params.threadId,
              turnId: "turn-1",
              tokenUsage: {
                total: this.tokenUsage,
                last: this.tokenUsage,
                modelContextWindow: 400_000,
              },
            },
          });
        }
        this.emit("notification", {
          method: "item/completed",
          params: {
            threadId: params.threadId,
            item: { type: "agentMessage", id: "m1", text: '{"title":"Codex Utility Title"}' },
          },
        });
        this.emit("notification", {
          method: "turn/completed",
          params: { threadId: params.threadId, turn: { id: "turn-1" } },
        });
      });
    }
    return { turn: { id: "turn-1" } };
  }

  async request(method: string, params: unknown) {
    this.requests.push({ method, params });
    return {};
  }
}

function codexWithFakeClient(): { provider: CodexAgentProvider; client: FakeCodexClient } {
  const provider = new CodexAgentProvider({
    ...testCodexHome(), turnTimeoutMs: 60_000 });
  const client = new FakeCodexClient();
  // Reach through the seam-less internals: swap the client and mark the
  // app-server session live so ensureStarted() is a no-op.
  (provider as unknown as { client: unknown }).client = client;
  (provider as unknown as { started: boolean }).started = true;
  return { provider, client };
}

test("codex: utility turn is ephemeral, tool-free, and reuses the exact model", async () => {
  const { provider, client } = codexWithFakeClient();
  const result = await provider.runUtilityTurn(utilityInput());

  assert.deepEqual(result.output, { title: "Codex Utility Title" });
  assert.equal(client.threadStarts.length, 1);
  const start = client.threadStarts[0];
  // Exact main-turn model, no silent switch.
  assert.equal(start.model, "main-turn-model");
  // No persisted session, no workspace, no tools, no MCP.
  assert.equal(start.ephemeral, true);
  // These three are experimentalApi-gated in the app-server: sending them —
  // even as empty arrays — rejects thread/start with -32600, so the utility
  // turn must not include them at all (their defaults are what we want).
  assert.equal("environments" in start, false);
  assert.equal("runtimeWorkspaceRoots" in start, false);
  assert.equal("dynamicTools" in start, false);
  assert.equal(start.sandbox, "read-only");
  assert.equal(start.approvalPolicy, "never");
  // No MCP servers (the dedicated CODEX_HOME has none either) and no web search.
  const config = start.config as Record<string, unknown>;
  assert.equal("mcp_servers" in config, false);
  assert.equal(config.web_search, "disabled");
  // Minimal prompt: the base instructions are EXACTLY the caller's system
  // instructions — no coding-agent base, skills, or project context around them.
  assert.equal(start.baseInstructions, "You write a short title.");

  assert.equal(client.turnStarts.length, 1);
  const turn = client.turnStarts[0];
  assert.equal(turn.model, "main-turn-model");
  assert.equal(turn.effort, "low");
  assert.equal(turn.summary, "none");
  assert.deepEqual(turn.outputSchema, TITLE_SCHEMA);
});

// Codex reports a turn's token counts on `thread/tokenUsage/updated`; the
// utility turn used to drop them, so a title's cost was unattributable.
test("codex: a utility turn reports the token counts the app-server sent", async () => {
  const { provider, client } = codexWithFakeClient();
  client.tokenUsage = {
    totalTokens: 1_240,
    inputTokens: 1_200,
    cachedInputTokens: 800,
    outputTokens: 40,
    reasoningOutputTokens: 0,
  };
  const result = await provider.runUtilityTurn(utilityInput());
  assert.equal(result.inputTokens, 1_200);
  assert.equal(result.outputTokens, 40);
});

test("codex: a build that reports no token usage leaves the counts absent", async () => {
  const { provider } = codexWithFakeClient();
  const result = await provider.runUtilityTurn(utilityInput());
  assert.equal(result.inputTokens, undefined);
  assert.equal(result.outputTokens, undefined);
});

test("codex: the ephemeral utility thread never lingers in the live set", async () => {
  const { provider, client } = codexWithFakeClient();
  const live = (provider as unknown as { liveThreads: Set<string> }).liveThreads;
  await provider.runUtilityTurn(utilityInput());
  await provider.runUtilityTurn(utilityInput());
  assert.equal(client.threadStarts.length, 2);
  assert.equal(live.size, 0, "utility threads must be forgotten after the turn");
  // ...and unloaded from the app-server, which otherwise keeps each one loaded.
  assert.deepEqual(
    client.requests.filter((r) => r.method === "thread/unsubscribe").map((r) => r.params),
    [{ threadId: "utility-thread-1" }, { threadId: "utility-thread-1" }],
  );
});

test("codex: a hung utility turn fails at the caller's timeout, not the default", { timeout: 5_000 }, async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { provider, client } = codexWithFakeClient();
  client.hang = true;
  const startedAt = Date.now();
  const turn = provider.runUtilityTurn(utilityInput({ timeoutMs: 100 }));
  // The provider arms its turn timer before it sends turn/start.
  while (client.turnStarts.length === 0) await new Promise((r) => setImmediate(r));
  t.mock.timers.tick(100);
  await assert.rejects(turn, /timed out after 100ms/);
  // Well under the provider's 60s default — the per-call override is honored.
  assert.ok(Date.now() - startedAt < 5_000);
  t.mock.timers.reset();
});

// ── Claude ───────────────────────────────────────────────────────────────────

type QueryArgs = Parameters<typeof query>[0];

/** Script a `query()` double: capture the args and yield a canned success. */
function fakeQuery(captured: QueryArgs[], opts: { hang?: boolean } = {}): typeof query {
  return ((args: QueryArgs) => {
    captured.push(args);
    async function* run() {
      if (opts.hang) {
        // Respect the abort signal like the real SDK: reject when aborted.
        await new Promise((_, reject) => {
          args.options?.abortController?.signal.addEventListener("abort", () =>
            reject(new Error("aborted by AbortController")),
          );
        });
      }
      yield {
        type: "assistant",
        message: { content: [{ type: "text", text: '{"title":"Claude Utility Title"}' }] },
      };
      yield {
        type: "result",
        subtype: "success",
        is_error: false,
        result: '{"title":"Claude Utility Title"}',
        structured_output: { title: "Claude Utility Title" },
        usage: { input_tokens: 100, output_tokens: 10 },
      };
    }
    return run();
  }) as unknown as typeof query;
}

function claudeWithFakeQuery(opts: { hang?: boolean } = {}) {
  const captured: QueryArgs[] = [];
  const provider = new ClaudeAgentProvider({
    queryFn: fakeQuery(captured, opts),
  });
  return { provider, captured };
}

test("claude: utility turn is session-free, tool-free, and reuses the exact model", async () => {
  const { provider, captured } = claudeWithFakeQuery();
  const result = await provider.runUtilityTurn(utilityInput({ effort: "low" }));

  assert.deepEqual(result.output, { title: "Claude Utility Title" });
  assert.equal(result.inputTokens, 100);
  assert.equal(result.outputTokens, 10);

  assert.equal(captured.length, 1);
  const options = captured[0].options ?? {};
  // Exact main-turn model, no silent switch.
  assert.equal(options.model, "main-turn-model");
  // No persisted session, no tools, no MCP, no local settings/skills.
  assert.equal(options.persistSession, false);
  assert.equal(options.maxTurns, 1);
  assert.deepEqual(options.tools, []);
  assert.deepEqual(options.mcpServers, {});
  assert.deepEqual(options.settingSources, []);
  // Auto-memory ignores settingSources, so it is switched off on its own.
  assert.deepEqual(options.settings, { autoMemoryEnabled: false });
  assert.equal(options.strictMcpConfig, true);
  assert.equal(options.permissionMode, "dontAsk");
  // Minimal prompt + structured output.
  assert.equal(options.systemPrompt, "You write a short title.");
  assert.deepEqual(options.outputFormat, { type: "json_schema", schema: TITLE_SCHEMA });
  assert.deepEqual(options.thinking, { type: "disabled" });
});

test("claude: a failed utility turn reports the CLI's sentence, not the subtype", async () => {
  const failing = ((args: QueryArgs) => {
    void args;
    async function* run() {
      yield {
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        errors: ["Credit balance is too low"],
        usage: { input_tokens: 1, output_tokens: 0 },
      };
    }
    return run();
  }) as unknown as typeof query;
  const provider = new ClaudeAgentProvider({ queryFn: failing });
  await assert.rejects(provider.runUtilityTurn(utilityInput()), /Credit balance is too low/);
});

test("claude: a success without structured output is a failure", async () => {
  const unstructured = ((args: QueryArgs) => {
    void args;
    async function* run() {
      yield {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "Sorry, I can't title that.",
        usage: { input_tokens: 1, output_tokens: 5 },
      };
    }
    return run();
  }) as unknown as typeof query;
  const provider = new ClaudeAgentProvider({ queryFn: unstructured });
  await assert.rejects(provider.runUtilityTurn(utilityInput()), /no structured output/);
});

test("claude: a hung utility turn is aborted at the caller's timeout", { timeout: 5_000 }, async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { provider, captured } = claudeWithFakeQuery({ hang: true });
  const startedAt = Date.now();
  const turn = provider.runUtilityTurn(utilityInput({ timeoutMs: 100 }));
  // The abort timer is armed in the same synchronous step as the query() call.
  while (captured.length === 0) await new Promise((r) => setImmediate(r));
  t.mock.timers.tick(100);
  await assert.rejects(turn);
  assert.ok(Date.now() - startedAt < 5_000);
  t.mock.timers.reset();
});
