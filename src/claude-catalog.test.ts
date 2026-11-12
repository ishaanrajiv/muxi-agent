import assert from "node:assert/strict";
import { test } from "node:test";

import { normalizeCatalog } from "./claude/catalog.ts";
import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk";

const asInfos = (o: unknown[]) => o as ModelInfo[];

// The live CLI catalog (SDK 0.3.19x): a `default` alias that resolves to the same
// concrete model as an explicit row, plus `[1m]` long-context flavors. See the
// probe in the commit that added this test.
const LIVE = asInfos([
  {
    value: "default",
    resolvedModel: "claude-opus-4-8[1m]",
    displayName: "Default (recommended)",
    description: "Use the default model (currently Opus 4.8 (1M context)) · $5/$25 per Mtok",
    supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
  },
  {
    value: "opus[1m]",
    resolvedModel: "claude-opus-4-8[1m]",
    displayName: "Opus",
    description: "Opus 4.8 with 1M context · Best for everyday, complex tasks · $5/$25 per Mtok",
    supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
  },
  {
    value: "claude-fable-5[1m]",
    resolvedModel: "claude-fable-5",
    displayName: "Fable",
    description: "Fable 5 · Most capable for your hardest and longest-running tasks",
    supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
  },
  {
    value: "sonnet",
    resolvedModel: "claude-sonnet-5",
    displayName: "Sonnet",
    description: "Sonnet 5 · Efficient for routine tasks · $2/$10 per Mtok · promo through Aug 31",
    supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
  },
  {
    value: "haiku",
    resolvedModel: "claude-haiku-4-5-20251001",
    displayName: "Haiku",
    description: "Haiku 4.5 · Fastest for quick answers · $1/$5 per Mtok",
    supportedEffortLevels: [],
  },
]);

test("live catalog: `default` collapses into its resolved concrete row, ordered names", () => {
  const out = normalizeCatalog(LIVE);
  // The `default` alias and the explicit `opus[1m]` row resolve to the same model,
  // so exactly one Opus row survives — no "Use the default model (currently …)" —
  // and the rows come out in FAMILY_ORDER (Fable → Opus → Sonnet → Haiku).
  assert.deepEqual(
    out.map((m) => m.displayName),
    ["Fable 5", "Opus 4.8", "Sonnet 5", "Haiku 4.5"],
  );
  // The concrete alias wins the id (not the `default` indirection).
  assert.equal(out.find((m) => m.displayName === "Opus 4.8")?.id, "opus");
  assert.ok(!out.some((m) => /default|currently/i.test(m.displayName)));
});

test("an unranked (newly shipped) family floats to the top", () => {
  const out = normalizeCatalog(
    asInfos([
      {
        value: "opus[1m]",
        resolvedModel: "claude-opus-4-8[1m]",
        displayName: "Opus",
        description: "Opus 4.8 with 1M context · Best for everyday tasks",
        supportedEffortLevels: ["medium"],
      },
      {
        value: "claude-lyric-1",
        resolvedModel: "claude-lyric-1",
        displayName: "Lyric",
        description: "Lyric 1 · A brand new family",
        supportedEffortLevels: ["medium"],
      },
    ]),
  );
  assert.deepEqual(
    out.map((m) => m.displayName),
    ["Lyric 1", "Opus 4.8"],
  );
});

test("`[1m]` long-context flavors collapse to the base alias id", () => {
  const out = normalizeCatalog(LIVE);
  assert.equal(out.find((m) => m.displayName === "Fable 5")?.id, "claude-fable-5");
});

test("a `default` row with no explicit twin is kept, named from its resolved id", () => {
  const out = normalizeCatalog(
    asInfos([
      {
        value: "default",
        resolvedModel: "claude-opus-4-8[1m]",
        displayName: "Default (recommended)",
        description: "Use the default model (currently Opus 4.8 (1M context)) · $5/$25 per Mtok",
        supportedEffortLevels: ["medium"],
      },
    ]),
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].displayName, "Opus 4.8");
  assert.equal(out[0].id, "claude-opus-4-8");
});

test("older CLI shape without resolvedModel still parses family from the lead", () => {
  const out = normalizeCatalog(
    asInfos([
      {
        value: "sonnet",
        displayName: "Sonnet",
        description: "Sonnet 4.6 · Efficient for routine tasks",
        supportedEffortLevels: ["medium"],
      },
    ]),
  );
  assert.deepEqual(out.map((m) => ({ id: m.id, name: m.displayName })), [
    { id: "sonnet", name: "Sonnet 4.6" },
  ]);
});

// The live CLI catalog (claude 2.1.x, 2026-09): `displayName` carries the version
// and the description is a bare sentence with no "<Family> · …" lead.
const LIVE_SENTENCES = asInfos([
  { value: "default", resolvedModel: "claude-opus-5-5", displayName: "Default (recommended)", description: "Opus 5.5 · Best for everyday, complex tasks" },
  { value: "opus", resolvedModel: "claude-opus-5-5", displayName: "Opus 5.5", description: "Best for everyday, complex tasks" },
  { value: "claude-opus-5", resolvedModel: "claude-opus-5", displayName: "Opus 5", description: "Best for everyday, complex tasks" },
  { value: "claude-fable-5-1", resolvedModel: "claude-fable-5-1", displayName: "Fable 5.1", description: "Most capable for your hardest and longest-running tasks" },
  { value: "sonnet", resolvedModel: "claude-sonnet-5", displayName: "Sonnet 5", description: "Efficient for routine tasks" },
  { value: "haiku", resolvedModel: "claude-haiku-4-5-20251001", displayName: "Haiku 4.5", description: "Fastest for quick answers" },
]);

test("sentence-only descriptions never become the model name", () => {
  const out = normalizeCatalog(LIVE_SENTENCES);
  assert.deepEqual(
    out.map((m) => [m.id, m.displayName]),
    [
      ["claude-fable-5-1", "Fable 5.1"],
      ["opus", "Opus 5.5"],
      ["claude-opus-5", "Opus 5"],
      ["sonnet", "Sonnet 5"],
      ["haiku", "Haiku 4.5"],
    ],
  );
  // Only Opus 5 has a newer family member here (Opus 5.5).
  assert.deepEqual(out.filter((m) => m.superseded).map((m) => m.displayName), ["Opus 5"]);
  // The sentence stays available as the description.
  assert.equal(out.find((m) => m.id === "opus")?.description, "Best for everyday, complex tasks");
});

test("a sentence description with no resolved id falls back to the CLI's displayName", () => {
  const out = normalizeCatalog(
    asInfos([{ value: "opus", displayName: "Opus 5.5", description: "Best for everyday, complex tasks" }]),
  );
  assert.equal(out[0].displayName, "Opus 5.5");
});

test("a dated wire id never reads its date as a minor version", () => {
  const out = normalizeCatalog(
    asInfos([{ value: "claude-opus-4-20250514", resolvedModel: "claude-opus-4-20250514", displayName: "Opus 4", description: "Legacy" }]),
  );
  assert.equal(out[0].displayName, "Opus 4");
});

test("a model with a newer version of its family in the catalog is superseded", () => {
  const out = normalizeCatalog(
    asInfos(
      [
        ["opus", "claude-opus-5-5"],
        ["claude-opus-4-8", "claude-opus-4-8"],
        ["claude-fable-5-1", "claude-fable-5-1"],
        ["claude-fable-5", "claude-fable-5"],
        ["sonnet", "claude-sonnet-5"],
        ["claude-sonnet-4-6", "claude-sonnet-4-6"],
        ["haiku", "claude-haiku-4-5-20251001"],
      ].map(([value, resolvedModel]) => ({ value, resolvedModel, displayName: "", description: "" })),
    ),
  );
  assert.deepEqual(
    out.map((m) => [m.displayName, m.superseded]),
    [
      ["Fable 5.1", false],
      ["Fable 5", true],
      ["Opus 5.5", false],
      ["Opus 4.8", true],
      ["Sonnet 5", false],
      ["Sonnet 4.6", true],
      ["Haiku 4.5", false],
    ],
  );
});

test("a name without a version is never superseded", () => {
  const out = normalizeCatalog(
    asInfos([
      { value: "claude-lyric", displayName: "Lyric", description: "" },
      { value: "claude-lyric-2", resolvedModel: "claude-lyric-2", displayName: "Lyric 2", description: "" },
    ]),
  );
  assert.deepEqual(out.map((m) => [m.displayName, m.superseded]), [["Lyric", false], ["Lyric 2", false]]);
});
