import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";

import {
  bundledClaudeExecutable,
  claudeOnPath,
  resetClaudeExecutableCache,
  resolveClaudeExecutable,
} from "./claude-binary.ts";

test("the bundled native CLI resolves through the SDK and is executable", () => {
  resetClaudeExecutableCache();
  const bundled = bundledClaudeExecutable();
  // The SDK's platform package is a normal dependency of this workspace, so it
  // is present wherever these tests run. If this ever fails, the packaged app
  // has no Claude binary either.
  assert.ok(bundled, "expected a bundled Claude CLI");
  assert.ok(existsSync(bundled), `${bundled} does not exist`);
  assert.match(bundled, /claude-agent-sdk-[a-z0-9]+-[a-z0-9]+\/claude(\.exe)?$/);
  // Memoized — a second call cannot disagree with the first.
  assert.equal(bundledClaudeExecutable(), bundled);
});

test("an explicit path wins; otherwise the bundled CLI does, and PATH is last", () => {
  resetClaudeExecutableCache();
  assert.deepEqual(resolveClaudeExecutable("/opt/claude"), {
    path: "/opt/claude",
    source: "configured",
  });
  // The bundled binary is present here, so it outranks PATH — which is the
  // whole point: a packaged app with an empty PATH still has a runnable CLI.
  const resolved = resolveClaudeExecutable(undefined, { PATH: "" });
  assert.equal(resolved?.source, "bundled");
  assert.equal(resolved?.path, bundledClaudeExecutable());
});

test("the PATH walk answers without spawning, and an empty PATH is simply null", () => {
  // It runs on the turn pre-flight path, so it must never shell out — and an
  // unhelpful PATH is an answer, not an error.
  assert.equal(claudeOnPath({ PATH: "" }), null);
  assert.equal(claudeOnPath({ PATH: "/definitely/not/a/dir" }), null);
  assert.equal(claudeOnPath({}), null);
});
