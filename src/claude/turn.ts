/**
 * One Claude chat turn's live parts: the streaming-input prompt that carries
 * its opening message and any steers, the registration a Stop or a steer
 * reaches it through, and how the turn is stopped.
 */

import type { AgentEvent, DocumentAttachment, ImageAttachment } from "../types/index.ts";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

import { errorMessage } from "../shared.ts";
import type { TurnSubagents } from "./subagents.ts";

/** How long a user Stop waits for the CLI's own `interrupt()` before the stream is
 *  torn down anyway. Shorter than the timeout's grace: a human is watching. */
export const INTERRUPT_GRACE_MS = 2000;

/** The sentence a user Stop puts on the turn. Codex reports a stopped turn as a
 *  non-fatal `interrupted` warning (see `turnStatusEvent`), so Claude says the
 *  same thing with the same code. */
export const INTERRUPT_MESSAGE = "Stopped on your request; the turn ended where it was.";

/** Whether an event closes its turn: `turn.completed` or a fatal error (absent
 *  `fatal` means fatal). */
export function isTerminalEvent(ev: AgentEvent): boolean {
  return ev.type === "turn.completed" || (ev.type === "error.raised" && ev.fatal !== false);
}

/**
 * The streaming-input prompt of one chat turn. The SDK pulls from it for as
 * long as it stays open, so a message pushed while the turn runs reaches the
 * CLI mid-turn (a steer); closing it ends the CLI's input, and the CLI exits
 * once it has answered everything it was sent.
 */
export class PromptChannel implements AsyncIterable<SDKUserMessage> {
  private readonly buffered: SDKUserMessage[] = [];
  private waiter: ((next: IteratorResult<SDKUserMessage>) => void) | null = null;
  private closed = false;

  get isClosed(): boolean {
    return this.closed;
  }

  push(msg: SDKUserMessage): void {
    if (this.closed) throw new Error("prompt channel is closed");
    const waiter = this.waiter;
    this.waiter = null;
    if (waiter) waiter({ value: msg, done: false });
    else this.buffered.push(msg);
  }

  /** Idempotent. Messages already pushed are still delivered. */
  close(): void {
    this.closed = true;
    const waiter = this.waiter;
    this.waiter = null;
    waiter?.({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const msg = this.buffered.shift();
        if (msg) return Promise.resolve({ value: msg, done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => {
          this.waiter = resolve;
        });
      },
      return: () => {
        this.close();
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}

/** One in-flight chat turn, registered for the lifetime of its stream so
 *  `ClaudeCodeAgentProvider.interrupt` can reach the SDK query behind it
 *  (graceful stop) as well as its abort controller (the fallback) and put the
 *  stop warning on the turn, and so `ClaudeCodeAgentProvider.steerTurn`
 *  can reach its prompt. */
export interface LiveTurn {
  turnId: string;
  /** Masks the turn's MCP credentials in what's logged about it. */
  redact?: (text: string) => string;
  /** The SDK query object; `interrupt()` is what stops the CLI's in-flight work,
   *  and `stopTask()` one subagent. */
  q: { interrupt?: () => Promise<unknown>; stopTask?: (taskId: string) => Promise<void> };
  controller: AbortController;
  /** Emit an event onto the turn's stream (the same `push` `sendTurn` uses). */
  emit: (ev: AgentEvent) => void;
  /** Whether the turn already has its terminal event. A Stop that lost the race
   *  must not append to a closed turn. */
  isSettled: () => boolean;
  /** The turn's prompt, open until its last result. */
  input: PromptChannel;
  /** Whether a steer may be pushed now. Off while a result is being judged
   *  (it may be the turn's last) and for good once the input closes. */
  accepting: boolean;
  /** Client uuids of the steers pushed onto this turn that no result has
   *  echoed yet. Any result answers the opening prompt, so it is not tracked:
   *  the turn is over at the first result that leaves this empty. */
  pushed: Set<string>;
  /** Each pushed steer's caller id, by its client uuid, for its read receipt. */
  steerIds: Map<string, string>;
  /** The turn's subagents, or null when it may start none. */
  subagents: TurnSubagents | null;
}

/** Close a turn's prompt; no steer is taken after this. Idempotent. */
export function closeTurnInput(live: LiveTurn): void {
  live.accepting = false;
  live.input.close();
}

/** The client uuids of the prompts a result says its turn consumed. A producer
 *  too old to say (neither field set) is taken to have consumed everything
 *  sent, which is what one result per turn meant before steering. */
export function consumedPrompts(
  msg: { user_message_uuid?: string; user_message_uuids?: string[] },
  sent: ReadonlySet<string>,
): string[] {
  return msg.user_message_uuids ?? (msg.user_message_uuid ? [msg.user_message_uuid] : [...sent]);
}

/** The image subtypes the Anthropic API accepts as base64 content blocks. An
 *  `ImageAttachment.dataUrl` may carry any `image/*` subtype (a caller may only
 *  check the `image/` prefix), so anything outside this set is dropped rather
 *  than sent — the API would reject the whole message otherwise. */
const CLAUDE_IMAGE_MEDIA_TYPES: ReadonlySet<string> = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

type ClaudeImageMediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

/** A `document` content block: a PDF as base64 or a text file as plain text,
 *  titled with the file's name. */
type ClaudeDocumentBlock = {
  type: "document";
  source:
    | { type: "base64"; media_type: "application/pdf"; data: string }
    | { type: "text"; media_type: "text/plain"; data: string };
  title: string;
};

/** The `document` block for one attachment. */
function claudeDocumentBlock(doc: DocumentAttachment): ClaudeDocumentBlock {
  return {
    type: "document",
    source:
      doc.mediaType === "application/pdf"
        ? { type: "base64", media_type: "application/pdf", data: doc.data }
        : { type: "text", media_type: "text/plain", data: doc.data },
    title: doc.name,
  };
}

/**
 * Build the opening message of a chat turn, stamped with `uuid` (the turn id) as
 * its client uuid so the result that answers it can be matched to it. Text-only
 * content stays the plain string it has always been, so the transcript entry
 * reads the same. With attachments the SDK needs structured content: one
 * `document` block per document first (the API reads long material best ahead
 * of the question), then the text block, then one image block per supported
 * image.
 *
 * Each `dataUrl` is `data:<media_type>;base64,<data>`; the block wants the media
 * type and the raw base64 *without* the `data:` prefix. Subtypes the Anthropic
 * API doesn't accept ({@link CLAUDE_IMAGE_MEDIA_TYPES}) are dropped with a warn
 * instead of sent, since one unsupported block would fail the whole request. If
 * every image drops, the message still carries the text block.
 */
export function buildClaudeUserMessage(
  text: string,
  images: ImageAttachment[] | undefined,
  uuid: string,
  documents?: DocumentAttachment[],
): SDKUserMessage {
  if (!images?.length && !documents?.length) {
    return {
      type: "user",
      parent_tool_use_id: null,
      uuid,
      message: { role: "user", content: text },
    } as SDKUserMessage;
  }
  const imageBlocks: Array<{
    type: "image";
    source: { type: "base64"; media_type: ClaudeImageMediaType; data: string };
  }> = [];
  for (const img of images ?? []) {
    const parsed = parseImageDataUrl(img.dataUrl);
    if (!parsed) {
      console.warn(`[claude-code] dropping unparseable image data URL${img.name ? ` (${img.name})` : ""}`);
      continue;
    }
    if (!CLAUDE_IMAGE_MEDIA_TYPES.has(parsed.mediaType)) {
      console.warn(`[claude-code] dropping unsupported image type "${parsed.mediaType}"${img.name ? ` (${img.name})` : ""}`);
      continue;
    }
    imageBlocks.push({
      type: "image",
      source: {
        type: "base64",
        media_type: parsed.mediaType as ClaudeImageMediaType,
        data: parsed.data,
      },
    });
  }
  return {
    type: "user",
    parent_tool_use_id: null,
    uuid,
    message: {
      role: "user",
      content: [...(documents ?? []).map(claudeDocumentBlock), { type: "text", text }, ...imageBlocks],
    },
  } as SDKUserMessage;
}

/** Split a `data:<media_type>;base64,<data>` URI into its media type and raw
 *  base64 payload. Null when the shape isn't a base64 data URI. */
function parseImageDataUrl(dataUrl: string): { mediaType: string; data: string } | null {
  const m = dataUrl.match(/^data:([^;,]+);base64,(.*)$/s);
  if (!m) return null;
  return { mediaType: m[1].toLowerCase(), data: m[2] };
}

/**
 * Stop a running CLI turn: graceful `interrupt()` first (bounded by `graceMs`,
 * skipped on an SDK that doesn't expose it), then abort unconditionally. Never
 * throws — the caller's own failure is the one that must reach the reader.
 */
export async function stopTurn(
  q: { interrupt?: () => Promise<unknown> },
  controller: { abort: () => void },
  label: string,
  graceMs = 5000,
  /** Masks the turn's MCP credentials in the logged SDK error. */
  redact: (text: string) => string = (text) => text,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (typeof q.interrupt === "function") {
      await Promise.race([
        q.interrupt(),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, graceMs);
        }),
      ]);
    }
  } catch (err) {
    console.warn(`[claude-code] could not interrupt ${label}: ${redact(errorMessage(err))}`);
  } finally {
    if (timer) clearTimeout(timer);
    controller.abort();
  }
}
