import assert from "node:assert/strict";
import { test } from "node:test";

import type { AgentModel } from "./types/index.ts";

import {
  exactly,
  family,
  markSupersededByTier,
  orderByVersionThenTier,
  withPreferredDefault,
} from "./model-defaults.ts";

function model(id: string, opts: Partial<AgentModel> = {}): AgentModel {
  return {
    id,
    slug: id,
    displayName: id,
    description: "",
    reasoningEfforts: ["low", "medium", "high"].map((effort) => ({ effort })),
    defaultEffort: "xhigh",
    isDefault: false,
    ...opts,
  };
}

/** The live Codex catalog shape (2026-07): Codex flags Sol; we want Luna. */
const CODEX = [
  model("gpt-5.6-sol", { isDefault: true }),
  model("gpt-5.6-terra"),
  model("gpt-5.6-luna"),
  model("gpt-5.5"),
  model("gpt-5.4"),
  model("gpt-5.4-mini"),
];

const CODEX_PREFS = [family("luna"), family("terra"), exactly("gpt-5.5")] as const;

test("Codex: Luna wins over the app-server's own default", () => {
  const out = withPreferredDefault(CODEX, CODEX_PREFS);
  assert.equal(out.filter((m) => m.isDefault).length, 1);
  assert.equal(out.find((m) => m.isDefault)?.id, "gpt-5.6-luna");
});

test("Codex: the highest-version Luna wins, not catalog order", () => {
  const out = withPreferredDefault(
    [...CODEX, model("gpt-5.7-luna"), model("gpt-6.1-luna"), model("gpt-6.0-luna")],
    CODEX_PREFS,
  );
  assert.equal(out.find((m) => m.isDefault)?.id, "gpt-6.1-luna");
});

test("Codex: no Luna falls back to the newest Terra", () => {
  const out = withPreferredDefault(
    [model("gpt-5.6-sol", { isDefault: true }), model("gpt-5.6-terra"), model("gpt-5.7-terra")],
    CODEX_PREFS,
  );
  assert.equal(out.find((m) => m.isDefault)?.id, "gpt-5.7-terra");
});

test("Codex: no Luna or Terra falls back to gpt-5.5 exactly (never 5.5-mini)", () => {
  const out = withPreferredDefault(
    [model("gpt-5.6-sol", { isDefault: true }), model("gpt-5.5-mini"), model("gpt-5.5")],
    CODEX_PREFS,
  );
  assert.equal(out.find((m) => m.isDefault)?.id, "gpt-5.5");
});

test("no preference matches → the backend keeps its own flag", () => {
  const models = [model("o9-pro", { isDefault: true }), model("o9-flash")];
  const out = withPreferredDefault(models, CODEX_PREFS);
  assert.deepEqual(
    out.map((m) => [m.id, m.isDefault]),
    [
      ["o9-pro", true],
      ["o9-flash", false],
    ],
  );
});

test("Claude: newest Sonnet is the default, by version not order", () => {
  const out = withPreferredDefault(
    [
      model("claude-fable-5", { displayName: "Fable 5" }),
      model("opus", { displayName: "Opus 5" }),
      model("sonnet-legacy", { displayName: "Sonnet 4.6" }),
      model("sonnet", { displayName: "Sonnet 5" }),
      model("haiku", { displayName: "Haiku 4.5" }),
    ],
    [family("sonnet")],
  );
  assert.equal(out.find((m) => m.isDefault)?.id, "sonnet");
});

test("the default lands on medium effort when the model offers it", () => {
  const out = withPreferredDefault(CODEX, CODEX_PREFS);
  assert.equal(out.find((m) => m.isDefault)?.defaultEffort, "medium");
  // Non-default rows keep the catalog's own effort default untouched.
  assert.equal(out.find((m) => m.id === "gpt-5.5")?.defaultEffort, "xhigh");
});

test("a model with no medium level keeps its own effort default", () => {
  const out = withPreferredDefault(
    [
      model("gpt-5.6-luna", {
        reasoningEfforts: [{ effort: "low" }, { effort: "max" }],
        defaultEffort: "max",
      }),
    ],
    CODEX_PREFS,
  );
  assert.equal(out[0].defaultEffort, "max");
});

test("family matching is whole-word — 'lunar' is not Luna", () => {
  const out = withPreferredDefault(
    [model("gpt-lunar-5.9"), model("gpt-5.5")],
    CODEX_PREFS,
  );
  assert.equal(out.find((m) => m.isDefault)?.id, "gpt-5.5");
});

test("an empty catalog is returned as-is", () => {
  assert.deepEqual(withPreferredDefault([], CODEX_PREFS), []);
});

const TIERS = ["astra", "sol", "terra", "luna"] as const;

test("picker order: newest version first, then codename tier", () => {
  const out = orderByVersionThenTier(
    [
      model("gpt-5.6-sol"),
      model("gpt-5.6-terra"),
      model("gpt-5.6-luna"),
      model("gpt-6-astra"),
      model("gpt-5.5"),
    ],
    TIERS,
  );
  assert.deepEqual(
    out.map((m) => m.id),
    ["gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5"],
  );
});

test("picker order: a point release sorts above its major (6.1 Sol over 6 Sol)", () => {
  const out = orderByVersionThenTier(
    [
      model("gpt-6-sol", { displayName: "GPT-6 Sol" }),
      model("gpt-6.1-sol", { displayName: "GPT-6.1 Sol" }),
      model("gpt-5.6-sol", { displayName: "GPT-5.6 Sol" }),
    ],
    TIERS,
  );
  assert.deepEqual(
    out.map((m) => m.id),
    ["gpt-6.1-sol", "gpt-6-sol", "gpt-5.6-sol"],
  );
});

test("picker order: an unknown codename sorts below the ranked ones, catalog order among peers", () => {
  const out = orderByVersionThenTier(
    [model("gpt-5.6-vega"), model("gpt-5.6-nova"), model("gpt-5.6-luna"), model("gpt-5.6-sol")],
    TIERS,
  );
  assert.deepEqual(
    out.map((m) => m.id),
    ["gpt-5.6-sol", "gpt-5.6-luna", "gpt-5.6-vega", "gpt-5.6-nova"],
  );
});

test("picker order: a version-less name keeps catalog order behind versioned rows", () => {
  const out = orderByVersionThenTier([model("gpt-5.5"), model("codex-mini"), model("gpt-6-astra")], TIERS);
  assert.deepEqual(
    out.map((m) => m.id),
    ["gpt-6-astra", "gpt-5.5", "codex-mini"],
  );
});

test("older models: a tier with a newer version listed is superseded", () => {
  const out = markSupersededByTier(
    [
      model("gpt-6.1-sol", { displayName: "GPT-6.1 Sol" }),
      model("gpt-6-sol", { displayName: "GPT-6 Sol" }),
      model("gpt-6-luna", { displayName: "GPT-6 Luna" }),
      model("gpt-5.6-luna", { displayName: "GPT-5.6 Luna" }),
      model("gpt-5.6-terra", { displayName: "GPT-5.6 Terra" }),
      model("gpt-5.4", { displayName: "GPT-5.4", superseded: true }),
      model("gpt-5.5", { displayName: "GPT-5.5" }),
    ],
    TIERS,
  );
  assert.deepEqual(
    out.filter((m) => m.superseded).map((m) => m.id),
    ["gpt-6-sol", "gpt-5.6-luna", "gpt-5.4"],
  );
});
