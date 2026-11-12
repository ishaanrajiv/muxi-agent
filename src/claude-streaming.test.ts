/**
 * Streaming deltas on Claude threads (agent-parity wave 2). With
 * `includePartialMessages` the SDK yields `stream_event` messages wrapping raw
 * Anthropic Messages-API streaming events; the provider maps the two content-block
 * deltas a client renders onto the SAME events Codex emits from
 * `item/agentMessage/delta` and `item/reasoning/textDelta` — `{ threadId, delta }`,
 * no item id. The assembled assistant message still follows and stays the
 * authoritative `*.completed` text.
 *
 * Driven through the `queryFn` seam — no CLI is spawned.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { query } from "@anthropic-ai/claude-agent-sdk";

import { ClaudeAgentProvider } from "./claude-provider.ts";
import type { UtilityTurnInput } from "./provider.ts";
import type { TurnStreamEvent, StartThreadInput, TurnInput } from "./types/index.ts";

type QueryArgs = Parameters<typeof query>[0];

/** One `stream_event` frame carrying a content-block delta. */
function frame(
  delta: Record<string, unknown>,
  parentToolUseId: string | null = null,
): Record<string, unknown> {
  return {
    type: "stream_event",
    uuid: "p1",
    session_id: "s1",
    parent_tool_use_id: parentToolUseId,
    event: { type: "content_block_delta", index: 0, delta },
  };
}

const textDelta = (text: string, parent: string | null = null) =>
  frame({ type: "text_delta", text }, parent);
const thinkingDelta = (thinking: string, parent: string | null = null) =>
  frame({ type: "thinking_delta", thinking }, parent);

/** A `query()` double that replays `msgs`, then a successful result. */
function streamQuery(
  captured: QueryArgs[],
  msgs: Array<Record<string, unknown>>,
  result: Record<string, unknown> = {},
): typeof query {
  return ((args: QueryArgs) => {
    captured.push(args);
    async function* run() {
      for (const msg of msgs) yield msg;
      yield {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "done",
        usage: { input_tokens: 1, output_tokens: 1 },
        ...result,
      };
    }
    return run();
  }) as unknown as typeof query;
}

async function runTurn(msgs: Array<Record<string, unknown>>) {
  const captured: QueryArgs[] = [];
  const provider = new ClaudeAgentProvider({
    queryFn: streamQuery(captured, msgs),
    streamedInputTools: ["render_chart"],
  });
  const thread = await provider.startThread({ cwd: "/ws" } as StartThreadInput);
  const events: TurnStreamEvent[] = [];
  for await (const ev of provider.sendTurn(thread.id, { text: "q" } as TurnInput)) {
    events.push(ev);
  }
  return { options: captured[0].options ?? {}, events, threadId: thread.id };
}

/** An assistant message delivering one content block (how the CLI streams). */
function assistant(uuid: string, block: Record<string, unknown>): Record<string, unknown> {
  return { type: "assistant", uuid, parent_tool_use_id: null, message: { content: [block] } };
}

test("chat turns ask the SDK for partial messages", async () => {
  const { options } = await runTurn([]);
  assert.equal(options.includePartialMessages, true);
});

test("text deltas stream as agent.message.delta and are superseded by completed", async () => {
  const { events, threadId } = await runTurn([
    textDelta("Reve"),
    textDelta("nue rose"),
    assistant("u0", { type: "text", text: "Rainfall rose 4%." }),
  ]);
  const deltas = events.filter((e) => e.type === "agent.message.delta");
  assert.deepEqual(deltas, [
    { type: "agent.message.delta", threadId, delta: "Reve" },
    { type: "agent.message.delta", threadId, delta: "nue rose" },
  ]);
  // The authoritative text is the assembled block, NOT the joined deltas, and it
  // arrives after them so the fold replaces the streamed item.
  const types = events.map((e) => e.type);
  const completed = events.find(
    (e): e is Extract<TurnStreamEvent, { type: "agent.message.completed" }> =>
      e.type === "agent.message.completed",
  );
  assert.equal(completed?.text, "Rainfall rose 4%.");
  assert.equal(completed?.itemId, "u0:0");
  assert.ok(
    types.lastIndexOf("agent.message.delta") < types.indexOf("agent.message.completed"),
    "deltas must precede the completed event they are superseded by",
  );
});

test("thinking deltas stream as agent.reasoning.delta", async () => {
  const { events, threadId } = await runTurn([
    thinkingDelta("Checking "),
    thinkingDelta("the lag."),
    assistant("u0", { type: "thinking", thinking: "Checking the lag." }),
  ]);
  assert.deepEqual(
    events.filter((e) => e.type === "agent.reasoning.delta"),
    [
      { type: "agent.reasoning.delta", threadId, delta: "Checking " },
      { type: "agent.reasoning.delta", threadId, delta: "the lag." },
    ],
  );
  const completed = events.find(
    (e): e is Extract<TurnStreamEvent, { type: "agent.reasoning.completed" }> =>
      e.type === "agent.reasoning.completed",
  );
  assert.equal(completed?.text, "Checking the lag.");
});

test("subagent partials never leak into the main transcript", async () => {
  const { events, threadId } = await runTurn([
    textDelta("nested", "call-1"),
    thinkingDelta("nested", "call-1"),
    textDelta("mine"),
  ]);
  assert.deepEqual(
    events.filter((e) => e.type === "agent.message.delta" || e.type === "agent.reasoning.delta"),
    [{ type: "agent.message.delta", threadId, delta: "mine" }],
  );
});

test("non-delta stream events and empty deltas emit nothing", async () => {
  const { events } = await runTurn([
    {
      type: "stream_event",
      uuid: "p0",
      session_id: "s1",
      parent_tool_use_id: null,
      event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    },
    { type: "stream_event", uuid: "p1", session_id: "s1", parent_tool_use_id: null, event: { type: "message_stop" } },
    textDelta(""),
    frame({ type: "input_json_delta", partial_json: '{"a":' }),
    frame({ type: "signature_delta", signature: "sig" }),
  ]);
  assert.deepEqual(
    events.filter((e) => e.type.endsWith(".delta")),
    [],
  );
});

test("a streamed-input tool streams as tool.input.delta and other tools' input stays silent", async () => {
  const at = (index: number, event: Record<string, unknown>) => ({
    type: "stream_event",
    uuid: "p",
    session_id: "s1",
    parent_tool_use_id: null,
    event: { index, ...event },
  });
  const toolStart = (index: number, id: string, name: string) =>
    at(index, { type: "content_block_start", content_block: { type: "tool_use", id, name, input: {} } });
  const json = (index: number, partial_json: string) =>
    at(index, { type: "content_block_delta", delta: { type: "input_json_delta", partial_json } });
  const { events, threadId } = await runTurn([
    toolStart(0, "call-echo", "mcp__lab__echo"),
    json(0, '{"text": "hi"}'),
    at(0, { type: "content_block_stop" }),
    toolStart(1, "call-ui", "mcp__lab__render_chart"),
    json(1, '{"html": "<h1>'),
    json(1, 'Hi</h1>"}'),
    at(1, { type: "content_block_stop" }),
    json(1, "late"),
  ]);
  const turnId = events.find(
    (e): e is Extract<TurnStreamEvent, { type: "turn.started" }> => e.type === "turn.started",
  )?.turnId;
  const base = { type: "tool.input.delta", threadId, turnId, itemId: "call-ui", tool: "render_chart" };
  assert.deepEqual(
    events.filter((e) => e.type === "tool.input.delta"),
    [
      { ...base, offset: 0, delta: '{"html": "<h1>' },
      { ...base, offset: 14, delta: 'Hi</h1>"}' },
    ],
  );
});

test("utility turns are never streamed", async () => {
  const captured: QueryArgs[] = [];
  const provider = new ClaudeAgentProvider({
   queryFn: streamQuery(captured, [assistant("u0", { type: "text", text: '{"title":"t"}' })], {
      structured_output: { title: "t" },
    }),
  });
  await provider.runUtilityTurn({
    prompt: "name it",
    systemInstructions: "be terse",
    cwd: "/ws",
    model: "claude-sonnet-5",
    outputSchema: { type: "object" },
    timeoutMs: 5_000,
  } as UtilityTurnInput);
  assert.equal(captured[0].options?.includePartialMessages, undefined);
});
