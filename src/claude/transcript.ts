/**
 * A Claude session's transcript as this package cuts it: which entries open a turn,
 * and where a fork or a rollback slices it.
 */

import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";

import { loadSdk } from "./sdk.ts";

/** A session transcript plus the indexes of the messages that START each turn
 *  (its human prompts). Produced by
 *  {@link readTranscript}, consumed by {@link cutUuid}. */
export interface Transcript {
  msgs: SessionMessage[];
  starts: number[];
}

/** The text the CLI writes into the transcript, as a `user` entry, when a turn
 *  is interrupted mid-stream or mid-tool. It closes the stopped turn. */
const INTERRUPT_MARKER_RE = /^\[Request interrupted by user( for tool use)?\]$/;

/**
 * Whether a transcript entry is a human prompt, i.e. the start of a turn. Tool
 * results also come back as top-level `user` entries with no parent tool call,
 * and so does the interrupt marker a Stop leaves, so the content decides: a
 * prompt is a string or carries at least one part that is neither a
 * `tool_result` nor that marker (text, image). A subagent's entries name their
 * spawning call in `parent_tool_use_id` and are never turn starts. Neither are
 * entries the CLI wrote itself, such as the summary a compaction leaves:
 * `getSessionMessages` marks those `is_meta`.
 */
export function isClaudeHumanTurnStart(m: SessionMessage): boolean {
  if (m.type !== "user" || m.parent_tool_use_id != null) return false;
  if ((m as { is_meta?: boolean }).is_meta === true) return false;
  const content = (m.message as { content?: unknown } | null)?.content;
  if (typeof content === "string") return !INTERRUPT_MARKER_RE.test(content.trim());
  return (
    Array.isArray(content) &&
    content.some((part) => {
      const p = part as { type?: unknown; text?: unknown } | null;
      if (p?.type === "tool_result") return false;
      return !(p?.type === "text" && typeof p.text === "string" && INTERRUPT_MARKER_RE.test(p.text.trim()));
    })
  );
}

/**
 * The message uuid to slice a fork at when keeping the first `keepTurns` turns:
 * the LAST chain entry of the last kept turn, i.e. the entry just before the
 * human prompt that opens turn `keepTurns`. Deliberately not the kept turn's last
 * assistant message: a turn ending in structured output or a tool tail carries
 * further entries that belong to it, and cutting before them would discard the
 * kept turn's own payload. Returns undefined when every turn is kept (fork the
 * whole transcript) or when the boundary is the very first message.
 */
export function cutUuid({ msgs, starts }: Transcript, keepTurns: number): string | undefined {
  if (keepTurns >= starts.length) return undefined;
  const boundary = starts[keepTurns];
  return boundary > 0 ? msgs[boundary - 1].uuid : undefined;
}

/**
 * How many of a transcript's human prompts survive a cut, i.e. the `keepTurns`
 * to hand {@link cutUuid}. A fork keeps the first `keepTurns` turns; a rollback
 * drops the last `dropTurns`. A turn opens on one prompt. A steer the CLI ran as
 * its own prompt adds one more, carrying exactly the steered text, and a steer
 * it folded into a tool round adds none, so a turn's prompt count cannot be
 * known from the log alone. `steersPerTurn` (oldest turn first) says what each
 * turn was steered with, and each steer claims the next prompt only if that
 * prompt is its text. The walk starts from the end the cut leaves in place:
 * the first turn for a fork, the last for a rollback.
 */
export function keptPrompts(
  { msgs, starts }: Transcript,
  cut: { keepTurns: number } | { dropTurns: number },
  steersPerTurn: readonly (readonly string[])[] = [],
): number {
  const isSteer = (at: number, steer: string) => promptText(msgs[starts[at]]) === steer.trim();
  if ("keepTurns" in cut) {
    let at = 0;
    for (let turn = 0; turn < cut.keepTurns && at < starts.length; turn++) {
      at += 1; // the prompt that opened the turn
      for (const steer of steersPerTurn[turn] ?? []) {
        if (at < starts.length && isSteer(at, steer)) at += 1;
      }
    }
    return at;
  }
  let at = starts.length;
  for (let back = 0; back < cut.dropTurns && at > 0; back++) {
    const steers = steersPerTurn[steersPerTurn.length - 1 - back] ?? [];
    // The first prompt of the transcript always opened a turn.
    for (let s = steers.length - 1; s >= 0; s--) {
      if (at > 1 && isSteer(at - 1, steers[s])) at -= 1;
    }
    at -= 1; // the prompt that opened the turn
  }
  return at;
}

/** The text of a human prompt entry: its string content, or its text parts. */
function promptText(m: SessionMessage): string {
  const content = (m.message as { content?: unknown } | null)?.content;
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((part) => {
      const p = part as { type?: unknown; text?: unknown } | null;
      return p?.type === "text" && typeof p.text === "string" ? [p.text] : [];
    })
    .join("\n")
    .trim();
}

/** Read a session's transcript and locate its turn starts (see
 *  {@link isClaudeHumanTurnStart}). System entries are included because a
 *  turn's tail can be one (a `structured_output` attachment) — the cut has to
 *  land after it, see {@link cutUuid}. */
export async function readTranscript(sessionId: string): Promise<Transcript> {
  const { getSessionMessages } = await loadSdk();
  const msgs = await getSessionMessages(sessionId, { includeSystemMessages: true });
  const starts = msgs.flatMap((m, i) => (isClaudeHumanTurnStart(m) ? [i] : []));
  return { msgs, starts };
}
