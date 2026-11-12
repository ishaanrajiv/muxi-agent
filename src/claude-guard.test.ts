/**
 * The host's guard on the Claude backend: a `PreToolUse` hook ahead of every
 * other one, for the main agent and subagents, holding for calls the kit would
 * otherwise run unasked (web fetch), and checked again in `canUseTool`. Hooks
 * from every part of a turn are concatenated per event, never replaced.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { HookInput, Options, query } from "@anthropic-ai/claude-agent-sdk";
import type { StartThreadInput, TurnInput } from "./types/index.ts";

import { ClaudeAgentProvider } from "./claude-provider.ts";
import { mergeHooks } from "./claude/hooks.ts";
import type { ToolGuardCall } from "./provider.ts";

type QueryArgs = Parameters<typeof query>[0];
const result = { type: "result", subtype: "success", is_error: false, result: "", usage: { input_tokens: 1, output_tokens: 1 } };

/** Capture one turn's options; the turn ends at once. */
function capture(seen: { options?: Options }): typeof query {
  return ((args: QueryArgs) => {
    seen.options = args.options;
    async function* run() {
      yield result;
    }
    return run();
  }) as unknown as typeof query;
}

const guard = (calls: ToolGuardCall[]) => (call: ToolGuardCall) => {
  calls.push(call);
  if (call.tool === "WebFetch" && String(call.input.url).includes("127.0.0.1")) return "No fetching this machine.";
  if (call.tool === "boom") throw new Error("broken");
  return null;
};

async function turn(provider: ClaudeAgentProvider, input: Partial<StartThreadInput> = {}) {
  const thread = await provider.startThread({ cwd: "/ws", ...input } as StartThreadInput);
  for await (const _ of provider.sendTurn(thread.id, { text: "go" } as TurnInput));
  return thread.id;
}

test("the guard's hook runs first on every tool, denies what it refuses, and fails closed", async () => {
  const seen: { options?: Options } = {};
  const calls: ToolGuardCall[] = [];
  const provider = new ClaudeAgentProvider({ queryFn: capture(seen), guard: guard(calls) });
  const threadId = await turn(provider, { webSearch: true });
  const pre = seen.options?.hooks?.PreToolUse ?? [];
  assert.ok(pre.length >= 1);
  const hook = pre[0]!.hooks[0]!;
  const run = async (tool_name: string, tool_input: unknown, agent_id?: string) =>
    (await hook({ hook_event_name: "PreToolUse", tool_name, tool_input, tool_use_id: "c1", ...(agent_id ? { agent_id } : {}) } as HookInput, "c1", {
      signal: new AbortController().signal,
    })) as { continue?: boolean; hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } };

  const denied = await run("WebFetch", { url: "http://127.0.0.1:3000/api/items" });
  assert.equal(denied.hookSpecificOutput?.permissionDecision, "deny");
  assert.equal(denied.hookSpecificOutput?.permissionDecisionReason, "No fetching this machine.");
  assert.equal((await run("WebFetch", { url: "https://example.org" })).continue, true);
  const sub = await run("WebFetch", { url: "http://127.0.0.1/" }, "agent-7");
  assert.equal(sub.hookSpecificOutput?.permissionDecision, "deny", "a subagent's call too");
  assert.equal(calls.at(-1)?.agentId, "agent-7");
  assert.equal(calls.at(-1)?.threadId, threadId);
  const broken = await run("boom", {});
  assert.equal(broken.hookSpecificOutput?.permissionDecision, "deny");
  assert.match(broken.hookSpecificOutput?.permissionDecisionReason ?? "", /check failed \(broken\)/);
});

test("canUseTool checks the guard before running a web tool unasked", async () => {
  const seen: { options?: Options } = {};
  const provider = new ClaudeAgentProvider({ queryFn: capture(seen), guard: guard([]) });
  await turn(provider, { webSearch: true });
  const ask = (tool: string, input: Record<string, unknown>) =>
    seen.options!.canUseTool!(tool, input, { signal: new AbortController().signal, toolUseID: "u1", suggestions: [] } as never);
  assert.deepEqual(await ask("WebFetch", { url: "http://127.0.0.1:3000/" }), { behavior: "deny", message: "No fetching this machine." });
  assert.equal((await ask("WebFetch", { url: "https://example.org" }))?.behavior, "allow");
});

test("without a guard a turn registers no guard hook", async () => {
  const seen: { options?: Options } = {};
  await turn(new ClaudeAgentProvider({ queryFn: capture(seen) }));
  assert.equal(seen.options?.hooks?.PreToolUse, undefined);
});

test("hooks merge by concatenating each event's matchers", () => {
  const h = (n: string) => ({ hooks: [async () => ({ continue: true, n })] });
  const merged = mergeHooks({ PreToolUse: [h("a")], TaskCreated: [h("t")] }, null, { PreToolUse: [h("b")] }, undefined, { PreToolUse: [] });
  assert.equal(merged.PreToolUse?.length, 2);
  assert.equal(merged.TaskCreated?.length, 1);
});
