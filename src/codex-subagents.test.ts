/**
 * Codex subagents: a turn's `spawn_agent` children, mapped from the app-server's
 * notifications to `agent.subagent.updated`. Pure: the notifications are the
 * shapes the generated bindings declare, and interrupts are recorded.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { AgentEvent, AgentSubagentUpdated } from "./types/index.ts";

import { CodexSubagents } from "./codex/subagents.ts";
import type { ServerNotification } from "./generated/ServerNotification.ts";

const n = (method: string, params: unknown) => ({ method, params }) as unknown as ServerNotification;
const spawned = (id: string, path: string) =>
  n("thread/started", { thread: { id, parentThreadId: "p", source: { subAgent: { thread_spawn: { agent_path: path } } } } });
const turn = (method: "turn/started" | "turn/completed", threadId: string, status = "inProgress", error?: string) =>
  n(method, { threadId, turn: { id: `${threadId}-turn`, status, error: error ? { message: error } : null } });
const item = (method: "item/started" | "item/completed", threadId: string, it: Record<string, unknown>) =>
  n(method, { threadId, item: it });

function rig(allowed = true, lineage = new Set<string>()) {
  const events: AgentEvent[] = [];
  const interrupted: string[] = [];
  const told: string[] = [];
  const subagents = new CodexSubagents(
    "p",
    (e) => events.push(e),
    allowed,
    (id) => interrupted.push(id),
    (text) => told.push(text),
    lineage,
  );
  const last = () => {
    const map = new Map<string, AgentSubagentUpdated>();
    for (const e of events) if (e.type === "agent.subagent.updated") map.set(e.subagentId, e);
    return map;
  };
  return { subagents, interrupted, told, last };
}

test("Codex children become subagents: named, briefed, followed to a report, and the main agent's answer stops the rest", () => {
  const { subagents, interrupted, last } = rig();
  const feed = (...ns: ServerNotification[]) => ns.forEach((x) => subagents.onNotification(x));

  feed(
    spawned("c1", "/root/region"),
    item("item/completed", "p", { type: "collabAgentToolCall", tool: "spawnAgent", receiverThreadIds: ["c1"], prompt: "Rainfall by state" }),
    turn("turn/started", "c1"),
    item("item/started", "c1", { type: "mcpToolCall", id: "m1", tool: "echo", status: "inProgress" }),
    item("item/completed", "c1", { type: "mcpToolCall", id: "m1", tool: "echo", status: "completed" }),
    item("item/completed", "c1", { type: "agentMessage", id: "x", text: "**Headline:** Up in every region." }),
    turn("turn/completed", "c1", "completed"),
  );
  const c1 = last().get("c1");
  assert.equal(c1?.name, "Region");
  assert.equal(c1?.brief, "Rainfall by state");
  assert.equal(c1?.status, "completed");
  assert.equal(c1?.report, "**Headline:** Up in every region.");
  assert.deepEqual(c1?.calls, [{ id: "m1", tool: "echo", status: "completed" }]);

  // Three more run at once; a fifth child is past the limit, stopped as soon
  // as its turn starts, and never shown. Its requests name no subagent.
  for (const id of ["c2", "c3", "c4", "c5"]) {
    feed(item("item/started", "p", { type: "subAgentActivity", kind: "started", agentThreadId: id, agentPath: `/root/${id}` }));
    feed(turn("turn/started", id));
  }
  assert.deepEqual(interrupted, ["c5"]);
  assert.equal(last().has("c5"), false);
  assert.equal(subagents.subagentRef("c5"), null);
  assert.deepEqual(subagents.subagentRef("c2"), { id: "c2", name: "C2" });

  // The main agent answered: every child still running is interrupted once
  // and reads as stopped.
  subagents.stopAll("answered");
  subagents.stopAll("ended");
  assert.deepEqual(interrupted, ["c5", "c2", "c3", "c4"]);
  assert.deepEqual(
    ["c2", "c3", "c4"].map((id) => last().get(id)?.status),
    ["stopped", "stopped", "stopped"],
  );
});

test("a Codex subagent stopped mid-turn wakes the main agent instead of leaving it in wait_agent", () => {
  // An interrupted child sends its parent nothing, so the parent's wait_agent
  // only ends at its timeout unless the caller steers the turn.
  const { subagents, interrupted, told, last } = rig();
  for (const id of ["c1", "c2", "c3", "c4"]) {
    subagents.onNotification(spawned(id, `/root/${id}`));
    subagents.onNotification(turn("turn/started", id));
  }
  // The fourth is past the live limit: stopped, and the main agent told why.
  assert.deepEqual(interrupted, ["c4"]);
  assert.match(told[0] ?? "", /3 subagents are already running/);

  assert.equal(subagents.stop("c2"), true);
  assert.deepEqual(interrupted, ["c4", "c2"]);
  assert.match(told[1] ?? "", /The user stopped the C2 subagent\. It won't report/);
  subagents.onNotification(turn("turn/completed", "c2", "interrupted"));
  assert.equal(last().get("c2")?.status, "stopped");
  assert.equal(told.length, 2);
});

test("a Codex subagent stopped before its turn starts is interrupted when the turn does, instead of running on", () => {
  const { subagents, interrupted, told, last } = rig();
  subagents.onNotification(spawned("c1", "/root/region"));
  assert.equal(subagents.stop("c1"), true);
  assert.equal(last().get("c1")?.status, "stopped");
  assert.deepEqual(interrupted, []);

  subagents.onNotification(turn("turn/started", "c1"));
  assert.deepEqual(interrupted, ["c1"]);
  assert.equal(subagents.subagentRef("c1"), null);
  assert.equal(told.length, 1);
});

test("a Codex subagent restarted after it reported is interrupted and the main agent told, instead of running unseen", () => {
  const { subagents, interrupted, told, last } = rig();
  subagents.onNotification(spawned("c1", "/root/region"));
  subagents.onNotification(turn("turn/started", "c1"));
  subagents.onNotification(item("item/completed", "c1", { type: "agentMessage", id: "x", text: "Up in every region." }));
  subagents.onNotification(turn("turn/completed", "c1", "completed"));
  assert.deepEqual(interrupted, []);

  // followup_task starts a second turn on the same child.
  subagents.onNotification(turn("turn/started", "c1"));
  assert.deepEqual(interrupted, ["c1"]);
  assert.match(told[0] ?? "", /Region subagent was stopped: it already reported/);
  assert.equal(subagents.subagentRef("c1"), null);
  assert.equal(last().get("c1")?.status, "completed");
  assert.equal(last().get("c1")?.report, "Up in every region.");
});

test("a follow-up to a Codex subagent from an earlier turn is stopped and declined, instead of stalling unseen", () => {
  // The thread's first turn started c1, and it reported.
  const lineage = new Set<string>();
  const first = rig(true, lineage).subagents;
  first.onNotification(spawned("c1", "/root/region"));
  first.onNotification(turn("turn/started", "c1"));
  first.onNotification(turn("turn/completed", "c1", "completed"));

  // A later turn on the same thread knows c1 from the lineage. After a
  // restart nothing does, so the parent's follow-up call names it instead.
  const followup = item("item/started", "p", { type: "collabAgentToolCall", tool: "followupTask", receiverThreadIds: ["c9"] });
  const cases: Array<[string, ReturnType<typeof rig>, string, ServerNotification[]]> = [
    ["same process", rig(true, lineage), "c1", []],
    ["after a restart", rig(), "c9", [followup]],
  ];
  for (const [label, { subagents, interrupted, told, last }, id, before] of cases) {
    for (const x of [...before, turn("turn/started", id)]) subagents.onNotification(x);
    assert.equal(subagents.isChild(id), true, label);
    assert.equal(subagents.subagentRef(id), null, label);
    assert.deepEqual(interrupted, [id], label);
    assert.match(told[0] ?? "", /earlier turn was stopped: a subagent reports once/, label);
    assert.equal(last().has(id), false, label);
  }
});

test("with subagents off, a Codex child is stopped at once and never shown", () => {
  const { subagents, interrupted, last } = rig(false);
  subagents.onNotification(spawned("c1", "/root/region"));
  subagents.onNotification(turn("turn/started", "c1"));
  assert.deepEqual(interrupted, ["c1"]);
  assert.equal(last().size, 0);
});
