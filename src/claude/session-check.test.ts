import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { clearEmptySession, sessionState } from "./session-check.ts";

/** The real SDK lookups against a throwaway config dir. */
test("session state: absent, empty (a partial first write), saved; and an empty one is cleared", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ak-session-"));
  const before = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = dir;
  try {
    const id = "11111111-1111-4111-8111-111111111111";
    const saved = "22222222-2222-4222-8222-222222222222";
    assert.equal(await sessionState(id), "absent", "no projects folder");
    const proj = join(dir, "projects", "-ws");
    mkdirSync(proj, { recursive: true });
    assert.equal(await sessionState(id), "absent", "no file");
    // An interrupted first write: the CLI's snapshot record and nothing else.
    writeFileSync(join(proj, `${id}.jsonl`), JSON.stringify({ type: "file-history-snapshot", messageId: "m", snapshot: { messageId: "m", trackedFileBackups: {}, timestamp: new Date().toISOString() }, isSnapshotUpdate: false }) + "\n");
    assert.equal(await sessionState(id), "empty");
    const line = (o: object) => JSON.stringify({ sessionId: saved, cwd: "/ws", version: "2.1.319", timestamp: new Date().toISOString(), isSidechain: false, userType: "external", ...o });
    writeFileSync(
      join(proj, `${saved}.jsonl`),
      [
        line({ type: "user", uuid: "u1", parentUuid: null, message: { role: "user", content: "hi" } }),
        line({ type: "assistant", uuid: "a1", parentUuid: "u1", message: { id: "msg_1", type: "message", role: "assistant", model: "m", content: [{ type: "text", text: "hello" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } } }),
      ].join("\n") + "\n",
    );
    assert.equal(await sessionState(saved), "saved");
    assert.equal(await clearEmptySession(id), true);
    assert.equal(existsSync(join(proj, `${id}.jsonl`)), false);
    assert.equal(await sessionState(id), "absent");
    assert.equal(existsSync(join(proj, `${saved}.jsonl`)), true, "a saved session is never touched");
  } finally {
    if (before === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = before;
    rmSync(dir, { recursive: true, force: true });
  }
});
