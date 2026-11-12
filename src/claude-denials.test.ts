/**
 * Auto mode and refused calls on the Claude backend: the turn's permission
 * mode reaches the CLI only when asked for, and a call that didn't run says
 * who refused it (the guard, the host's canUseTool, the classifier, a rule),
 * with the result's `permission_denials` as the record. Codex refuses auto.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { HookInput, Options, query } from "@anthropic-ai/claude-agent-sdk";
import type { AgentSubagentUpdated, StartThreadInput, TurnInput, TurnStreamEvent } from "./types/index.ts";

import { ClaudeAgentProvider } from "./claude-provider.ts";
import { CodexAgentProvider } from "./codex-provider.ts";

type QueryArgs = Parameters<typeof query>[0];
const result = (denied: string[] = []) => ({
  type: "result",
  subtype: "success",
  is_error: false,
  result: "",
  usage: { input_tokens: 1, output_tokens: 1 },
  permission_denials: denied.map((id) => ({ tool_name: "mcp__tools__lamp", tool_use_id: id, tool_input: {} })),
});
const use = (id: string, name = "mcp__tools__lamp") => ({
  type: "assistant",
  uuid: `a-${id}`,
  parent_tool_use_id: null,
  message: { content: [{ type: "tool_use", id, name, input: { room: "office" } }] },
});
const refused = (id: string, text = "refused", parent: string | null = null) => ({
  type: "user",
  parent_tool_use_id: parent,
  message: { content: [{ type: "tool_result", tool_use_id: id, is_error: true, content: text }] },
});
const advisory = (id: string, reason = "Looks like exfiltration") => ({
  type: "system",
  subtype: "permission_denied",
  tool_name: "mcp__tools__lamp",
  tool_use_id: id,
  decision_reason_type: "classifier",
  decision_reason: reason,
  message: "Denied by auto mode",
});

/** Every `PreToolUse` hook the turn registered, run as the CLI runs them; the first deny wins. */
async function preToolUse(o: Options, input: Record<string, unknown>): Promise<string | undefined> {
  for (const matcher of o.hooks?.PreToolUse ?? []) {
    for (const hook of matcher.hooks) {
      const out = (await hook({ hook_event_name: "PreToolUse", ...input } as HookInput, String(input.tool_use_id), { signal: new AbortController().signal })) as {
        hookSpecificOutput?: { permissionDecision?: string };
      };
      if (out.hookSpecificOutput?.permissionDecision === "deny") return "deny";
    }
  }
  return undefined;
}

async function* collect(provider: ClaudeAgentProvider, input: Partial<TurnInput> = {}, onEvent?: (e: TurnStreamEvent) => void): AsyncGenerator<TurnStreamEvent> {
  const thread = await provider.startThread({ cwd: "/ws" } as StartThreadInput);
  for await (const e of provider.sendTurn(thread.id, { text: "go", ...input } as TurnInput)) {
    onEvent?.(e);
    yield e;
  }
}

test("the permission mode reaches the CLI as asked, and is default otherwise", async () => {
  for (const [asked, sent] of [[undefined, "default"], ["default", "default"], ["auto", "auto"]] as const) {
    let options: Options | undefined;
    const queryFn = ((args: QueryArgs) => {
      options = args.options;
      return (async function* () {
        yield result();
      })();
    }) as unknown as typeof query;
    const provider = new ClaudeAgentProvider({ queryFn });
    for await (const _ of collect(provider, asked ? { permissionMode: asked } : {}));
    assert.equal(options?.permissionMode, sent, `asked ${asked}`);
  }
});

test("a refused call says who refused it: classifier, guard, the host, or the result's record", async () => {
  const provider: ClaudeAgentProvider = new ClaudeAgentProvider({
    guard: (call) => (call.input.room === "vault" ? "Never the vault." : null),
    queryFn: ((args: QueryArgs) => {
      const o = args.options!;
      return (async function* () {
        // c1: the classifier refuses (an advisory message, then the error result, then the record).
        yield use("c1");
        yield advisory("c1");
        yield refused("c1");
        // c2: the guard's hook refuses.
        yield use("c2");
        const hook = o.hooks!.PreToolUse![0]!.hooks[0]!;
        await hook({ hook_event_name: "PreToolUse", tool_name: "mcp__tools__lamp", tool_input: { room: "vault" }, tool_use_id: "c2" } as HookInput, "c2", { signal: new AbortController().signal });
        yield refused("c2", "Never the vault.");
        // c3: the host's canUseTool says no (a person declined).
        yield use("c3");
        const answer = await o.canUseTool!("mcp__tools__lamp", { room: "office" }, { signal: new AbortController().signal, toolUseID: "c3", suggestions: [] } as never);
        assert.equal(answer?.behavior, "deny");
        yield refused("c3", "declined");
        // c4: an error the CLI later lists as refused, with no advisory message.
        yield use("c4");
        yield refused("c4");
        // c5: an ordinary tool failure, not refused.
        yield use("c5");
        yield refused("c5", "the lamp is offline");
        yield result(["c1", "c4"]);
      })();
    }) as unknown as typeof query,
  });
  const done: Record<string, { status: string; denial?: unknown }[]> = {};
  for await (const e of collect(provider, { permissionMode: "auto" }, (e) => {
    if (e.type === "approval.requested") void provider.resolveApproval(e.request.requestId as never, { action: "decline" } as never);
  })) {
    if (e.type === "tool.completed") (done[e.itemId] ??= []).push({ status: e.status, ...(e.denial ? { denial: e.denial } : {}) });
  }
  assert.deepEqual(
    done.c1,
    [{ status: "error" }, { status: "declined", denial: { by: "classifier", reason: "Looks like exfiltration" } }],
    "an advisory alone is provisional: the result's record declines it",
  );
  assert.deepEqual(done.c2, [{ status: "declined", denial: { by: "guard", reason: "Never the vault." } }]);
  assert.equal(done.c3?.[0]?.status, "declined");
  assert.equal((done.c3?.[0]?.denial as { by?: string })?.by, "host");
  assert.deepEqual(done.c4, [{ status: "error" }, { status: "declined", denial: { by: "other" } }], "corrected by the result's record");
  assert.deepEqual(done.c5, [{ status: "error" }], "a failure isn't a refusal");
});

test("a Codex turn refuses auto mode", async () => {
  const provider = new CodexAgentProvider({ codexHome: "/nonexistent" } as never);
  await assert.rejects(async () => {
    for await (const _ of provider.sendTurn("t1", { text: "go", permissionMode: "auto" } as TurnInput));
  }, /Codex turns can't run in auto mode/);
});

test("an advisory the result doesn't list stays an error, and the host's own refusals stay final", async () => {
  const provider: ClaudeAgentProvider = new ClaudeAgentProvider({
    guard: (call) => (call.input.room === "vault" ? "Never the vault." : null),
    queryFn: ((args: QueryArgs) => {
      const o = args.options!;
      return (async function* () {
        // d1: the CLI advised of a refusal, but its record doesn't list the call.
        yield use("d1");
        yield advisory("d1");
        yield refused("d1", "the lamp is offline");
        // d2: the guard refused; the CLI also advises (as a hook) and lists it. Still one event, the guard's.
        yield use("d2");
        await preToolUse(o, { tool_name: "mcp__tools__lamp", tool_input: { room: "vault" }, tool_use_id: "d2" });
        yield { ...advisory("d2", "PreToolUse hook denied"), decision_reason_type: "hook" };
        yield refused("d2", "Never the vault.");
        // d3: the host declined; the CLI's advisory names the classifier. The host's word stands.
        yield use("d3");
        await o.canUseTool!("mcp__tools__lamp", { room: "office" }, { signal: new AbortController().signal, toolUseID: "d3", suggestions: [] } as never);
        yield advisory("d3", "classifier thought so too");
        yield refused("d3", "declined");
        yield result(["d2", "d3"]);
      })();
    }) as unknown as typeof query,
  });
  const done: Record<string, { status: string; denial?: unknown }[]> = {};
  for await (const e of collect(provider, { permissionMode: "auto" }, (e) => {
    if (e.type === "approval.requested") void provider.resolveApproval(e.request.requestId as never, { action: "decline" } as never);
  })) {
    if (e.type === "tool.completed") (done[e.itemId] ??= []).push({ status: e.status, ...(e.denial ? { denial: e.denial } : {}) });
  }
  assert.deepEqual(done.d1, [{ status: "error" }], "never told declined, so nothing to take back");
  assert.deepEqual(done.d2, [{ status: "declined", denial: { by: "guard", reason: "Never the vault." } }]);
  assert.equal(done.d3?.length, 1);
  assert.equal((done.d3?.[0]?.denial as { by?: string })?.by, "host");
});

test("a call the result lists before its tool result came back is declined, once", async () => {
  const provider = new ClaudeAgentProvider({
    queryFn: ((_args: QueryArgs) =>
      (async function* () {
        yield use("e1");
        yield use("e2");
        yield advisory("e2", "Not in auto mode");
        // e3 started and was never listed: not this reconciliation's to end.
        yield use("e3");
        yield result(["e1", "e2"]);
      })()) as unknown as typeof query,
  });
  const done: Record<string, { status: string; denial?: unknown }[]> = {};
  for await (const e of collect(provider, { permissionMode: "auto" })) {
    if (e.type === "tool.completed") (done[e.itemId] ??= []).push({ status: e.status, ...(e.denial ? { denial: e.denial } : {}) });
  }
  assert.deepEqual(done.e1, [{ status: "declined", denial: { by: "other" } }]);
  assert.deepEqual(done.e2, [{ status: "declined", denial: { by: "classifier", reason: "Not in auto mode" } }]);
  assert.equal(done.e3, undefined);
});

test("a subagent's refused calls say who refused them, including once the result lists one after it finished", async () => {
  const provider: ClaudeAgentProvider = new ClaudeAgentProvider({
    subagent: { role: "helper", description: "A read-only helper.", instructions: "You are a read-only helper." },
    guard: (call) => (call.input.room === "vault" ? "Never the vault." : null),
    queryFn: ((args: QueryArgs) => {
      const o = args.options!;
      return (async function* () {
        assert.equal(await preToolUse(o, { tool_name: "Agent", tool_use_id: "a1", tool_input: { description: "Rooms", prompt: "Light the rooms" } }), undefined);
        yield { type: "assistant", uuid: "m1", parent_tool_use_id: null, message: { content: [{ type: "tool_use", id: "a1", name: "Agent", input: {} }] } };
        yield { type: "system", subtype: "task_started", task_id: "t1", tool_use_id: "a1", description: "Rooms", task_type: "local_agent" };
        const childUse = (id: string, room: string) => ({
          type: "assistant",
          uuid: `m-${id}`,
          parent_tool_use_id: "a1",
          message: { content: [{ type: "tool_use", id, name: "mcp__tools__lamp", input: { room } }] },
        });
        // k1: the classifier refuses a child's call; the record lists it after the subagent ends.
        yield childUse("k1", "office");
        yield advisory("k1");
        yield refused("k1", "refused", "a1");
        // k2: the guard refuses a child's call.
        yield childUse("k2", "vault");
        await preToolUse(o, { tool_name: "mcp__tools__lamp", tool_input: { room: "vault" }, tool_use_id: "k2", agent_id: "t1" });
        yield refused("k2", "Never the vault.", "a1");
        // k3: an advisory the record never confirms: a plain failure.
        yield childUse("k3", "hall");
        yield advisory("k3");
        yield refused("k3", "the lamp is offline", "a1");
        yield { type: "user", parent_tool_use_id: null, message: { content: [{ type: "tool_result", tool_use_id: "a1", content: "Lit what I could." }] } };
        yield result(["k1", "k2"]);
      })();
    }) as unknown as typeof query,
  });
  const thread = await provider.startThread({ cwd: "/ws", subagents: true } as StartThreadInput);
  const states: AgentSubagentUpdated[] = [];
  for await (const e of provider.sendTurn(thread.id, { text: "go", permissionMode: "auto" } as TurnInput)) {
    if (e.type === "agent.subagent.updated") states.push(e);
    assert.notEqual(e.type === "tool.completed" && e.itemId.startsWith("k"), true, "a child's call is never a rail row");
  }
  const last = states.at(-1)!;
  assert.equal(last.status, "completed");
  assert.deepEqual(last.calls, [
    { id: "k1", tool: "lamp", status: "failed", denial: { by: "classifier", reason: "Looks like exfiltration" } },
    { id: "k2", tool: "lamp", status: "failed", denial: { by: "guard", reason: "Never the vault." } },
    { id: "k3", tool: "lamp", status: "failed" },
  ]);
  // The guard's refusal showed as soon as the call's result came back, while the subagent ran.
  assert.ok(states.some((s) => s.status === "running" && s.calls.some((c) => c.id === "k2" && c.denial?.by === "guard")));
  // The classifier's waited for the record, which came after the subagent finished.
  assert.ok(!states.some((s) => s.status === "running" && s.calls.some((c) => c.id === "k1" && c.denial)));
});

test("a Codex turn refuses per-turn MCP servers", async () => {
  const provider = new CodexAgentProvider({ codexHome: "/nonexistent" } as never);
  await assert.rejects(async () => {
    for await (const _ of provider.sendTurn("t1", { text: "go", mcpServers: {} } as TurnInput));
  }, /mcpServers" on a turn is Claude only/);
});
