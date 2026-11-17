/**
 * The Claude provider's `autoCompactWindow`, driven through the `queryFn` seam:
 * it joins the isolated flag settings of every chat turn (plain and workspace),
 * the CLI's env var that would outrank it is dropped, and a window the CLI
 * would clamp fails at construction. Without it a turn's options are unchanged.
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import type { query, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { StartThreadInput, TurnInput } from "./types/index.ts";

import { ClaudeAgentProvider, type ClaudeAgentProviderOptions } from "./claude-provider.ts";
import type { WorkspaceSettings } from "./provider.ts";

type Options = NonNullable<Parameters<typeof query>[0]["options"]>;

const ENV = "CLAUDE_CODE_AUTO_COMPACT_WINDOW";
const WORKSPACE: WorkspaceSettings = {
  root: "/w/root",
  protectedPaths: [],
  developerInstructions: "dev",
  systemPrompt: "base\n\ndev",
  instructions: "",
  introduce: false,
  refusal: () => null,
};

/** A `query()` double that records each turn's options. */
function fakeQuery(captured: Options[]): typeof query {
  return ((args: Parameters<typeof query>[0]) => {
    async function* run() {
      await (args.prompt as AsyncIterable<SDKUserMessage>)[Symbol.asyncIterator]().next();
      captured.push(args.options ?? {});
      yield { type: "assistant", uuid: "u1", message: { content: [{ type: "text", text: "ok" }] } };
      yield { type: "result", subtype: "success", is_error: false, result: "ok", usage: { input_tokens: 1, output_tokens: 1 } };
    }
    return run();
  }) as unknown as typeof query;
}

async function turnOptions(opts: ClaudeAgentProviderOptions, workspace = false): Promise<Options> {
  const captured: Options[] = [];
  const provider = new ClaudeAgentProvider({ ...opts, queryFn: fakeQuery(captured) });
  const thread = await provider.startThread({ cwd: "/w", baseInstructions: "base" } as StartThreadInput);
  if (workspace) await provider.configureWorkspace(thread.id, WORKSPACE);
  for await (const _ of provider.sendTurn(thread.id, { text: "q" } as TurnInput)) void _;
  return captured[0]!;
}

// The host's own env sets the variable, as a shell inside a Claude Code session does.
let saved: string | undefined;
beforeEach(() => {
  saved = process.env[ENV];
  process.env[ENV] = "400000";
});
afterEach(() => {
  if (saved === undefined) delete process.env[ENV];
  else process.env[ENV] = saved;
});

test("without a window a turn keeps the isolated settings and inherits the env", async () => {
  const o = await turnOptions({});
  assert.deepEqual(o.settings, { autoMemoryEnabled: false });
  assert.equal("env" in o, false);
});

test("a window joins the isolated settings and drops the env var that would win over it", async () => {
  const o = await turnOptions({ autoCompactWindow: 133_000 });
  assert.deepEqual(o.settings, { autoMemoryEnabled: false, autoCompactWindow: 133_000 });
  assert.equal(o.env?.[ENV], undefined);
  assert.equal(ENV in (o.env ?? {}), false);
  assert.equal(o.env?.PATH, process.env.PATH, "the rest of the env is kept");
  assert.deepEqual(o.settingSources, [], "the isolation is unchanged");
});

test("a workspace turn takes the window and keeps its own env", async () => {
  const o = await turnOptions({ autoCompactWindow: 433_000 }, true);
  assert.deepEqual(o.settings, { autoMemoryEnabled: false, autoCompactWindow: 433_000 });
  assert.equal(ENV in (o.env ?? {}), false);
  assert.equal(o.env?.GIT_CONFIG_KEY_0, "credential.helper", "still the workspace's env");
  assert.equal(o.sandbox?.enabled, true);
});

test("a window the CLI would clamp fails when the provider is made", () => {
  for (const bad of [99_999, 1_000_001, 150_000.5, Number.NaN]) {
    assert.throws(() => new ClaudeAgentProvider({ autoCompactWindow: bad }), RangeError, String(bad));
  }
  for (const ok of [100_000, 1_000_000]) assert.doesNotThrow(() => new ClaudeAgentProvider({ autoCompactWindow: ok }));
});
