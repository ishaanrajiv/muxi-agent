/**
 * MCP registration on the Claude backend: each thread's `mcpServers` register
 * with the CLI as streamable-HTTP servers under their own names, with
 * `alwaysLoad`, and nothing else is registered. Driven through the `queryFn`
 * seam; no CLI is spawned.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { query } from "@anthropic-ai/claude-agent-sdk";

import { ClaudeAgentProvider } from "./claude-provider.ts";
import type { McpServerConfig, TurnStreamEvent, StartThreadInput, TurnInput } from "./types/index.ts";

type QueryArgs = Parameters<typeof query>[0];

/** A `query()` double that captures the options and yields one trivial success. */
function fakeQuery(captured: QueryArgs[]): typeof query {
  return ((args: QueryArgs) => {
    captured.push(args);
    async function* run() {
      yield {
        type: "assistant",
        uuid: "u1",
        message: { content: [{ type: "text", text: "ok" }] },
      };
      yield {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "ok",
        usage: { input_tokens: 1, output_tokens: 1 },
      };
    }
    return run();
  }) as unknown as typeof query;
}

/** Run one turn and return the `options` the provider handed the SDK. */
async function sendTurnOptions(mcpServers?: Record<string, McpServerConfig>) {
  const captured: QueryArgs[] = [];
  const provider = new ClaudeAgentProvider({ queryFn: fakeQuery(captured) });
  const thread = await provider.startThread({ cwd: "/ws", ...(mcpServers ? { mcpServers } : {}) } as StartThreadInput);
  for await (const _ of provider.sendTurn(thread.id, { text: "q" } as TurnInput)) {
    // drain: the background producer runs the fake query and settles the turn
  }
  return captured[0]!.options ?? {};
}

test("a thread with no MCP servers registers none, strictly", async () => {
  const options = await sendTurnOptions();
  assert.deepEqual(options.mcpServers ?? {}, {});
  assert.equal(options.strictMcpConfig, true);
});

test("each thread MCP server registers by its own name as streamable HTTP, alwaysLoad, headers kept", async () => {
  const options = await sendTurnOptions({
    lab: { type: "http", url: "http://127.0.0.1:8787/mcp" },
    notes: { type: "http", url: "http://127.0.0.1:8788/mcp", headers: { authorization: "Bearer t" } },
  });
  const servers = options.mcpServers as Record<string, unknown>;
  assert.deepEqual(Object.keys(servers), ["lab", "notes"]);
  assert.deepEqual(servers.lab, { type: "http", url: "http://127.0.0.1:8787/mcp", alwaysLoad: true });
  assert.deepEqual(servers.notes, {
    type: "http",
    url: "http://127.0.0.1:8788/mcp",
    headers: { authorization: "Bearer t" },
    alwaysLoad: true,
  });
  assert.equal(options.strictMcpConfig, true);
});

test("tool calls surface under the server's own name", async () => {
  const provider = new ClaudeAgentProvider({
    queryFn: (() => {
      async function* run() {
        yield { type: "system", subtype: "init", mcp_servers: [{ name: "lab", status: "connected" }] };
        yield {
          type: "assistant",
          uuid: "u1",
          message: { content: [{ type: "tool_use", id: "t1", name: "mcp__lab__echo", input: { text: "hi" } }] },
        };
        yield { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "hi" }] } };
        yield {
          type: "result",
          subtype: "success",
          is_error: false,
          result: "ok",
          usage: { input_tokens: 1, output_tokens: 1 },
        };
      }
      return run();
    }) as unknown as typeof query,
  });
  const thread = await provider.startThread({
    cwd: "/ws",
    mcpServers: { lab: { type: "http", url: "http://127.0.0.1:8787/mcp" } },
  } as StartThreadInput);
  const events: TurnStreamEvent[] = [];
  for await (const ev of provider.sendTurn(thread.id, { text: "q" } as TurnInput)) events.push(ev);
  const tools = events.filter((e) => e.type === "tool.started" || e.type === "tool.completed");
  assert.deepEqual(
    tools.map((e) => [e.type, "server" in e ? e.server : undefined, "tool" in e ? e.tool : undefined]),
    [
      ["tool.started", "lab", "echo"],
      ["tool.completed", "lab", "echo"],
    ],
  );
  assert.equal(events.some((e) => e.type === "error.raised"), false);
});

// ---- Per-turn MCP servers (TurnInput.mcpServers) --------------------------------------------

const THREAD_LAB = { lab: { type: "http" as const, url: "http://127.0.0.1:8787/mcp/thread-token" } };
const TURN_LAB = { lab: { type: "http" as const, url: "http://127.0.0.1:8787/mcp/thread-token/turn-nonce-1" } };

async function turns(provider: ClaudeAgentProvider, threadId: string, inputs: TurnInput[]) {
  for (const input of inputs) for await (const _ of provider.sendTurn(threadId, input));
}

test("a turn's mcpServers replace the thread's for that turn only", async () => {
  const captured: QueryArgs[] = [];
  const provider = new ClaudeAgentProvider({ queryFn: fakeQuery(captured) });
  const thread = await provider.startThread({ cwd: "/ws", mcpServers: THREAD_LAB } as StartThreadInput);
  await turns(provider, thread.id, [
    { text: "1", mcpServers: TURN_LAB } as TurnInput,
    { text: "2" } as TurnInput,
    { text: "3", mcpServers: {} } as TurnInput,
    { text: "4" } as TurnInput,
  ]);
  const urls = captured.map((c) => Object.values((c.options?.mcpServers ?? {}) as Record<string, { url: string }>).map((s) => s.url));
  assert.deepEqual(urls, [[TURN_LAB.lab.url], [THREAD_LAB.lab.url], [], [THREAD_LAB.lab.url]], "override, back, none, back");
  for (const c of captured) assert.equal(c.options?.strictMcpConfig, true);
});

test("an override survives neither a cold resume nor a fork, and applies on both", async () => {
  const captured: QueryArgs[] = [];
  const provider = new ClaudeAgentProvider({ queryFn: fakeQuery(captured) });
  // Cold: resumed with the thread's persisted servers; the first turn overrides, the second doesn't.
  await provider.resumeThread("cold", { providerSessionId: "cold-session", cwd: "/ws", mcpServers: THREAD_LAB });
  await turns(provider, "cold", [{ text: "1", mcpServers: TURN_LAB } as TurnInput, { text: "2" } as TurnInput]);
  // A fork (an empty branch: no transcript to copy) takes the thread's servers, never a turn's.
  const fork = await provider.forkThread("cold", { keepTurns: 0 });
  await turns(provider, fork.id, [{ text: "3" } as TurnInput, { text: "4", mcpServers: TURN_LAB } as TurnInput]);
  const urls = captured.map((c) => Object.values((c.options?.mcpServers ?? {}) as Record<string, { url: string }>).map((s) => s.url)[0]);
  assert.deepEqual(urls, [TURN_LAB.lab.url, THREAD_LAB.lab.url, THREAD_LAB.lab.url, TURN_LAB.lab.url]);
});

test("the CLI's stderr never logs a credential, however it's quoted or chunked", async () => {
  const captured: QueryArgs[] = [];
  const provider = new ClaudeAgentProvider({ queryFn: fakeQuery(captured) });
  const thread = await provider.startThread({ cwd: "/ws", mcpServers: THREAD_LAB } as StartThreadInput);
  const turn = { type: "http" as const, url: "http://127.0.0.1:8787/api/mcp?nonce=turn-nonce-1", headers: { "x-api-key": "abc1" } };
  await turns(provider, thread.id, [{ text: "1", mcpServers: { lab: turn } } as TurnInput]);
  const logged: string[] = [];
  const warn = console.warn;
  console.warn = (...a: unknown[]) => void logged.push(a.join(" "));
  try {
    const stderr = captured[0]!.options!.stderr!;
    // A URL split across chunks, a request target with its query, a short header value, the
    // thread's replaced endpoint, a percent-encoded URL, and a last line with no newline.
    stderr('MCP server "lab" failed: http://127.0.0.1:8787/api/mcp?non');
    stderr("ce=turn-nonce-1\nPOST /api/mcp?nonce=turn-nonce-1 with x-api-key abc1\n");
    stderr(`old endpoint ${THREAD_LAB.lab.url}\nencoded ${encodeURIComponent(turn.url)}\n`);
    stderr("trailing turn-nonce-1");
  } finally {
    console.warn = warn;
  }
  // The turn already ended, so the last line waits for the next flush; a direct check of the
  // redactor's flush is in redact.test.ts. The four complete lines:
  assert.equal(logged.length, 4);
  for (const line of logged) assert.doesNotMatch(line, /turn-nonce-1|thread-token|abc1|nonce%3D/, line);
  assert.match(logged[0]!, /MCP server "lab" failed: \[redacted\]/);
});

test("error events and a thrown turn error never carry a credential", async () => {
  const url = "http://127.0.0.1:8787/mcp/thread-token/turn-nonce-2";
  const failing = ((args: QueryArgs) => {
    void args;
    return (async function* () {
      yield { type: "result", subtype: "success", is_error: true, result: `MCP server lab unreachable at ${url}`, usage: { input_tokens: 1, output_tokens: 1 } };
    })();
  }) as unknown as typeof query;
  const provider = new ClaudeAgentProvider({ queryFn: failing });
  const thread = await provider.startThread({ cwd: "/ws", mcpServers: THREAD_LAB } as StartThreadInput);
  const events: TurnStreamEvent[] = [];
  for await (const ev of provider.sendTurn(thread.id, { text: "q", mcpServers: { lab: { type: "http", url } } } as TurnInput)) events.push(ev);
  const err = events.find((e) => e.type === "error.raised");
  assert.ok(err, "the failed result is an error event");
  assert.doesNotMatch(JSON.stringify(err), /turn-nonce-2|thread-token/);
  assert.match((err as { message: string }).message, /unreachable at \[redacted\]/);

  const throwing = (() =>
    (async function* () {
      yield* [];
      throw new Error(`Claude Code process exited with code 1: ${url}`);
    })()) as unknown as typeof query;
  const p2 = new ClaudeAgentProvider({ queryFn: throwing });
  const t2 = await p2.startThread({ cwd: "/ws" } as StartThreadInput);
  await assert.rejects(
    async () => {
      for await (const _ of p2.sendTurn(t2.id, { text: "q", mcpServers: { lab: { type: "http", url } } } as TurnInput));
    },
    (e: Error) => !/turn-nonce-2|thread-token/.test(e.message + (e.stack ?? "")) && /\[redacted\]/.test(e.message),
  );
});
