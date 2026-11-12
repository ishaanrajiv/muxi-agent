/**
 * A Claude turn's `turn.started` names the prompt, the selection, and the
 * trigger the caller passed for a turn the system started.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { query } from "@anthropic-ai/claude-agent-sdk";
import type { StartThreadInput, TurnStreamEvent } from "./types/index.ts";

import { ClaudeAgentProvider } from "./claude-provider.ts";

const queryFn = (() =>
  (async function* () {
    yield { type: "assistant", uuid: "u1", message: { content: [{ type: "text", text: "ok" }] } };
    yield { type: "result", subtype: "success", is_error: false, result: "ok", usage: { input_tokens: 1, output_tokens: 1 } };
  })()) as unknown as typeof query;

test("a Claude turn.started carries the prompt, the selection and the caller's trigger", async () => {
  const provider = new ClaudeAgentProvider({ queryFn });
  const thread = await provider.startThread({ cwd: "/ws", model: "claude-haiku-5-5" } as StartThreadInput);
  const trigger = { kind: "webhook", source: "ci" };
  const events: TurnStreamEvent[] = [];
  for await (const ev of provider.sendTurn(thread.id, { text: "hi", effort: "low", trigger })) events.push(ev);
  const begun = events.find((e) => e.type === "turn.started");
  assert.ok(begun?.type === "turn.started");
  assert.equal(begun.provider, "claude");
  assert.deepEqual(begun.prompt, { text: "hi" });
  assert.equal(begun.model, "claude-haiku-5-5");
  assert.deepEqual(begun.trigger, trigger);

  const plain: TurnStreamEvent[] = [];
  for await (const ev of provider.sendTurn(thread.id, { text: "again" })) plain.push(ev);
  const second = plain.find((e) => e.type === "turn.started");
  assert.equal(second?.type === "turn.started" ? second.trigger : "missing", undefined, "a person's turn has no trigger");
});
