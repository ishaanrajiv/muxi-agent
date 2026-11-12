/**
 * The one sentence a usage-limit stop puts on the turn, shared by both
 * backends: which window ran out and when it resets. Written here rather than
 * in the web because only the provider knows the window, and the server runs on
 * the reader's own machine, so its clock and time zone are theirs.
 */

/** The window that ran out, as the provider knows it. */
export interface ExhaustedWindow {
  /** A short label that reads after "its": "5-hour", "weekly". */
  label: string | null;
  /** When the window resets, if the backend said. */
  resetsAt: Date | null;
}

/** Claude's `rateLimitType` → the label a person knows. */
const CLAUDE_WINDOW_LABELS: Record<string, string> = {
  five_hour: "5-hour",
  seven_day: "weekly",
  seven_day_opus: "weekly Opus",
  seven_day_sonnet: "weekly Sonnet",
  seven_day_overage_included: "weekly",
  overage: "extra usage",
};

export function claudeWindowLabel(rateLimitType: string | undefined): string | null {
  return rateLimitType ? (CLAUDE_WINDOW_LABELS[rateLimitType] ?? null) : null;
}

/** A Codex window length in minutes → its label. */
export function codexWindowLabel(minutes: number | null | undefined): string | null {
  if (minutes == null || minutes <= 0) return null;
  if (minutes === 10_080) return "weekly";
  if (minutes === 1_440) return "daily";
  if (minutes % 60 === 0) return `${minutes / 60}-hour`;
  return `${minutes}-minute`;
}

/**
 * "Codex hit its weekly usage limit. It resets on Thu, Sep 25 at 3:40 PM."
 * The date is left out when the reset is within the next 24 hours.
 */
export function usageLimitMessage(
  provider: string,
  window: ExhaustedWindow,
  opts: { now?: Date; timeZone?: string } = {},
): string {
  const head = window.label
    ? `${provider} hit its ${window.label} usage limit.`
    : `${provider} hit its usage limit.`;
  if (!window.resetsAt) return head;
  const now = opts.now ?? new Date();
  const zone = opts.timeZone ? { timeZone: opts.timeZone } : {};
  const time = window.resetsAt.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", ...zone });
  if (window.resetsAt.getTime() - now.getTime() < 24 * 60 * 60_000) return `${head} It resets at ${time}.`;
  const day = window.resetsAt.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    ...zone,
  });
  return `${head} It resets on ${day} at ${time}.`;
}
