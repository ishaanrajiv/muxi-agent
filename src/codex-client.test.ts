import { test } from "node:test";
import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CodexClient } from "./codex-client.ts";

/** One executable for the whole file: it runs the body file named by
 *  `MUXI_AGENT_FAKE_BODY`. A new executable per test costs a cold first exec each time. */
const LAUNCHER = (() => {
  const file = join(mkdtempSync(join(tmpdir(), "muxi-agent-codex-launcher-")), "fake-codex");
  writeFileSync(file, `#!${process.execPath}\nrequire(process.env.MUXI_AGENT_FAKE_BODY);\n`, { mode: 0o755 });
  return file;
})();

/**
 * Client options for a stand-in `codex app-server`: `body` runs in node with the
 * client's args (which it ignores). Lets these tests exercise the real spawn +
 * stdio protocol path instead of poking at private fields.
 */
function fakeCodexBin(body: string): { codexBin: string; env: Record<string, string> } {
  const file = join(mkdtempSync(join(tmpdir(), "muxi-agent-codex-body-")), "body.cjs");
  writeFileSync(file, body);
  return { codexBin: LAUNCHER, env: { MUXI_AGENT_FAKE_BODY: file } };
}

/** Reply to each request line with `respond(msg)`'s lines (skip = no reply). */
const REPLY_LOOP = `
let buf = "";
process.stdin.on("data", (chunk) => {
  buf += chunk;
  const lines = buf.split("\\n");
  buf = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.trim()) continue;
    for (const out of respond(JSON.parse(line))) process.stdout.write(out + "\\n");
  }
});
`;

// Regression: a missing codex binary (fresh machine, or a Finder-launched app
// with launchd's minimal PATH) used to surface as an UNCAUGHT exception — the
// child-process "error" was re-emitted on the client with no listener attached
// (only sendTurn subscribes, per-turn), which Node escalates to a crash. It
// must instead reject start() so idle-path callers (usage/model reads) get a
// normal error.
test("start() rejects with ENOENT when the codex binary is missing", async () => {
  const client = new CodexClient({ codexBin: "/nonexistent/muxi-agent-test-codex-bin" });
  await assert.rejects(client.start(), /ENOENT/);
});

test("a spawn failure with no 'error' listener does not throw uncaught", async () => {
  const before = process.listenerCount("uncaughtException");
  let sawUncaught = false;
  const probe = () => {
    sawUncaught = true;
  };
  process.on("uncaughtException", probe);
  try {
    const client = new CodexClient({ codexBin: "/nonexistent/muxi-agent-test-codex-bin" });
    await client.start().catch(() => {});
    // Give the event loop a tick in case the child "error" fires late.
    await new Promise((r) => setImmediate(r));
    assert.equal(sawUncaught, false);
  } finally {
    process.removeListener("uncaughtException", probe);
    assert.equal(process.listenerCount("uncaughtException"), before);
  }
});

// A process that never came up must not report as running — otherwise the
// provider skips the respawn and interrupt()/sendTurn throw "stdin not writable".
test("isRunning is false after a failed spawn", async () => {
  const client = new CodexClient({ codexBin: "/nonexistent/muxi-agent-test-codex-bin" });
  assert.equal(client.isRunning, false);
  await client.start().catch(() => {});
  assert.equal(client.isRunning, false);
});

test("isRunning is false after the app-server exits", async () => {
  const client = new CodexClient(fakeCodexBin("process.exit(0);"));
  const exited = new Promise((resolve) => client.once("exit", resolve));
  await client.start();
  await exited;
  assert.equal(client.isRunning, false);
});

// The app-server's last words are the only explanation for a panic or an auth
// failure printed on the way out; an exit code alone diagnoses nothing.
test("an unexpected exit fails pending requests with the stderr tail", async () => {
  const client = new CodexClient(
    fakeCodexBin(`
process.stdin.on("data", () => {
  process.stderr.write("thread 'main' panicked: auth token missing\\n");
  setTimeout(() => process.exit(1), 50);
});
`),
  );
  await client.start();
  await assert.rejects(client.request("model/list", {}), /exited with code 1.*auth token missing/s);
  assert.match(client.stderrTail, /auth token missing/);
});

// stop() used to drop pending entries (and their timers) without rejecting, so
// getUsage/thread/start/thread/resume callers hung forever.
test("stop() rejects in-flight requests instead of hanging their callers", async () => {
  const client = new CodexClient(fakeCodexBin("process.stdin.resume();"));
  await client.start();
  const pending = client.request("thread/start", {});
  const rejected = assert.rejects(pending, /stopped before the request completed/);
  await client.stop();
  await rejected;
});

// Protocol corruption used to present as a 60s RPC timeout.
test("a malformed line naming a pending request rejects that request", async () => {
  const client = new CodexClient(
    fakeCodexBin(`
function respond(msg) {
  return ['{"id":' + msg.id + ',"result":{oops'];
}
${REPLY_LOOP}`),
  );
  await client.start();
  try {
    await assert.rejects(client.request("initialize", {}), /Malformed app-server response/);
  } finally {
    await client.stop();
  }
});

// …but the id scrape must not fire on a truncated NOTIFICATION: those carry ids
// of their own (thread/turn/item), which can collide with a live request id and
// would reject the wrong caller. Only a line that looks like a response counts.
test("a truncated notification carrying a colliding id leaves the request pending", async () => {
  const client = new CodexClient(
    fakeCodexBin(`
function respond(msg) {
  return [
    '{"method":"codex/event","params":{"id":' + msg.id + ',"delta":"partial',
    JSON.stringify({ id: msg.id, result: { ok: true } }),
  ];
}
${REPLY_LOOP}`),
  );
  await client.start();
  try {
    assert.deepEqual(await client.request("initialize", {}), { ok: true });
  } finally {
    await client.stop();
  }
});

test("an RPC error carries its data payload into the rejection", async () => {
  const client = new CodexClient(
    fakeCodexBin(`
function respond(msg) {
  return [JSON.stringify({
    id: msg.id,
    error: { code: -32000, message: "turn rejected", data: { reason: "token expired" } },
  })];
}
${REPLY_LOOP}`),
  );
  await client.start();
  try {
    await assert.rejects(
      client.request("turn/start", {}),
      /RPC error -32000: turn rejected \(.*token expired.*\)/,
    );
  } finally {
    await client.stop();
  }
});

// A stopped app-server can take a while to exit. Its exit used to land on the
// client as if the respawned process had died: pending requests failed and
// isRunning went false under a healthy process.
test("an old process exiting after a respawn leaves the new one alone", async () => {
  // SIGTERM leaves the process up (the interval keeps it alive once stdin ends),
  // so it exits only when the test kills it, after the respawn. "slow" is
  // answered only when "release" arrives on the same pipe.
  const opts = fakeCodexBin(`
process.on("SIGTERM", () => setInterval(() => {}, 60_000));
let held = null;
function respond(msg) {
  if (msg.method === "slow") {
    held = msg.id;
    return [];
  }
  const out = [JSON.stringify({ id: msg.id, result: {} })];
  if (msg.method === "release" && held !== null) out.unshift(JSON.stringify({ id: held, result: { ok: true } }));
  return out;
}
${REPLY_LOOP}`);
  const client = new CodexClient(opts);
  const procOf = () => (client as unknown as { proc: ChildProcess }).proc;
  const exits: unknown[] = [];
  client.on("exit", (code) => exits.push(code));
  let old: ChildProcess | null = null;
  try {
    await client.start();
    old = procOf();
    await client.stop();
    await client.start();
    const slow = client.request("slow", {});
    // The old process exits while the new one has a request in flight.
    const oldExited = once(old, "exit");
    old.kill("SIGKILL");
    await oldExited;
    await client.request("release", {});
    assert.deepEqual(await slow, { ok: true });
    assert.equal(client.isRunning, true);
    assert.deepEqual(exits, [], "the superseded process's exit is not reported");
  } finally {
    // Both processes ignore SIGTERM, so stop() alone would leave them running.
    old?.kill("SIGKILL");
    procOf()?.kill("SIGKILL");
    await client.stop();
  }
});
