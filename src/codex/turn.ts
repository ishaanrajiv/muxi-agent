/**
 * One Codex turn as the app-server's notifications drive it: which of the
 * shared process's notifications are this turn's, how a failure, a dead
 * app-server or a timeout ends it, and the `turn/start` request that opens it.
 */

import type { AgentEvent, DocumentAttachment, TurnInput } from "../types/index.ts";

import type { ReasoningEffort as CodexReasoningEffort } from "../generated/ReasoningEffort.ts";
import type { ServerNotification } from "../generated/ServerNotification.ts";
import type { JsonValue } from "../generated/serde_json/JsonValue.ts";
import type { FileUpdateChange } from "../generated/v2/FileUpdateChange.ts";
import type { TokenUsageBreakdown } from "../generated/v2/TokenUsageBreakdown.ts";
import type { TurnStartParams } from "../generated/v2/TurnStartParams.ts";
import type { UserInput } from "../generated/v2/UserInput.ts";
import { NOTICE_CODES, notificationToEvent, turnStatusEvent } from "../normalize.ts";
import type { WorkspaceSettings } from "../provider.ts";
import { errorMessage, type ErrorRaised, TurnOutput, TurnQueue } from "../shared.ts";
import type { CodexSubagents } from "./subagents.ts";
import { workspaceTurnParams } from "./workspace.ts";
import { eventThreadId } from "./threads.ts";

/** What a turn needs from its provider. */
export interface CodexTurnHost {
  /** Restate an event with what only the provider knows: the window behind a
   *  usage-limit stop, a compaction's sizes. */
  decorate(ev: AgentEvent): AgentEvent;
  /** Stop the turn `turnId` in the app-server. */
  interrupt(turnId: string): Promise<void>;
  /** Take the thread-less notices held for the next turn that shows them. */
  takeHeldNotices(): AgentEvent[];
}

/** Per-turn options a caller can set (see `CodexAgentProvider.sendTurnInternal`). */
export interface CodexTurnOptions {
  outputSchema?: JsonValue;
  summary?: "auto" | "concise" | "detailed" | "none";
  timeoutMs?: number;
  /** Raw token counts for this turn, as Codex reports them. The domain
   *  `context.usage` event carries only the occupied total, so a caller that
   *  needs the input/output split (a utility turn's cost) reads it here. */
  onTokenUsage?: (usage: TokenUsageBreakdown) => void;
  /** False for a turn nobody reads (a utility turn): it neither takes held
   *  notices nor counts as a listener, so they wait for a chat turn. */
  showsNotices?: boolean;
  /** What this turn's own `turn.started` carries besides its ids: the prompt,
   *  the selection and the caller's trigger. Codex's notification has none. */
  started?: Partial<Omit<Extract<AgentEvent, { type: "turn.started" }>, "type" | "threadId" | "turnId">>;
}

/**
 * The state of one running turn, fed every notification the app-server sends
 * (it is one shared process, so every notification lands on every in-flight
 * turn) plus its own exit, client errors and the turn timeout. Events go onto
 * {@link queue} for the turn's generator to yield.
 */
export class CodexTurn {
  readonly queue = new TurnQueue<AgentEvent>();
  /** The id Codex gave this turn, once `turn/started` or `turn/start` said. */
  activeTurnId: string | null = null;
  /** The changes each fileChange item announced, by item id: its approval
   *  request names only the item. */
  readonly fileChanges = new Map<string, FileUpdateChange[]>();
  /** The children this turn spawns. With subagents off, any child Codex starts
   *  anyway is stopped as soon as it appears (see `CodexSubagents`). */
  subagents: CodexSubagents | null = null;
  /** Whether the turn produced output, which settles the case Codex leaves
   *  ambiguous: retries exhausted, `turn/completed` with status `completed`,
   *  and nothing in the turn but the failures. A notice (a reroute, a
   *  deprecation) says nothing about why a turn with no output failed, so it
   *  never becomes the warning that gets promoted. */
  private readonly output = new TurnOutput((warning) => !NOTICE_CODES.has(warning.code ?? ""));
  /** A fatal `error` notification, held rather than pushed: Codex follows it
   *  with a failed `turn/completed` carrying the same failure, and the turn must
   *  raise exactly one terminal. Pushed only if that completion never comes. */
  private heldFatal: ErrorRaised | null = null;
  private readonly threadId: string;
  private readonly host: CodexTurnHost;
  private readonly onTokenUsage: ((usage: TokenUsageBreakdown) => void) | undefined;
  private readonly showsNotices: boolean;
  private readonly started: CodexTurnOptions["started"];

  constructor(threadId: string, host: CodexTurnHost, options: CodexTurnOptions) {
    this.threadId = threadId;
    this.host = host;
    this.onTokenUsage = options.onTokenUsage;
    this.showsNotices = options.showsNotices ?? true;
    this.started = options.started;
  }

  push(raw: AgentEvent): void {
    const stamped =
      raw.type === "turn.started" && raw.threadId === this.threadId && this.started ? { ...raw, ...this.started } : raw;
    const ev = this.host.decorate(stamped);
    // No subagent outlives its turn, so none reads as running after it.
    if (ev.type === "turn.completed" || (ev.type === "error.raised" && ev.fatal !== false)) this.subagents?.stopAll("ended");
    this.output.note(ev);
    this.queue.push(ev);
  }

  onNotification(n: ServerNotification): void {
    const { threadId } = this;
    // The turn already has its terminal event. Notifications can still arrive
    // (the app-server is mid-retry, and our listener lives until the consumer
    // resumes) — pushing them would append events after the turn closed, which
    // is exactly what strands a stray bubble in the transcript.
    if (this.queue.done) return;
    // A child's items become its subagent's row. Its own events never reach
    // this turn's stream: they carry the child's thread id (see `ours`).
    this.subagents?.onNotification(n);
    if (n.method === "turn/started" && n.params.threadId === threadId) {
      this.activeTurnId = n.params.turn.id;
    }
    if (n.method === "item/started" && n.params.threadId === threadId && n.params.item.type === "fileChange") {
      this.fileChanges.set(n.params.item.id, n.params.item.changes);
    }
    if (n.method === "thread/tokenUsage/updated" && n.params.threadId === threadId) {
      this.onTokenUsage?.(n.params.tokenUsage.last);
    }
    // Every notification lands on every in-flight turn — including `error`
    // events, which now carry the thread they belong to. Anything not addressed
    // to a thread (older builds) still passes through: an unattributed error
    // beats none.
    const ev = notificationToEvent(n);
    const ours = ev ? eventThreadId(ev) : null;
    const isOurCompletion =
      n.method === "turn/completed" &&
      n.params.threadId === threadId &&
      (this.activeTurnId == null || n.params.turn.id === this.activeTurnId);
    // A late error for an earlier turn on this thread (one already stopped)
    // is that turn's business, not this one's.
    if (
      ev?.type === "error.raised" &&
      ev.turnId != null &&
      this.activeTurnId != null &&
      ev.turnId !== this.activeTurnId
    ) {
      return;
    }
    // A turn Codex marks `failed` carries its reason in `turn.error`. Raise it
    // as the turn's terminal event *instead of* `turn.completed`, so a failed
    // turn can never close as a silent success; an `interrupted` turn's error
    // is only a warning and still completes.
    // An auth failure is not transient: Codex still flags it `willRetry` and
    // walks its whole retry ladder (nine attempts, ~40s of "Reconnecting… n/5")
    // against a credential that cannot appear mid-turn. End the turn on the
    // FIRST one — one sentence, straight away — and interrupt the app-server so
    // it stops retrying in the background after we've stopped listening.
    if (ev?.type === "error.raised" && ev.code === "not_logged_in" && (ours == null || ours === threadId)) {
      this.push({ ...ev, fatal: true });
      this.interruptAfter("an auth failure");
      this.queue.end();
      return;
    }
    if (
      n.method === "error" &&
      ev?.type === "error.raised" &&
      ev.fatal !== false &&
      (ours == null || ours === threadId)
    ) {
      this.heldFatal = ev;
      return;
    }
    const statusEvent = isOurCompletion
      ? (turnStatusEvent(n.params.threadId, n.params.turn) ??
        this.heldFatal ??
        // Codex reports retries-exhausted as a plain `completed` turn: no
        // error, no answer, just the warnings it raised on the way. Promote the
        // last one to this turn's terminal event so the failure is stated once,
        // with its cause, instead of the chat ending on an unexplained silence.
        this.output.promoted())
      : null;
    // A child still running when the main agent answered would run on unseen.
    if (isOurCompletion) this.subagents?.stopAll("answered");
    if (statusEvent) this.push(statusEvent);
    const failed = statusEvent?.type === "error.raised" && statusEvent.fatal === true;
    if (ev && !failed && (ours == null || ours === threadId)) this.push(ev);
    if (ev?.type === "turn.started" && ours === threadId && this.showsNotices) {
      for (const notice of this.host.takeHeldNotices()) this.push(notice);
    }
    if (isOurCompletion) this.queue.end();
  }

  onClientError(err: Error): void {
    this.queue.failure = err;
    this.queue.end();
  }

  /**
   * If the app-server process dies mid-turn (killed externally, panicked), the
   * client emits `exit` — NOT `error` — and no further notifications arrive.
   * Without this the turn's stream would never end and the caller would wait
   * on a turn that can't finish.
   * End the turn with a clear failure so the orchestrator records `error.raised`
   * and the conversation returns to idle. `stderrTail` is the process's last
   * words.
   */
  onExit(code: number | null, stderrTail: string): void {
    if (this.heldFatal) {
      // Codex already stated the failure before it died; that is the cause.
      this.push(this.heldFatal);
    } else if (!this.queue.failure) {
      // The process's own last words are the only diagnostic for a panic or an
      // auth failure printed on the way out — carry them into the message.
      this.queue.failure = new Error(
        `Codex app-server exited (code ${code ?? "unknown"}) before the turn completed` +
          (stderrTail ? `: ${stderrTail}` : ""),
      );
    }
    this.queue.end();
  }

  onTimeout(timeoutMs: number): void {
    // A stated failure whose completion never arrived is still the cause.
    if (this.heldFatal) this.push(this.heldFatal);
    else this.queue.failure = new Error(`Turn timed out after ${timeoutMs}ms`);
    // Giving up on the turn does not stop it: the app-server keeps executing
    // (tools, model calls) long after we've stopped listening. Interrupt it
    // first, best-effort — a failed interrupt must never replace the timeout
    // as the turn's reported failure.
    this.interruptAfter("a timeout");
    this.queue.end();
  }

  /** Interrupt the running turn, best-effort, logging a failure. */
  private interruptAfter(reason: string): void {
    const turnId = this.activeTurnId;
    if (!turnId) return;
    void this.host.interrupt(turnId).catch((err: unknown) => {
      console.warn(`[codex] could not interrupt turn ${turnId} after ${reason}: ${errorMessage(err)}`);
    });
  }
}

/**
 * A turn's documents as text for a backend that reads no document input: each
 * text file inline as `<document name="…">…</document>`, each PDF as a one-line
 * note that it was attached and can't be read, so the model says so instead of
 * guessing at its contents. They go ahead of the message, as Claude's document
 * blocks do.
 */
export function documentsText(documents: readonly DocumentAttachment[]): string {
  return documents
    .map((doc) =>
      doc.mediaType === "application/pdf"
        ? `[Attached PDF "${doc.name}" — this model can't read PDFs]`
        : `<document name="${escapeAttribute(doc.name)}">\n${doc.data}\n</document>`,
    )
    .join("\n\n");
}

/** A value made safe for a double-quoted attribute. */
function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** What a turn's `turn/start` request is built from. */
export interface TurnStart {
  threadId: string;
  input: TurnInput;
  /** The workspace steering this turn opens with (see
   *  `CodexAgentProvider.workspaceIntros`). */
  intro: string | undefined;
  /** The effort, already clamped to the model's scale. */
  effort: string | undefined;
  options: CodexTurnOptions;
  workspace: WorkspaceSettings | undefined;
  /** The workspace thread's permission profile id, when it has one. */
  profile: string | undefined;
}

/**
 * The `turn/start` params. Per-turn model/effort/service-tier overrides are all
 * sticky in Codex: they carry to later turns until changed. The text item
 * leads; each attached image follows as its own `UserInput` (the data URI rides
 * inline in `url`, so Codex needs no local file). Codex takes no document
 * input, so documents ride in the text ({@link documentsText}). A turn's
 * `outputSchema` constrains its final message to that JSON schema.
 */
export function turnStartParams(start: TurnStart): TurnStartParams {
  const { threadId, input, intro, effort, options, workspace } = start;
  const message = input.documents?.length ? `${documentsText(input.documents)}\n\n${input.text}` : input.text;
  const text = intro ? `${intro}\n\n${message}` : message;
  const items: UserInput[] = [{ type: "text", text, text_elements: [] }];
  for (const img of input.images ?? []) {
    items.push({ type: "image", url: img.dataUrl });
  }
  const params: TurnStartParams = {
    threadId,
    input: items,
  };
  if (input.model) params.model = input.model;
  if (effort) params.effort = effort as CodexReasoningEffort;
  // Unlike an omitted value, null actively returns a sticky Codex thread
  // from a faster tier to Standard.
  if (input.serviceTier !== undefined) params.serviceTier = input.serviceTier;
  // Callers get short work labels, not the most detailed available trace.
  // `concise` keeps reasoning quality unchanged while reducing summary text;
  // the provider normalizer turns the returned entries into typed rows.
  params.summary = options.summary ?? "concise";
  const outputSchema = options.outputSchema ?? (input.outputSchema as JsonValue | undefined);
  if (outputSchema) params.outputSchema = outputSchema;
  if (workspace) Object.assign(params, workspaceTurnParams(workspace, start.profile));
  return params;
}
