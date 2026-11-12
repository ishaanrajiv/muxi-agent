/**
 * Code both providers share: the per-turn event queue a turn's generator
 * drains, the rule that restates a turn's last warning as its failure when the
 * turn produced nothing else, the not-found error for an approval whose turn is
 * gone, the prompt a `turn.started` carries, and a few small formatting
 * helpers.
 */

import type { AgentEvent, TurnInput, UserPrompt } from "./types/index.ts";

/** An `error.raised` event. */
export type ErrorRaised = Extract<AgentEvent, { type: "error.raised" }>;

/** The message of a thrown value, whatever was thrown. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** A thrown value as an Error, wrapping anything that isn't one. */
export function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

/** The prompt a turn's `turn.started` carries: the text, the images, and the
 *  documents by name only, so a host's event log never holds their contents. */
export function userPrompt(input: TurnInput): UserPrompt {
  return {
    text: input.text,
    ...(input.images?.length ? { images: input.images } : {}),
    ...(input.documents?.length
      ? { documents: input.documents.map((d) => ({ name: d.name, mediaType: d.mediaType })) }
      : {}),
  };
}

/** `execFile`, promisified, loaded on first use: only the CLI shell-outs (a
 *  probe, a usage read, an MCP registration) need it. */
export async function loadExecFile() {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  return promisify(execFile);
}

/**
 * Thrown by `resolveApproval` when the in-memory pending-approval entry is
 * gone: the originating turn died (e.g. the app-server restarted) so the live
 * connection has no request to answer. Distinct from a generic transport error
 * so callers can clear the orphaned record instead of surfacing a 500. Both
 * backends throw this one class, so the orchestrator's `instanceof` not-found
 * handling stays provider-agnostic.
 */
export class PendingApprovalNotFoundError extends Error {
  constructor(requestId: number | string) {
    super(`No pending approval for request ${requestId}`);
    this.name = "PendingApprovalNotFoundError";
  }
}

/**
 * One turn's event queue. Producers (the backend's listeners or message loop)
 * push; the turn's generator yields everything queued, and waits for the next
 * push once the queue runs dry, until the turn is {@link done}.
 */
export class TurnQueue<T> {
  private readonly items: T[] = [];
  private wake: (() => void) | null = null;
  /** Set once the turn has nothing more to say. */
  done = false;
  /** Why the turn failed, when it did. The turn's generator throws it. */
  failure: Error | null = null;

  push(item: T): void {
    this.items.push(item);
    this.ping();
  }

  /** The oldest queued item, or undefined when the queue is empty. */
  shift(): T | undefined {
    return this.items.shift();
  }

  /** Mark the turn over and wake the generator. */
  end(): void {
    this.done = true;
    this.ping();
  }

  /** Wake the generator if it is waiting. */
  ping(): void {
    if (this.wake) {
      const w = this.wake;
      this.wake = null;
      w();
    }
  }

  /** Resolves at the next {@link ping}. */
  wait(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.wake = resolve;
    });
  }
}

/** Events that count as a turn having produced something a reader would call
 *  output (an answer, reasoning, a tool call). `agent.plan.updated` is
 *  deliberately NOT content: a plan is bookkeeping, not an answer. A turn that
 *  only planned and then exhausted its retries must still state its failure. */
const CONTENT_EVENTS: ReadonlySet<string> = new Set([
  "agent.message.delta",
  "agent.message.completed",
  "agent.reasoning.delta",
  "agent.reasoning.completed",
  "tool.started",
  "tool.completed",
]);

/**
 * What a turn has produced so far, which settles the case both backends leave
 * ambiguous: retries exhausted, the turn closed as a success, and nothing in
 * it but the warnings raised on the way. That is not a success, and closing it
 * as one leaves the chat showing warnings and no outcome at all.
 */
export class TurnOutput {
  private sawContent = false;
  private lastWarning: ErrorRaised | null = null;
  private readonly promotable: (warning: ErrorRaised) => boolean;

  /** `promotable` says which non-fatal warnings may become the turn's stated
   *  failure. A notice or a user Stop says nothing about why a turn failed. */
  constructor(promotable: (warning: ErrorRaised) => boolean) {
    this.promotable = promotable;
  }

  /** Record one event the turn emitted. */
  note(ev: AgentEvent): void {
    if (CONTENT_EVENTS.has(ev.type)) this.sawContent = true;
    if (ev.type === "error.raised" && ev.fatal === false && this.promotable(ev)) {
      this.lastWarning = ev;
    }
  }

  /** The turn's last warning restated as its terminal failure, when the turn
   *  produced nothing else. Null whenever there is real output or no warning. */
  promoted(): ErrorRaised | null {
    return !this.sawContent && this.lastWarning ? { ...this.lastWarning, fatal: true } : null;
  }
}

/** Epoch seconds or milliseconds as a Date. */
export function epochToDate(epoch: number): Date {
  return new Date(epoch < 1e12 ? epoch * 1000 : epoch);
}

/** A unix epoch (seconds or ms) as ISO 8601, or null. */
export function epochToIso(epoch: number | null): string | null {
  return epoch == null ? null : epochToDate(epoch).toISOString();
}

/** `s` with its first letter upper-cased. */
export function capitalize(s: string): string {
  return s.length ? s[0].toUpperCase() + s.slice(1) : s;
}
