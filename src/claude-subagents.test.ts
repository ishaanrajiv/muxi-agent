/**
 * Claude subagents: the CLI's own `Agent` subagents, run as a read-only
 * subagent role. Driven through the `queryFn` seam, no CLI spawned: the double
 * calls the turn's `PreToolUse` hook the way the CLI does before each `Agent`
 * call, then replays the task events and child frames a subagent produces.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { HookInput, query } from "@anthropic-ai/claude-agent-sdk";
import type { AgentEvent, AgentSubagentUpdated, StartThreadInput, TurnInput, TurnStreamEvent } from "./types/index.ts";

import { ClaudeAgentProvider } from "./claude-provider.ts";
import { SUBAGENT_USER_STOPPED, SubagentTracker, subagentReport } from "./subagents.ts";

type QueryArgs = Parameters<typeof query>[0];
type HookOutput = { hookSpecificOutput?: { permissionDecision?: string; updatedInput?: Record<string, unknown> } };

const main = (content: unknown[]) => ({ type: "assistant", parent_tool_use_id: null, message: { content } });
const child = (parent: string, type: "assistant" | "user", content: unknown[]) => ({
  type,
  parent_tool_use_id: parent,
  message: { content },
});
const result = { type: "result", subtype: "success", is_error: false, result: "", usage: { input_tokens: 1, output_tokens: 1 } };

/** A `query()` double for one turn that starts four subagents. Region asks for
 *  a permission and reports, Season fails, Month is still running at the first result and reports
 *  after it, and the fourth is past the limit. */
function subagentQuery(decisions: Array<[string, HookOutput]>): typeof query {
  return ((args: QueryArgs) => {
    const hook = args.options?.hooks?.PreToolUse?.[0]?.hooks[0];
    const launch = async (id: string, input: Record<string, unknown>) => {
      const out = (await hook!(
        { hook_event_name: "PreToolUse", tool_name: "Agent", tool_use_id: id, tool_input: input } as HookInput,
        id,
        { signal: new AbortController().signal },
      )) as HookOutput;
      decisions.push([id, out]);
    };
    async function* run() {
      await launch("a1", { description: "Region", prompt: "Rainfall by state", subagent_type: "general-purpose", model: "opus", run_in_background: true });
      await launch("a2", { description: "season_subagent", prompt: "Rainfall by season" });
      await launch("a3", { description: "Month", prompt: "Rainfall by month" });
      await launch("a4", { description: "Station", prompt: "Rainfall by device" });
      yield main([
        { type: "tool_use", id: "a1", name: "Agent", input: {} },
        { type: "tool_use", id: "a2", name: "Agent", input: {} },
        { type: "tool_use", id: "a3", name: "Agent", input: {} },
      ]);
      yield { type: "system", subtype: "task_started", task_id: "t1", tool_use_id: "a1", description: "Region", task_type: "local_agent" };
      yield { type: "system", subtype: "task_progress", task_id: "t1", tool_use_id: "a1", summary: "Reading rainfall by state" };
      // Region asks to run a tool: its request names it.
      void args.options?.canUseTool?.("mcp__lab__save_note", {}, {
        signal: new AbortController().signal,
        toolUseID: "w1",
        agentID: "t1",
        suggestions: [],
      } as never);
      yield child("a1", "assistant", [{ type: "tool_use", id: "q1", name: "mcp__lab__echo", input: {} }]);
      yield child("a1", "user", [{ type: "tool_result", tool_use_id: "q1", content: "ok" }]);
      yield {
        type: "user",
        parent_tool_use_id: null,
        message: { content: [{ type: "tool_result", tool_use_id: "a1", content: "**Headline:** Up in every region.\nagentId: x1" }] },
      };
      yield { type: "system", subtype: "task_notification", task_id: "t2", tool_use_id: "a2", status: "failed", summary: "The query was refused." };
      // Month is still running: this result must not end the turn.
      yield result;
      yield {
        type: "user",
        parent_tool_use_id: null,
        message: { content: [{ type: "tool_result", tool_use_id: "a3", content: "**Headline:** June was wettest." }] },
      };
      yield result;
    }
    return run();
  }) as unknown as typeof query;
}

test("a Claude turn starts subagents on the configured role within the limits, follows each one, and waits for the last to report", async () => {
  const decisions: Array<[string, HookOutput]> = [];
  const provider = new ClaudeAgentProvider({
    subagent: { role: "helper", description: "A read-only helper.", instructions: "You are a read-only helper." },
    queryFn: subagentQuery(decisions),
  });
  const thread = await provider.startThread({ cwd: "/ws", subagents: true } as StartThreadInput);
  const events: TurnStreamEvent[] = [];
  for await (const ev of provider.sendTurn(thread.id, { text: "why" } as TurnInput)) events.push(ev);

  // Three start pinned to the role in the foreground; the fourth is refused.
  const decided = Object.fromEntries(decisions.map(([id, out]) => [id, out.hookSpecificOutput]));
  assert.deepEqual(decided.a1?.updatedInput, {
    description: "Region",
    prompt: "Rainfall by state",
    subagent_type: "helper",
    run_in_background: false,
  });
  assert.deepEqual(
    ["a1", "a2", "a3", "a4"].map((id) => decided[id]?.permissionDecision),
    ["allow", "allow", "allow", "deny"],
  );

  const asked = events.find((e) => e.type === "approval.requested");
  assert.deepEqual(asked?.type === "approval.requested" ? asked.request.subagent : null, { id: "a1", name: "Region" });

  // The subagent tool never shows as a tool row; each subagent's last state does.
  assert.equal(events.some((e) => e.type === "tool.started" && e.tool === "Agent"), false);
  const last = new Map<string, AgentSubagentUpdated>();
  for (const e of events) if (e.type === "agent.subagent.updated") last.set(e.subagentId, e);
  const a1 = last.get("a1");
  assert.equal(a1?.status, "completed");
  assert.equal(a1?.report, "**Headline:** Up in every region.");
  assert.deepEqual(a1?.calls, [{ id: "q1", tool: "echo", status: "completed" }]);
  assert.equal(last.get("a2")?.name, "Season");
  assert.equal(last.get("a2")?.status, "failed");
  assert.equal(last.get("a3")?.status, "completed", "the turn waited past the first result");
  assert.equal(last.has("a4"), false);

  // One end, after every subagent settled.
  const ends = events.flatMap((e, i) => (e.type === "turn.completed" ? [i] : []));
  assert.equal(ends.length, 1);
  const lastSubagent = events.map((e) => e.type).lastIndexOf("agent.subagent.updated");
  assert.ok(lastSubagent < ends[0]!);
});

test("a subagent's report shows without the CLI's hand-back frame and indent", () => {
  const framed =
    "[Subagent hand-back] The text below is the final report of a subagent this session delegated to. The report follows:\n" +
    "  **Headline:** Up in every region.\n  \n  - The north rose most\n    | region | mm |\n";
  assert.equal(subagentReport(framed), "**Headline:** Up in every region.\n\n- The north rose most\n  | region | mm |");
});

test("a subagent the user stopped says so instead of repeating its name", () => {
  const events: AgentEvent[] = [];
  const subagents = new SubagentTracker("t", (e) => events.push(e));
  subagents.start("a1", { name: "App", brief: "Rainfall by town" });
  subagents.markStopping("a1");
  // The CLI's stop notification carries the task's description as its summary.
  subagents.finish("a1", "stopped", { error: "App" });
  const last = events.at(-1);
  assert.equal(last?.type === "agent.subagent.updated" ? last.error : null, SUBAGENT_USER_STOPPED);
});
