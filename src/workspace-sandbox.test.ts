import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { codexWorkspaceProfile, workspaceDenyReadPaths } from "./workspace-sandbox.ts";

test("a workspace shell can't read nested env files, agent folders, a protected folder's secrets or another workspace", () => {
  const data = mkdtempSync(join(tmpdir(), "muxi-agent-data-"));
  try {
    writeFileSync(join(data, "secret"), "");
    for (const dir of ["auth", "workspaces/project/t1", "workspaces/project/t2", "workspaces/other", "cache"]) {
      mkdirSync(join(data, dir), { recursive: true });
    }
    const root = join(data, "workspaces/project/t1");
    const denied = workspaceDenyReadPaths(
      { root, protectedPaths: [data, "/srv/private"], cacheDir: join(data, "cache") },
      "/home/u",
      { CLAUDE_CONFIG_DIR: "/cfg/claude", CODEX_HOME: "/cfg/codex" },
    );
    for (const want of [
      `${root}/**/.env`,
      `${root}/.env.*`,
      "/home/u/.claude",
      "/home/u/.ssh",
      "/cfg/claude",
      "/cfg/codex",
      "/srv/private",
      join(data, "secret"),
      join(data, "auth"),
      join(data, "workspaces/project/t2"),
      join(data, "workspaces/other"),
    ]) {
      assert.ok(denied.includes(want), `denies ${want}`);
    }
    for (const open of [join(data, "workspaces"), join(data, "workspaces/project"), root, join(data, "cache"), data]) {
      assert.ok(!denied.includes(open), `leaves ${open} readable`);
    }
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

test("the Codex profile writes the root and cache, keeps .git read-only and denies the rest", () => {
  const profile = codexWorkspaceProfile({ root: "/w/root", cacheDir: "/w/cache" }, "/home/u", {});
  assert.equal(profile.extends, ":workspace");
  assert.equal(profile.filesystem["/w/root"], "write");
  assert.equal(profile.filesystem["/w/cache"], "write");
  assert.equal(profile.filesystem["/w/root/.git"], "read");
  assert.equal(profile.filesystem["/w/root/**/.env"], "deny");
  assert.equal(profile.filesystem["/home/u/.ssh"], "deny");
});
