/**
 * Codex usage windows: which bucket to read, how to fold the app-server's
 * sparse `account/rateLimits/updated` pushes into it, how a snapshot reads as
 * the normalized usage, and the sentence a usage-limit stop puts on the turn.
 */

import type { ProviderUsage, UsageWindow } from "./types/index.ts";

import type { GetAccountRateLimitsResponse } from "./generated/v2/GetAccountRateLimitsResponse.ts";
import type { RateLimitSnapshot } from "./generated/v2/RateLimitSnapshot.ts";
import type { RateLimitWindow } from "./generated/v2/RateLimitWindow.ts";
import { capitalize, epochToIso } from "./shared.ts";
import { codexWindowLabel, usageLimitMessage } from "./usage-limit.ts";

/** The metered bucket chat turns draw from. */
export const CODEX_LIMIT_ID = "codex";

/** The `codex` bucket of a read, falling back to the single-bucket view older
 *  builds send. */
export function codexBucket(res: GetAccountRateLimitsResponse): RateLimitSnapshot | null {
  return res.rateLimitsByLimitId?.[CODEX_LIMIT_ID] ?? res.rateLimits ?? null;
}

/** Whether a pushed snapshot is for the `codex` bucket. A push without a
 *  `limitId` comes from a single-bucket build, where it is the only bucket. */
export function isCodexBucket(snap: RateLimitSnapshot): boolean {
  return snap.limitId == null || snap.limitId === CODEX_LIMIT_ID;
}

/**
 * Fold a sparse update into the last snapshot. A push leaves out what it
 * doesn't know by sending null, and a null never clears a value we hold, so
 * the merge keeps every field the push has as null.
 */
export function mergeRateLimits(
  prev: RateLimitSnapshot | null,
  next: RateLimitSnapshot,
): RateLimitSnapshot {
  if (!prev) return next;
  const merged: Record<string, unknown> = { ...prev };
  for (const [key, value] of Object.entries(next)) {
    if (value != null) merged[key] = value;
  }
  return merged as RateLimitSnapshot;
}

/** The window that ran out: the one at 100% that resets last, since that is
 *  when the account can run again. */
export function exhaustedWindow(snap: RateLimitSnapshot | null): RateLimitWindow | null {
  const full = [snap?.primary, snap?.secondary].filter(
    (w): w is RateLimitWindow => w != null && w.usedPercent >= 100,
  );
  if (full.length === 0) return null;
  return full.reduce((a, b) => ((b.resetsAt ?? 0) > (a.resetsAt ?? 0) ? b : a));
}

/** The usage-limit sentence for this snapshot, or null when no window reads
 *  as exhausted (then Codex's own prose is the better sentence). */
export function codexUsageLimitMessage(
  snap: RateLimitSnapshot | null,
  opts: { now?: Date; timeZone?: string } = {},
): string | null {
  const window = exhaustedWindow(snap);
  if (!window) return null;
  return usageLimitMessage(
    "Codex",
    {
      label: codexWindowLabel(window.windowDurationMins),
      resetsAt: window.resetsAt != null ? new Date(window.resetsAt * 1000) : null,
    },
    opts,
  );
}

/**
 * Map a Codex `RateLimitSnapshot` (primary = the shorter, usually 5h window;
 * secondary = the weekly window) onto the normalized {@link ProviderUsage}.
 * Null when the snapshot has no window to show (e.g. API-key auth yields a
 * snapshot with none), so the caller hides the indicator.
 */
export function codexUsage(snap: RateLimitSnapshot | null, providerId: string): ProviderUsage | null {
  if (!snap) return null;
  const windows = [
    toUsageWindow(snap.primary, snap.limitName ?? "Current"),
    toUsageWindow(snap.secondary, "Weekly"),
  ].filter((w): w is UsageWindow => w != null);
  if (windows.length === 0) return null;
  return {
    provider: providerId,
    plan: snap.planType ? capitalize(snap.planType) : null,
    windows,
    scope: "account",
    note: null,
    fetchedAt: new Date().toISOString(),
  };
}

/**
 * Map a Codex `RateLimitWindow` to a normalized {@link UsageWindow}, or `null`
 * when the window is absent. The window's own duration drives the label (so a
 * 300-min bucket reads "5h" and a 10080-min one "Weekly") unless the snapshot
 * gave a more specific name. `resetsAt` is a unix epoch — seconds historically,
 * tolerated as ms — converted to ISO 8601.
 */
function toUsageWindow(w: RateLimitWindow | null, fallbackLabel: string): UsageWindow | null {
  if (!w) return null;
  return {
    label: w.windowDurationMins != null ? formatWindowLabel(w.windowDurationMins) : fallbackLabel,
    usedPercent: w.usedPercent,
    resetsAt: epochToIso(w.resetsAt),
    resetsLabel: null,
    windowMins: w.windowDurationMins,
  };
}

/** A short human label for a rolling window given its duration in minutes. */
function formatWindowLabel(mins: number): string {
  if (mins % 10080 === 0) return mins === 10080 ? "Weekly" : `${mins / 10080}-week`;
  if (mins % 1440 === 0) return mins === 1440 ? "Daily" : `${mins / 1440}d`;
  if (mins % 60 === 0) return `${mins / 60}h`;
  return `${mins}m`;
}
