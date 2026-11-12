/** The managed CODEX_HOME config: what it turns off, in the table Codex reads it from. */

import assert from "node:assert/strict";
import { test } from "node:test";

import { managedCodexConfig } from "./home.ts";

/** The keys under one `[table]` of the managed config, as `key = value` lines. */
function table(name: string): string[] {
  const lines = managedCodexConfig().split("\n");
  const start = lines.indexOf(`[${name}]`);
  assert.ok(start >= 0, `[${name}] is in the config`);
  const end = lines.findIndex((l, i) => i > start && l.startsWith("["));
  return lines.slice(start + 1, end < 0 ? undefined : end).filter((l) => l && !l.startsWith("#"));
}

test("Codex's own tools that reach past the thread's MCP servers are off: shell and the image viewer", () => {
  const features = table("features");
  assert.ok(features.includes("shell_tool = false"));
  // A Codex feature flag (codex 0.167 `features list`); `[tools] view_image` would be ignored.
  assert.ok(features.includes("view_image = false"));
  assert.ok(!table("tools.update_plan").some((l) => l.startsWith("view_image")));
});
