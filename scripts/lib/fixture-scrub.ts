/**
 * Make a recorded fixture anonymous, past what `redact` in
 * `record-codex-fixtures.ts` strips (emails, account ids, paths, the host):
 *
 *  - Time: every timestamp (a number or an ISO string under a key ending in
 *    `At`, `AtMs` or `timestamp`) shifts by one offset so the recording
 *    starts at SYNTHETIC_EPOCH. Intervals and order survive; when it was
 *    recorded, and in which timezone (rollout file names use local time),
 *    don't.
 *  - Ids: UUIDs (v7 ones encode their creation time; any case) and `msg_` ids
 *    map, in order of first appearance, onto sequential synthetic ones, so a
 *    thread's or a turn's id still matches across frames.
 *  - Account: the plan reads "unknown"; every usage window is 10% used and
 *    resets one window after SYNTHETIC_EPOCH; credits are none, not
 *    unlimited, balance "0".
 *  - Machine: the OS in the user agent reads "Linux", and the random suffix of
 *    a scratch directory reads XXXXXX.
 *
 * Idempotent: scrubbing a scrubbed fixture changes nothing.
 */

export const SYNTHETIC_EPOCH = Date.parse("2026-01-01T00:00:00.000Z");
/** Every synthetic UUID starts with this. */
export const SYNTHETIC_UUID_PREFIX = "00000000-0000-7000-8000-";
const SYNTHETIC_CREDITS = { hasCredits: false, unlimited: false, balance: "0" };

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const TIME_KEY = /(At|AtMs|timestamp|Timestamp)$/;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
const MSG_ID = /\bmsg_[0-9a-f]{8,}\b/g;
const ROLLOUT = /sessions\/\d{4}\/\d{2}\/\d{2}\/rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-/g;
const USER_AGENT_OS = /\(([^;()]+); (x86_64|aarch64|arm64)\)/g;
const SCRATCH = /(muxi-agent-fixture-cwd-)[A-Za-z0-9]{6}/g;

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export function scrubFixture(lines: unknown[]): unknown[] {
  const header = lines[0] as { header?: { recordedAt?: string } } | undefined;
  const recordedAt = header?.header?.recordedAt ? Date.parse(header.header.recordedAt) : NaN;
  const shiftMs = Number.isNaN(recordedAt) ? 0 : recordedAt - SYNTHETIC_EPOCH;

  const ids = new Map<string, string>();
  const mapId = (raw: string): string => {
    const id = raw.toLowerCase();
    let out = ids.get(id);
    if (!out) {
      const n = (ids.size + 1).toString(16);
      out = id.startsWith("msg_") ? `msg_${n.padStart(16, "0")}` : `${SYNTHETIC_UUID_PREFIX}${n.padStart(12, "0")}`;
      ids.set(id, out);
    }
    return out;
  };
  const rollout = `sessions/${isoDate(SYNTHETIC_EPOCH).replaceAll("-", "/")}/rollout-${isoDate(SYNTHETIC_EPOCH)}T00-00-00-`;

  const scrubString = (s: string): string =>
    s
      .replace(UUID, mapId)
      .replace(MSG_ID, mapId)
      .replace(ROLLOUT, rollout)
      .replace(USER_AGENT_OS, "(Linux; $2)")
      .replace(SCRATCH, "$1XXXXXX");

  const walk = (value: Json, key: string): Json => {
    if (typeof value === "string") {
      if (key === "planType") return "unknown";
      if (key === "balance") return "0";
      if (TIME_KEY.test(key) && ISO_TIME.test(value) && !Number.isNaN(Date.parse(value))) {
        return new Date(Date.parse(value) - shiftMs).toISOString();
      }
      return scrubString(value);
    }
    if (typeof value === "number") {
      if (TIME_KEY.test(key) && value > 1e12 && value < 1e14) return value - shiftMs;
      if (TIME_KEY.test(key) && value > 1e9 && value < 1e11) return value - Math.round(shiftMs / 1000);
      return value;
    }
    if (Array.isArray(value)) return value.map((v) => walk(v, key));
    if (value && typeof value === "object") {
      if (key === "credits") return { ...SYNTHETIC_CREDITS };
      const out: { [key: string]: Json } = {};
      for (const [k, v] of Object.entries(value)) out[k] = walk(v, k);
      if ("usedPercent" in out) {
        // A usage window: 10% used, resetting one window after the epoch.
        out.usedPercent = 10;
        const mins = typeof out.windowDurationMins === "number" ? out.windowDurationMins : 0;
        if ("resetsAt" in out && out.resetsAt != null) out.resetsAt = SYNTHETIC_EPOCH / 1000 + mins * 60;
      }
      return out;
    }
    return value;
  };

  return lines.map((line) => walk(line as Json, ""));
}

function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}
