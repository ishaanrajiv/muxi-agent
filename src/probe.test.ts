import { test } from "node:test";
import assert from "node:assert/strict";

import { doctorShowsAuth } from "./probe.ts";

// The auth line's wording has already changed once ("✓ auth" → "auth  auth is
// configured"); a third reword must not silently flip every user to logged-out.
test("doctorShowsAuth accepts the wordings codex has shipped", () => {
  assert.equal(doctorShowsAuth("codex doctor\n  auth  auth is configured\n  mcp  ok"), true);
  assert.equal(doctorShowsAuth("✓ auth\n✓ mcp"), true);
  assert.equal(doctorShowsAuth("  auth   signed in as user@example.com"), true);
  assert.equal(doctorShowsAuth("  auth   authenticated"), true);
});

test("doctorShowsAuth rejects logged-out and auth-less output", () => {
  assert.equal(doctorShowsAuth("  auth  not configured — run codex login"), false);
  assert.equal(doctorShowsAuth("  ✗ auth  missing credentials"), false);
  assert.equal(doctorShowsAuth("  auth  token expired"), false);
  assert.equal(doctorShowsAuth("codex doctor\n  mcp  ok\n  sandbox  ok"), false);
  assert.equal(doctorShowsAuth(""), false);
});
