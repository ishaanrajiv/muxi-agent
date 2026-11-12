import assert from "node:assert/strict";
import { test } from "node:test";

import { normalizeWorkSummary } from "./work-summary.ts";

test("title-only Codex summaries are not expandable", () => {
  assert.deepEqual(normalizeWorkSummary("**Planning date range query**\n\n<!-- -->"), [
    { label: "Planning date range query" },
  ]);
});

test("header summaries retain only visible detail", () => {
  assert.deepEqual(
    normalizeWorkSummary(
      "**Choosing the source**\nUsed the daily aggregate.\n\n**Running the query**\n<!-- hidden -->",
    ),
    [
      { label: "Choosing the source", detail: "Used the daily aggregate." },
      { label: "Running the query" },
    ],
  );
});

test("free-form provider prose becomes bounded, scannable rows", () => {
  assert.deepEqual(
    normalizeWorkSummary(
      "I’m checking the daily table first. It has the required app grain.\n\nThe query is ready to run.",
    ),
    [
      { label: "I’m checking the daily table first.", detail: "It has the required app grain." },
      { label: "The query is ready to run." },
    ],
  );
});

test("a comment spanning a blank line never leaks fragments into rows", () => {
  assert.deepEqual(
    normalizeWorkSummary("Checking the table.\n\n<!-- internal\n\nnote -->\n\nDone."),
    [{ label: "Checking the table." }, { label: "Done." }],
  );
});

test("a very long first sentence is shown in full as one row, never clipped or duplicated", () => {
  const prose = `I need to compare ${"several related measures ".repeat(8)}before selecting the clearest source.`;
  assert.deepEqual(normalizeWorkSummary(prose), [{ label: prose }]);
});
