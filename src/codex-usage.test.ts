import assert from "node:assert/strict";
import { test } from "node:test";

import { codexBucket, codexUsageLimitMessage, exhaustedWindow, mergeRateLimits } from "./codex-usage.ts";
import type { GetAccountRateLimitsResponse } from "./generated/v2/GetAccountRateLimitsResponse.ts";
import type { RateLimitSnapshot } from "./generated/v2/RateLimitSnapshot.ts";
import { claudeWindowLabel, codexWindowLabel, usageLimitMessage } from "./usage-limit.ts";

const snap = (o: Partial<RateLimitSnapshot>): RateLimitSnapshot =>
  ({
    limitId: "codex",
    limitName: null,
    normalModelSlug: null,
    primary: null,
    secondary: null,
    credits: null,
    individualLimit: null,
    spendControlReached: null,
    planType: null,
    rateLimitReachedType: null,
    ...o,
  }) as RateLimitSnapshot;

test("a sparse push never clears what the last snapshot held", () => {
  const prev = snap({
    planType: "team",
    primary: { usedPercent: 40, windowDurationMins: 300, resetsAt: 100 },
    secondary: { usedPercent: 30, windowDurationMins: 10_080, resetsAt: 200 },
  });
  const merged = mergeRateLimits(prev, snap({ primary: { usedPercent: 55, windowDurationMins: 300, resetsAt: 100 } }));
  assert.equal(merged.primary?.usedPercent, 55, "a value in the push wins");
  assert.equal(merged.secondary?.usedPercent, 30, "a null in the push keeps the old window");
  assert.equal(merged.planType, "team");
  assert.equal(mergeRateLimits(null, prev), prev);
});

test("codexBucket prefers the codex bucket and falls back to the single view", () => {
  const codex = snap({ primary: { usedPercent: 4, windowDurationMins: 300, resetsAt: 1 } });
  const single = snap({ limitId: null, primary: { usedPercent: 90, windowDurationMins: 300, resetsAt: 1 } });
  const res = (byId: GetAccountRateLimitsResponse["rateLimitsByLimitId"]) =>
    ({ rateLimits: single, rateLimitsByLimitId: byId }) as GetAccountRateLimitsResponse;
  assert.equal(codexBucket(res({ codex })), codex);
  assert.equal(codexBucket(res(null)), single);
});

test("the exhausted window is the full one that resets last", () => {
  assert.equal(exhaustedWindow(snap({ primary: { usedPercent: 99, windowDurationMins: 300, resetsAt: 1 } })), null);
  const both = snap({
    primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: 100 },
    secondary: { usedPercent: 100, windowDurationMins: 10_080, resetsAt: 900 },
  });
  assert.equal(exhaustedWindow(both)?.windowDurationMins, 10_080);
  assert.equal(codexUsageLimitMessage(snap({})), null, "nothing exhausted: Codex's own prose stands");
});

test("window labels read the way a person says them", () => {
  assert.equal(codexWindowLabel(300), "5-hour");
  assert.equal(codexWindowLabel(10_080), "weekly");
  assert.equal(codexWindowLabel(null), null);
  assert.equal(claudeWindowLabel("five_hour"), "5-hour");
  assert.equal(claudeWindowLabel("seven_day_opus"), "weekly Opus");
  assert.equal(claudeWindowLabel("brand_new_window"), null);
});

test("usageLimitMessage gives the time within a day and the date beyond it", () => {
  const now = new Date("2026-09-23T10:00:00Z");
  const opts = { now, timeZone: "UTC" };
  const soon = usageLimitMessage("Codex", { label: "5-hour", resetsAt: new Date("2026-09-23T15:40:00Z") }, opts);
  assert.match(soon, /^Codex hit its 5-hour usage limit\. It resets at 3:40\sPM\.$/);
  const later = usageLimitMessage("Codex", { label: "weekly", resetsAt: new Date("2026-09-26T09:05:00Z") }, opts);
  assert.match(later, /^Codex hit its weekly usage limit\. It resets on Sat, Sep 26 at 9:05\sAM\.$/);
  assert.equal(usageLimitMessage("Claude Code", { label: null, resetsAt: null }), "Claude Code hit its usage limit.");
});
