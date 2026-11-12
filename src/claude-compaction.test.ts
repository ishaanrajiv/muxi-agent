/**
 * Claude compaction: the CLI's `status` and `compact_boundary` frames become
 * one `context.compaction` event per phase, and the turn's closing context
 * size is the compacted one. Driven through the `queryFn` seam.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { query } from "@anthropic-ai/claude-agent-sdk";
import type { TurnStreamEvent, StartThreadInput, TurnInput } from "./types/index.ts";

import { ClaudeAgentProvider } from "./claude-provider.ts";

const initConnected = { type: "system", subtype: "init", mcp_servers: [{ name: "lab", status: "connected" }] };
const compacting = { type: "system", subtype: "status", status: "compacting" };
const resultOk = { type: "result", subtype: "success", is_error: false, result: "ok" };

async function runTurn(frames: unknown[]): Promise<TurnStreamEvent[]> {
  const provider = new ClaudeAgentProvider({
    queryFn: (() =>
      (async function* () {
        for (const f of frames) yield f;
      })()) as unknown as typeof query,
  });
  const thread = await provider.startThread({ cwd: "/ws" } as StartThreadInput);
  const events: TurnStreamEvent[] = [];
  for await (const ev of provider.sendTurn(thread.id, { text: "q" } as TurnInput)) events.push(ev);
  return events;
}

const compactions = (events: TurnStreamEvent[]) =>
  events.flatMap((e) => (e.type === "context.compaction" ? [e] : []));

test("a compaction starts once and completes with the sizes the boundary reports", async () => {
  const events = await runTurn([
    initConnected,
    { type: "assistant", uuid: "a0", parent_tool_use_id: null, message: { content: [], usage: { input_tokens: 150_000 } } },
    compacting,
    compacting,
    {
      type: "system",
      subtype: "compact_boundary",
      compact_metadata: { trigger: "auto", pre_tokens: 150_000, post_tokens: 12_000 },
    },
    { type: "system", subtype: "status", status: null, compact_result: "success" },
    resultOk,
  ]);
  assert.deepEqual(
    compactions(events).map(({ phase, trigger, preTokens, postTokens }) => ({ phase, trigger, preTokens, postTokens })),
    [
      { phase: "started", trigger: undefined, preTokens: undefined, postTokens: undefined },
      { phase: "completed", trigger: "auto", preTokens: 150_000, postTokens: 12_000 },
    ],
  );
  const usage = events.find((e) => e.type === "context.usage");
  assert.ok(usage?.type === "context.usage");
  assert.equal(usage.usedTokens, 12_000, "the turn closes on the compacted size, not the one before");
  assert.equal(events.at(-1)?.type, "turn.completed");
});

test("a failed compaction says so and the turn carries on", async () => {
  const events = await runTurn([
    initConnected,
    compacting,
    { type: "system", subtype: "status", status: null, compact_result: "failed", compact_error: "Summary request failed" },
    resultOk,
  ]);
  assert.deepEqual(
    compactions(events).map(({ phase, message }) => ({ phase, message })),
    [
      { phase: "started", message: undefined },
      { phase: "failed", message: "Summary request failed" },
    ],
  );
  assert.equal(events.at(-1)?.type, "turn.completed");
});
