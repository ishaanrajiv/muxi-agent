import assert from "node:assert/strict";
import { test } from "node:test";

import { SYNTHETIC_EPOCH, SYNTHETIC_UUID_PREFIX, scrubFixture } from "../scripts/lib/fixture-scrub.ts";

const RECORDED = Date.parse("2026-03-14T09:26:53.589Z");
const SHIFT = RECORDED - SYNTHETIC_EPOCH;
const header = { header: { scenario: "x", recordedAt: new Date(RECORDED).toISOString() } };
const THREAD = "0190F3C2-7A11-7B22-8C33-0123456789AB";

function scrub(...frames: unknown[]): any[] {
  return scrubFixture([header, ...frames]) as any[];
}

test("fixture scrub: the recording starts at the synthetic epoch, and every timestamp shifts with it", () => {
  const [h, f] = scrub({
    emittedAtMs: RECORDED + 500,
    createdAt: Math.round(RECORDED / 1000),
    updatedAt: new Date(RECORDED + 60_000).toISOString(),
    timestamp: RECORDED + 1000,
    durationMs: 1234,
  });
  assert.equal(h.header.recordedAt, new Date(SYNTHETIC_EPOCH).toISOString());
  assert.equal(f.emittedAtMs, SYNTHETIC_EPOCH + 500);
  assert.equal(f.createdAt, Math.round(SYNTHETIC_EPOCH / 1000));
  assert.equal(f.updatedAt, new Date(SYNTHETIC_EPOCH + 60_000).toISOString());
  assert.equal(f.timestamp, SYNTHETIC_EPOCH + 1000);
  assert.equal(f.durationMs, 1234, "a duration isn't a timestamp");
  assert.equal(SHIFT > 0, true);
});

test("fixture scrub: ids map consistently, whatever their case, across frames", () => {
  const [, a, b] = scrub(
    { threadId: THREAD, item: { id: "msg_abcdef0123456789abcdef01" } },
    { threadId: THREAD.toLowerCase(), path: `~/sessions/2026/03/14/rollout-2026-03-14T14-56-53-${THREAD}.jsonl` },
  );
  assert.equal(a.threadId, `${SYNTHETIC_UUID_PREFIX}000000000001`);
  assert.equal(b.threadId, a.threadId);
  assert.equal(a.item.id, "msg_0000000000000002");
  assert.equal(b.path, `~/sessions/2026/01/01/rollout-2026-01-01T00-00-00-${a.threadId}.jsonl`);
});

test("fixture scrub: no plan, usage, reset timing or credit state survives", () => {
  const [, f] = scrub({
    rateLimits: {
      planType: "plus",
      primary: { usedPercent: 6, windowDurationMins: 300, resetsAt: Math.round(RECORDED / 1000) + 777 },
      secondary: { usedPercent: 34, windowDurationMins: 10080, resetsAt: null },
      credits: { hasCredits: true, unlimited: true, balance: "42.50" },
    },
  });
  assert.deepEqual(f.rateLimits, {
    planType: "unknown",
    primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: SYNTHETIC_EPOCH / 1000 + 300 * 60 },
    secondary: { usedPercent: 10, windowDurationMins: 10080, resetsAt: null },
    credits: { hasCredits: false, unlimited: false, balance: "0" },
  });
});

test("fixture scrub: the OS and scratch suffix go, and a second scrub changes nothing", () => {
  const once = scrub({
    userAgent: "muxi-agent/0.167.0 (Ubuntu 26.4.0; x86_64) unknown",
    cwd: "/tmp/muxi-agent-fixture-cwd-EfLr15",
    threadId: THREAD,
    emittedAtMs: RECORDED + 5,
  });
  assert.equal(once[1].userAgent, "muxi-agent/0.167.0 (Linux; x86_64) unknown");
  assert.equal(once[1].cwd, "/tmp/muxi-agent-fixture-cwd-XXXXXX");
  assert.deepEqual(scrubFixture(once), once);
});
