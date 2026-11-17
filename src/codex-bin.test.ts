/**
 * Staging a Codex install that sits in a folder the workspace sandbox hides.
 */
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readlinkSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { hiddenCodexBin, realCodexBin, sandboxVisibleCodexBin } from "./codex/bin.ts";

/** A standalone-style package under `<dir>/hidden`, and an empty stage folder. */
function install() {
  const dir = mkdtempSync(join(tmpdir(), "muxi-agent-codex-bin-"));
  const pkg = join(dir, "hidden", "releases", "1.2.3-test");
  mkdirSync(join(pkg, "bin"), { recursive: true });
  mkdirSync(join(pkg, "codex-path"));
  writeFileSync(join(pkg, "codex-package.json"), "{}");
  for (const name of ["codex", "codex-exec-server"]) {
    writeFileSync(join(pkg, "bin", name), `#!/bin/sh\n# ${name}\n`);
    chmodSync(join(pkg, "bin", name), 0o755);
  }
  writeFileSync(join(pkg, "codex-path", "rg"), "rg");
  symlinkSync("bin/codex", join(pkg, "codex"));
  return { dir, pkg, hidden: join(dir, "hidden"), stageDir: join(dir, "stage"), bin: join(pkg, "bin", "codex") };
}

test("an install outside the hidden folders is spawned as given", () => {
  const { bin, stageDir, dir } = install();
  assert.equal(sandboxVisibleCodexBin(bin, { hidden: [join(dir, "elsewhere")], stageDir }), bin);
  assert.equal(statSync(stageDir, { throwIfNoEntry: false }), undefined, "nothing is staged");
});

test("a hidden install is mirrored whole, with hard links, and spawned from the mirror", () => {
  const { bin, pkg, hidden, stageDir } = install();
  const staged = sandboxVisibleCodexBin(bin, { hidden: [hidden], stageDir });
  assert.equal(staged, join(stageDir, "1.2.3-test", "bin", "codex"));
  for (const file of ["bin/codex", "bin/codex-exec-server", "codex-path/rg", "codex-package.json"]) {
    assert.equal(statSync(join(stageDir, "1.2.3-test", file)).ino, statSync(join(pkg, file)).ino, `${file} is the same file`);
  }
  assert.equal(readlinkSync(join(stageDir, "1.2.3-test", "codex")), "bin/codex");
  assert.equal(hiddenCodexBin(staged, [hidden]), null);
  // A second start finds the mirror in place.
  assert.equal(sandboxVisibleCodexBin(bin, { hidden: [hidden], stageDir }), staged);
});

test("a bare name is found on PATH, through its symlink", () => {
  const { bin, hidden, stageDir, dir } = install();
  const onPath = join(dir, "path");
  mkdirSync(onPath);
  symlinkSync(bin, join(onPath, "codex"));
  assert.equal(realCodexBin("codex", onPath), bin);
  assert.equal(hiddenCodexBin("codex", [hidden], onPath), hidden);
  assert.equal(sandboxVisibleCodexBin("codex", { hidden: [hidden], stageDir, pathEnv: onPath }), join(stageDir, "1.2.3-test", "bin", "codex"));
});

test("a name that resolves to nothing is left for the spawn to report", () => {
  const { hidden, stageDir } = install();
  assert.equal(sandboxVisibleCodexBin("no-such-codex", { hidden: [hidden], stageDir, pathEnv: "" }), "no-such-codex");
});
