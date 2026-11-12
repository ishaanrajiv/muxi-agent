/**
 * What a Claude turn and the account have used: the context window a turn
 * fills, and the subscription's usage windows, read structured from the SDK or
 * scraped from `claude -p "/usage"`.
 */

import type { ProviderUsage, UsageWindow } from "../types/index.ts";

import { resolveClaudeExecutable } from "../claude-binary.ts";
import { capitalize, loadExecFile } from "../shared.ts";
import { SANDBOX_OFF_SETTINGS_ARGS } from "./sdk.ts";

/**
 * Pick the context-window size for the turn from the `result` message's
 * `modelUsage` map (keyed by model slug). Prefer the entry matching the thread's
 * model; otherwise fall back to the largest window reported (a turn can touch a
 * secondary model — e.g. a small one for a side task — whose smaller window
 * isn't the conversation's true ceiling). Null when nothing usable is present.
 */
export function pickContextWindow(
  modelUsage: Record<string, { contextWindow: number }> | undefined,
  model: string | undefined,
): number | null {
  const entries = Object.entries(modelUsage ?? {});
  if (entries.length === 0) return null;
  if (model) {
    const hit = entries.find(([k]) => k === model || k.includes(model) || model.includes(k));
    if (hit && hit[1].contextWindow > 0) return hit[1].contextWindow;
  }
  const max = Math.max(...entries.map(([, v]) => v.contextWindow ?? 0));
  return max > 0 ? max : null;
}

/** Subset of the SDK's `getContextUsage()` response (the data behind `/context`)
 *  we read — the authoritative total/window plus the per-category breakdown. */
type SdkContextUsage = {
  categories?: Array<{ name?: unknown; tokens?: unknown; kind?: unknown }>;
  totalTokens?: number;
  maxTokens?: number;
};

/**
 * Read the live context-window breakdown for the just-settled turn from the SDK
 * (`getContextUsage()`, the data behind `/context`). Bounded by a short timeout
 * so a slow or unsupported control call never delays `turn.completed`; returns
 * null on timeout/error or an SDK without the method. The breakdown keeps only
 * the rows the SDK marks `kind: "used"`, the ones that make up `totalTokens`
 * (free space, the compaction buffer and deferred tools are not in it), dropped
 * when empty and sorted largest-first.
 */
export async function readContextUsage(q: {
  getContextUsage?: () => Promise<unknown>;
}): Promise<{
  usedTokens: number;
  contextWindow: number | null;
  breakdown: Array<{ name: string; tokens: number }>;
} | null> {
  if (typeof q.getContextUsage !== "function") return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const res = (await Promise.race([
      q.getContextUsage(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("getContextUsage timed out")), 2000);
      }),
    ])) as SdkContextUsage;
    if (!res || typeof res.totalTokens !== "number") return null;
    const breakdown = (res.categories ?? [])
      .filter((c) => c && c.kind === "used" && typeof c.tokens === "number" && c.tokens > 0)
      .map((c) => ({ name: String(c.name ?? "Other"), tokens: c.tokens as number }))
      .sort((a, b) => b.tokens - a.tokens);
    return {
      usedTokens: res.totalTokens,
      contextWindow: typeof res.maxTokens === "number" && res.maxTokens > 0 ? res.maxTokens : null,
      breakdown,
    };
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** The shape we read out of the SDK's experimental usage response. Structural, not
 *  a re-declaration of the SDK type: the API is flagged unstable, so an added or
 *  renamed field must degrade to a missing window rather than a throw. */
interface StructuredUsageWindow {
  utilization?: number | null;
  resets_at?: string | null;
}
interface StructuredUsage {
  subscription_type?: string | null;
  rate_limits_available?: boolean;
  rate_limits?: {
    five_hour?: StructuredUsageWindow | null;
    seven_day?: StructuredUsageWindow | null;
    seven_day_opus?: StructuredUsageWindow | null;
    seven_day_sonnet?: StructuredUsageWindow | null;
    model_scoped?: Array<StructuredUsageWindow & { display_name?: string }>;
  } | null;
}

/**
 * Map the SDK's structured usage response onto {@link ProviderUsage}, the same
 * object the `/usage` scrape produces, so the chip and popover render it
 * unchanged. Labels match the scrape's ("Session", "Week", "Week · Sonnet") and
 * the Fable-only weekly bucket is dropped for the same reason it is there: it
 * tracks a model this product never routes to.
 *
 * `scope` is `account` here, not the scrape's `machine`: these figures come from
 * the claude.ai usage endpoint rather than this device's session log, which is
 * exactly the distinction the field exists to carry.
 *
 * Returns null when the response says plan limits don't apply (API key, Bedrock,
 * Vertex) or carries no window we can read. The caller then falls back.
 */
export function structuredClaudeUsage(res: unknown, providerId: string): ProviderUsage | null {
  const usage = (res ?? null) as StructuredUsage | null;
  if (!usage || usage.rate_limits_available === false) return null;
  const limits = usage.rate_limits;
  if (!limits) return null;

  const windows: UsageWindow[] = [];
  const add = (label: string, windowMins: number, w: StructuredUsageWindow | null | undefined) => {
    if (!w || typeof w.utilization !== "number") return;
    windows.push({
      label,
      usedPercent: Math.round(w.utilization),
      // A machine timestamp at last: the UI formats it, so no label is needed.
      resetsAt: typeof w.resets_at === "string" && w.resets_at ? w.resets_at : null,
      resetsLabel: null,
      windowMins,
    });
  };
  add("Session", 300, limits.five_hour);
  add("Week", 10080, limits.seven_day);
  add("Week · Opus", 10080, limits.seven_day_opus);
  add("Week · Sonnet", 10080, limits.seven_day_sonnet);
  for (const bucket of limits.model_scoped ?? []) {
    const name = bucket?.display_name?.trim();
    if (!name || /^fable$/i.test(name)) continue;
    add(`Week · ${name}`, 10080, bucket);
  }
  if (windows.length === 0) return null;

  return {
    provider: providerId,
    plan: usage.subscription_type ? capitalize(usage.subscription_type) : null,
    windows,
    scope: "account",
    note: null,
    fetchedAt: new Date().toISOString(),
  };
}

/**
 * Parse the free-text body of `claude -p "/usage"` into a {@link ProviderUsage}.
 *
 * The CLI prints one line per window, e.g.
 *   `Current session: 34% used · resets Jun 17 at 6:19pm (Asia/Calcutta)`
 *   `Current week (all models): 10% used · resets Jun 23 at 1:29am (Asia/Calcutta)`
 *   `Current week (Sonnet only): 0% used`
 * We pull `<label>: <pct>% used [· resets <when>]` from each. The reset is a
 * year-less human string printed in the host machine's timezone, named in the
 * trailing `(tz)`. We keep the string (sans tz) as `resetsLabel` and use the tz
 * name to resolve `resetsAt` — Claude gives no machine timestamp here. Returns
 * `null` if no windows are found (e.g. the CLI is on API-key billing, whose
 * header carries no percentages).
 */
export function parseClaudeUsage(text: string, providerId: string): ProviderUsage | null {
  const windows: UsageWindow[] = [];
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*(Current [^:]+):\s*(\d+)%\s*used\b(?:\s*·\s*resets\s+(.+?))?\s*$/i);
    if (!m) continue;
    // The CLI prints a Fable-only weekly bucket alongside the all-models one; it
    // tracks a model this product never routes to, so it is noise in the chip.
    if (/^current\s+week\s*\(\s*fable[^)]*\)$/i.test(m[1].trim())) continue;
    const rawResets = m[3]?.trim() || null;
    const tzMatch = rawResets?.match(/^(.*?)\s*\(([^)]+)\)$/) ?? null;
    const resets = (tzMatch ? tzMatch[1] : rawResets)?.trim() || null;
    const resetsTz = tzMatch?.[2] ?? null;
    const label = prettyUsageLabel(m[1]);
    windows.push({
      label,
      usedPercent: Number(m[2]),
      resetsAt: resets && resetsTz ? resetLabelToIso(resets, resetsTz) : null,
      resetsLabel: resets,
      // Claude's `/usage` gives no duration; infer it from the window kind so the UI
      // formats resets like Codex's: the session bucket is a 5-hour window, the
      // weekly buckets are 7-day windows.
      windowMins: /^session/i.test(label) ? 300 : /week/i.test(label) ? 10080 : null,
    });
  }
  if (windows.length === 0) return null;
  return {
    provider: providerId,
    plan: null,
    windows,
    scope: "machine",
    note: null,
    fetchedAt: new Date().toISOString(),
  };
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/**
 * Convert a `/usage` reset label like "Jun 18 at 6:19pm" plus the IANA zone the
 * CLI printed it in (the trailing `(Asia/Calcutta)` etc.) to an ISO instant, so
 * the UI can format Claude's resets exactly like Codex's (which already ships a
 * timestamp). The label omits the year; we assume the zone's current year and
 * roll forward a year if that lands in the past (resets are always upcoming).
 * Returns null if the shape doesn't match or the zone is unknown to Intl,
 * leaving `resetsLabel` as the UI's fallback.
 */
function resetLabelToIso(label: string, timeZone: string): string | null {
  const m = label.match(/^([A-Za-z]{3,})\.?\s+(\d{1,2})\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i);
  if (!m) return null;
  const monthIdx = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase());
  if (monthIdx < 0) return null;
  const day = Number(m[2]);
  let hour = Number(m[3]) % 12;
  if (/pm/i.test(m[5])) hour += 12;
  const minute = m[4] ? Number(m[4]) : 0;
  try {
    const now = Date.now();
    const year = Number(
      new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric" }).format(now),
    );
    let utc = zonedTimeToUtc(year, monthIdx, day, hour, minute, timeZone);
    if (utc < now - 24 * 60 * 60 * 1000) {
      utc = zonedTimeToUtc(year + 1, monthIdx, day, hour, minute, timeZone);
    }
    return new Date(utc).toISOString();
  } catch {
    return null; // unknown zone name → RangeError from Intl
  }
}

/** UTC instant (ms) of the wall-clock time `y-m-d h:min` in `timeZone`. */
function zonedTimeToUtc(
  year: number,
  monthIdx: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): number {
  const wall = Date.UTC(year, monthIdx, day, hour, minute);
  // The zone's offset varies with the instant (DST), which we don't know until
  // we've applied the offset — resolve once with the wall clock as the guess,
  // then re-resolve at the corrected instant.
  const utc = wall - zoneOffsetMs(timeZone, wall);
  return wall - zoneOffsetMs(timeZone, utc);
}

/** The clock offset (ms) `timeZone` applies at the UTC instant `utcMs`. */
function zoneOffsetMs(timeZone: string, utcMs: number): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(utcMs));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? NaN);
  // `hour12: false` can render midnight as "24" — normalize.
  const wall = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour") % 24,
    get("minute"),
    get("second"),
  );
  return wall - utcMs;
}

/** Tidy a raw `/usage` window label ("Current week (all models)" → "Week"). */
function prettyUsageLabel(raw: string): string {
  const s = raw.replace(/^current\s+/i, "").trim();
  if (/^week\s*\(all models\)$/i.test(s)) return "Week";
  if (/^week\s*\(sonnet only\)$/i.test(s)) return "Week · Sonnet";
  const paren = s.match(/^(\w+)\s*\((.+)\)$/);
  if (paren) return `${capitalize(paren[1])} · ${paren[2]}`;
  return capitalize(s);
}

/**
 * Read subscription usage by shelling out to `claude -p "/usage"`. The slash
 * command is handled locally by the CLI — it runs no model turn (`num_turns: 0`,
 * zero tokens, ~0.5s), so polling it costs nothing. The CLI emits the figures
 * as free text inside the JSON envelope's `result`, so we parse them out (see
 * {@link parseClaudeUsage}); a reword upstream degrades to `null`, never a throw.
 *
 * Runs under the ambient environment (same as the probe's `--version`), so
 * it reports whatever subscription the user's `claude` CLI is logged into — the
 * "your subscription" the agent's turns also draw on. Returns `null` when the
 * CLI is on API-key billing (no windows in the text) or the call fails.
 */
export async function scrapeClaudeUsage(
  configuredPath: string | undefined,
  providerId: string,
): Promise<ProviderUsage | null> {
  try {
    const exec = await loadExecFile();
    const bin = resolveClaudeExecutable(configuredPath)?.path ?? "claude";
    const { stdout } = await exec(
      bin,
      ["-p", "/usage", "--output-format", "json", ...SANDBOX_OFF_SETTINGS_ARGS],
      {
        timeout: 15_000,
        maxBuffer: 1024 * 1024,
      },
    );
    const envelope = JSON.parse(stdout) as { result?: unknown };
    const text = typeof envelope.result === "string" ? envelope.result : "";
    return parseClaudeUsage(text, providerId);
  } catch {
    return null;
  }
}
