/**
 * Claude `compactThread`: a turn whose whole prompt is the CLI's `/compact`
 * command, so nothing the provider adds to a prompt may ride along.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { query, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

import { ClaudeAgentProvider } from "./claude-provider.ts";
import type { WorkspaceSettings } from "./provider.ts";
import type { StartThreadInput, TurnInput, TurnStreamEvent } from "./types/index.ts";

const WORKSPACE: WorkspaceSettings = {
  root: "/w/root",
  protectedPaths: [],
  developerInstructions: "dev",
  systemPrompt: "base\n\ndev",
  instructions: "work under /w/root",
  introduce: true,
  refusal: () => null,
};

/** A `query()` double that records the text of each turn's opening prompt. */
function fakeQuery(prompts: string[]): typeof query {
  return ((args: Parameters<typeof query>[0]) => {
    async function* run() {
      const first = await (args.prompt as AsyncIterable<SDKUserMessage>)[Symbol.asyncIterator]().next();
      const content = (first.value as SDKUserMessage).message.content;
      prompts.push(typeof content === "string" ? content : content.map((b) => ("text" in b ? b.text : "")).join(""));
      yield { type: "system", subtype: "status", status: "compacting" };
      yield { type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "manual", pre_tokens: 900, post_tokens: 90 } };
      yield { type: "result", subtype: "success", is_error: false, result: "", usage: { input_tokens: 1, output_tokens: 1 } };
    }
    return run();
  }) as unknown as typeof query;
}

async function collect(stream: AsyncIterable<TurnStreamEvent>): Promise<TurnStreamEvent[]> {
  const events: TurnStreamEvent[] = [];
  for await (const ev of stream) events.push(ev);
  return events;
}

async function threadWithATurn(prompts: string[]) {
  const provider = new ClaudeAgentProvider({ queryFn: fakeQuery(prompts) });
  const thread = await provider.startThread({ cwd: "/w", baseInstructions: "base" } as StartThreadInput);
  await collect(provider.sendTurn(thread.id, { text: "q" } as TurnInput));
  return { provider, threadId: thread.id };
}

test("the prompt is the compact command with the instructions as its argument", async () => {
  const prompts: string[] = [];
  const { provider, threadId } = await threadWithATurn(prompts);
  const events = await collect(provider.compactThread(threadId, { instructions: "  keep the open questions " }));
  assert.equal(prompts.at(-1), "/compact keep the open questions");

  const started = events.find((e) => e.type === "turn.started");
  assert.deepEqual(started?.trigger, { kind: "compact" });
  assert.equal(started?.prompt, undefined, "the command is not shown as the caller's prompt");
  assert.deepEqual(
    events.filter((e) => e.type === "context.compaction").map((e) => [e.phase, e.trigger]),
    [["started", undefined], ["completed", "manual"]],
  );
  assert.equal(events.at(-1)?.type, "turn.completed");
});

test("without instructions the prompt is the bare command", async () => {
  const prompts: string[] = [];
  const { provider, threadId } = await threadWithATurn(prompts);
  await collect(provider.compactThread(threadId));
  assert.equal(prompts.at(-1), "/compact");
});

test("workspace steering waits for the next real turn", async () => {
  const prompts: string[] = [];
  const { provider, threadId } = await threadWithATurn(prompts);
  await provider.configureWorkspace(threadId, WORKSPACE);
  await collect(provider.compactThread(threadId, { instructions: "keep names" }));
  assert.equal(prompts.at(-1), "/compact keep names");
  await collect(provider.sendTurn(threadId, { text: "next" } as TurnInput));
  assert.equal(prompts.at(-1), "work under /w/root\n\nnext");
});

test("a thread with no conversation yet is refused", async () => {
  const prompts: string[] = [];
  const provider = new ClaudeAgentProvider({ queryFn: fakeQuery(prompts) });
  const thread = await provider.startThread({ cwd: "/w", baseInstructions: "base" } as StartThreadInput);
  await assert.rejects(collect(provider.compactThread(thread.id)), /no conversation to compact/);
  assert.deepEqual(prompts, []);
});
