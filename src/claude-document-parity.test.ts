/**
 * Document input on both providers. Claude reads a turn's `input.documents` as
 * `document` content blocks (a PDF as base64, a text file as text, titled with
 * the file's name) ahead of the text block, with any images after it. Codex
 * takes no document input, so text files ride inline in the message and a PDF
 * becomes a note that it can't be read. `turn.started` names the documents but
 * never carries their contents.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { query, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

import { ClaudeAgentProvider } from "./claude-provider.ts";
import { documentsText, turnStartParams } from "./codex/turn.ts";
import {
  type TurnStreamEvent,
  DocumentAttachment,
  type ImageAttachment,
  type StartThreadInput,
  TurnInput,
} from "./types/index.ts";

type QueryArgs = Parameters<typeof query>[0];

function fakeQuery(captured: QueryArgs[]): typeof query {
  return ((args: QueryArgs) => {
    captured.push(args);
    async function* run() {
      yield { type: "assistant", uuid: "u1", message: { content: [{ type: "text", text: "ok" }] } };
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

/** Run one Claude turn; return the opening message and the turn's events. */
async function claudeTurn(input: TurnInput): Promise<{ msg: SDKUserMessage; events: TurnStreamEvent[] }> {
  const captured: QueryArgs[] = [];
  const provider = new ClaudeAgentProvider({ queryFn: fakeQuery(captured) });
  const thread = await provider.startThread({ cwd: "/ws" } as StartThreadInput);
  const events: TurnStreamEvent[] = [];
  for await (const e of provider.sendTurn(thread.id, input)) events.push(e);
  const msgs: SDKUserMessage[] = [];
  for await (const m of captured[0].prompt as AsyncIterable<SDKUserMessage>) msgs.push(m);
  assert.equal(msgs.length, 1);
  return { msg: msgs[0], events };
}

const PDF: DocumentAttachment = { name: "lease.pdf", mediaType: "application/pdf", data: "JVBERi0xLjQK" };
const NOTES: DocumentAttachment = { name: "notes.md", mediaType: "text/plain", data: "# Notes\nbuy milk" };
const PNG: ImageAttachment = { dataUrl: "data:image/png;base64,iVBORw0KGgoPNGDATA", name: "a.png" };

test("Claude: documents lead as document blocks, then the text, then images", async () => {
  const { msg } = await claudeTurn({ text: "summarise", documents: [PDF, NOTES], images: [PNG] });
  const content = msg.message.content as unknown as Array<Record<string, unknown>>;
  assert.deepEqual(content, [
    {
      type: "document",
      source: { type: "base64", media_type: "application/pdf", data: "JVBERi0xLjQK" },
      title: "lease.pdf",
    },
    {
      type: "document",
      source: { type: "text", media_type: "text/plain", data: "# Notes\nbuy milk" },
      title: "notes.md",
    },
    { type: "text", text: "summarise" },
    { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgoPNGDATA" } },
  ]);
});

test("Claude: a document alone still makes structured content", async () => {
  const { msg } = await claudeTurn({ text: "", documents: [NOTES] });
  const content = msg.message.content as unknown as Array<Record<string, unknown>>;
  assert.equal(content.length, 2);
  assert.equal(content[0].type, "document");
  assert.deepEqual(content[1], { type: "text", text: "" });
});

test("turn.started names the documents without their contents", async () => {
  const { events } = await claudeTurn({ text: "read", documents: [PDF] });
  const started = events.find((e) => e.type === "turn.started");
  assert.ok(started && started.type === "turn.started");
  assert.deepEqual(started.prompt, {
    text: "read",
    documents: [{ name: "lease.pdf", mediaType: "application/pdf" }],
  });
});

test("Codex: text documents inline, a PDF as a note, ahead of the message", () => {
  const params = turnStartParams({
    threadId: "t1",
    input: { text: "what's in these?", documents: [NOTES, PDF, { ...NOTES, name: 'a "b".txt' }] },
    intro: undefined,
    effort: undefined,
    options: {},
    workspace: undefined,
    profile: undefined,
  });
  assert.deepEqual(params.input, [
    {
      type: "text",
      text:
        '<document name="notes.md">\n# Notes\nbuy milk\n</document>\n\n' +
        "[Attached PDF \"lease.pdf\" — this model can't read PDFs]\n\n" +
        '<document name="a &quot;b&quot;.txt">\n# Notes\nbuy milk\n</document>\n\n' +
        "what's in these?",
      text_elements: [],
    },
  ]);
});

test("Codex: the workspace intro still opens the text", () => {
  const params = turnStartParams({
    threadId: "t1",
    input: { text: "hi", documents: [NOTES] },
    intro: "INTRO",
    effort: undefined,
    options: {},
    workspace: undefined,
    profile: undefined,
  });
  const first = params.input[0] as { text: string };
  assert.equal(first.text, `INTRO\n\n${documentsText([NOTES])}\n\nhi`);
});

test("the schema checks the media type, base64 and sizes", () => {
  assert.ok(TurnInput.safeParse({ text: "x", documents: [PDF, NOTES] }).success);
  assert.ok(!DocumentAttachment.safeParse({ ...PDF, mediaType: "application/zip" }).success);
  assert.ok(!DocumentAttachment.safeParse({ ...PDF, data: "not base64!" }).success);
  assert.ok(!DocumentAttachment.safeParse({ ...PDF, name: "" }).success);
  assert.ok(!DocumentAttachment.safeParse({ ...NOTES, data: "x".repeat(1_100_001) }).success);
  assert.ok(!DocumentAttachment.safeParse({ ...PDF, data: "A".repeat(28_000_004) }).success);
});
