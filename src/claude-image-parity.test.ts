/**
 * Claude image-input parity. Every turn's prompt is a
 * streaming-input channel opening on one {@link SDKUserMessage}. A text-only
 * turn keeps its content the plain string; a turn carrying `input.images`
 * carries a text block followed by one base64 `image` block per SUPPORTED
 * attachment. The four API-accepted subtypes pass through with the `data:`
 * prefix stripped; anything else is dropped with a warn so one bad block can't
 * fail the request.
 * Driven through the `queryFn` seam — no CLI is spawned.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { query, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

import { ClaudeAgentProvider } from "./claude-provider.ts";
import type { ImageAttachment, StartThreadInput, TurnInput } from "./types/index.ts";

type QueryArgs = Parameters<typeof query>[0];

/** A `query()` double that captures the args and yields one trivial success. */
function fakeQuery(captured: QueryArgs[]): typeof query {
  return ((args: QueryArgs) => {
    captured.push(args);
    async function* run() {
      yield {
        type: "assistant",
        uuid: "u1",
        message: { content: [{ type: "text", text: "ok" }] },
      };
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

/** Run one turn and return the `prompt` the provider handed the SDK. */
async function sendTurnPrompt(input: TurnInput): Promise<QueryArgs["prompt"]> {
  const captured: QueryArgs[] = [];
  const provider = new ClaudeAgentProvider({
   queryFn: fakeQuery(captured),
  });
  const thread = await provider.startThread({ cwd: "/ws" } as StartThreadInput);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  for await (const _ of provider.sendTurn(thread.id, input)) {
    // drain — the background producer runs the fake query and settles the turn
  }
  return captured[0].prompt;
}

/** Drain a turn's streaming-input prompt (closed once the turn ends). */
async function drainOne(prompt: QueryArgs["prompt"]): Promise<SDKUserMessage[]> {
  assert.notEqual(typeof prompt, "string", "expected a streaming-input prompt, got a string");
  const msgs: SDKUserMessage[] = [];
  for await (const m of prompt as AsyncIterable<SDKUserMessage>) msgs.push(m);
  return msgs;
}

const PNG: ImageAttachment = { dataUrl: "data:image/png;base64,iVBORw0KGgoPNGDATA", name: "a.png" };
const JPEG: ImageAttachment = { dataUrl: "data:image/jpeg;base64,/9j/4AAQJPEGDATA", name: "b.jpg" };
const SVG: ImageAttachment = {
  dataUrl: "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=",
  name: "c.svg",
};

test("no images: the one prompt message carries the plain text string", async () => {
  const prompt = await sendTurnPrompt({ text: "hello" } as TurnInput);
  const msgs = await drainOne(prompt);
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].parent_tool_use_id, null);
  assert.deepEqual(msgs[0].message, { role: "user", content: "hello" });
});

test("two images: the prompt message is [text, image, image]", async () => {
  const prompt = await sendTurnPrompt({ text: "look", images: [PNG, JPEG] } as TurnInput);
  const msgs = await drainOne(prompt);
  assert.equal(msgs.length, 1, "the prompt must carry exactly one message");
  const msg = msgs[0];
  assert.equal(msg.type, "user");
  assert.equal(msg.parent_tool_use_id, null);
  assert.equal(msg.message.role, "user");
  const content = msg.message.content as unknown as Array<Record<string, unknown>>;
  assert.equal(content.length, 3);
  assert.deepEqual(content[0], { type: "text", text: "look" });
  assert.deepEqual(content[1], {
    type: "image",
    source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgoPNGDATA" },
  });
  assert.deepEqual(content[2], {
    type: "image",
    source: { type: "base64", media_type: "image/jpeg", data: "/9j/4AAQJPEGDATA" },
  });
});

test("unsupported subtype (image/svg+xml) is dropped with a warn, others survive", async () => {
  const warnings: string[] = [];
  const orig = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };
  try {
    const prompt = await sendTurnPrompt({ text: "mix", images: [SVG, PNG] } as TurnInput);
    const [msg] = await drainOne(prompt);
    const content = msg.message.content as unknown as Array<Record<string, unknown>>;
    // svg dropped → text block + the one supported png block only.
    assert.equal(content.length, 2);
    assert.deepEqual(content[0], { type: "text", text: "mix" });
    assert.equal((content[1].source as { media_type: string }).media_type, "image/png");
  } finally {
    console.warn = orig;
  }
  assert.ok(
    warnings.some((w) => w.includes("image/svg+xml")),
    "expected a warn naming the dropped subtype",
  );
});

test("only an unsupported image: message still carries the text block", async () => {
  const orig = console.warn;
  console.warn = () => {};
  try {
    const prompt = await sendTurnPrompt({ text: "just text", images: [SVG] } as TurnInput);
    const [msg] = await drainOne(prompt);
    const content = msg.message.content as unknown as Array<Record<string, unknown>>;
    assert.equal(content.length, 1);
    assert.deepEqual(content[0], { type: "text", text: "just text" });
  } finally {
    console.warn = orig;
  }
});
