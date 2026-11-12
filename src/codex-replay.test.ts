/**
 * Replay of real Codex app-server traffic, recorded by
 * `scripts/record-codex-fixtures.ts` against the CLI pinned in package.json
 * (`codexBindings.codexCli`). Three checks:
 *
 *  - Coverage: every server method and item type in the fixtures is either
 *    mapped by the normalizer or listed as deliberately ignored.
 *  - Contract: every event the normalizer produces parses as an `AgentEvent`.
 *  - Goldens: every recorded turn, replayed in order through
 *    `CodexAgentProvider`, yields the event sequence in
 *    `<scenario>.golden.json`, with a `turn N` line where each later turn
 *    begins. Regenerate with
 *    `UPDATE_GOLDENS=1 node --test src/codex-replay.test.ts` after a re-record.
 *
 * Bumping the pin without re-recording fails the first test: the fixtures are
 * the evidence that the new CLI still speaks the protocol this package maps.
 */

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { AgentEvent } from "./types/index.ts";

import { CodexAgentProvider } from "./codex-provider.ts";
import { testCodexHome } from "./testing/codex-home.ts";
import {
  IGNORED_ITEM_TYPES,
  IGNORED_METHODS,
  notificationToEvent,
  requestToApproval,
} from "./normalize.ts";
import type { ServerNotification } from "./generated/ServerNotification.ts";
import type { ServerRequest } from "./generated/ServerRequest.ts";

const PKG_DIR = new URL("..", import.meta.url).pathname;
const PIN = (
  JSON.parse(readFileSync(join(PKG_DIR, "package.json"), "utf8")) as { codexBindings: { codexCli: string } }
).codexBindings.codexCli;
const FIXTURE_DIR = join(PKG_DIR, "fixtures", `codex-${PIN}`);

interface Frame {
  d: "in" | "out";
  t: number;
  m: { id?: number | string; method?: string; params?: unknown; result?: unknown; error?: unknown };
}
interface Fixture {
  name: string;
  frames: Frame[];
}

function loadFixtures(): Fixture[] {
  if (!existsSync(FIXTURE_DIR)) return [];
  return readdirSync(FIXTURE_DIR)
    .filter((f) => f.endsWith(".ndjson"))
    .sort()
    .map((f) => {
      const [, ...rest] = readFileSync(join(FIXTURE_DIR, f), "utf8").trim().split("\n");
      return { name: f.replace(/\.ndjson$/, ""), frames: rest.map((l) => JSON.parse(l) as Frame) };
    });
}

const fixtures = loadFixtures();
const isNotification = (f: Frame) => f.d === "in" && f.m.method != null && f.m.id === undefined;
const isServerRequest = (f: Frame) => f.d === "in" && f.m.method != null && f.m.id !== undefined;

test(`fixtures exist for the pinned codex CLI (${PIN})`, () => {
  assert.ok(
    fixtures.length > 0,
    `no fixtures in ${FIXTURE_DIR}: re-record with scripts/record-codex-fixtures.ts after regenerating the bindings`,
  );
});

test("every recorded server method is mapped or deliberately ignored", () => {
  const seen = new Map<string, boolean>();
  for (const { frames } of fixtures) {
    for (const f of frames) {
      if (isNotification(f)) {
        const mapped = notificationToEvent(f.m as ServerNotification) !== null;
        seen.set(f.m.method!, (seen.get(f.m.method!) ?? false) || mapped);
      } else if (isServerRequest(f)) {
        const mapped = requestToApproval(f.m as ServerRequest) !== null;
        seen.set(f.m.method!, (seen.get(f.m.method!) ?? false) || mapped);
      }
    }
  }
  const unmapped = [...seen].filter(([m, mapped]) => !mapped && !(m in IGNORED_METHODS)).map(([m]) => m);
  assert.deepEqual(unmapped, [], "map these in normalize.ts or list them in IGNORED_METHODS");
  const stale = Object.keys(IGNORED_METHODS).filter((m) => seen.get(m) === true);
  assert.deepEqual(stale, [], "these are mapped now; drop them from IGNORED_METHODS");
});

test("every recorded item type is mapped or deliberately ignored", () => {
  const seen = new Map<string, boolean>();
  for (const { frames } of fixtures) {
    for (const f of frames) {
      if (f.m.method !== "item/started" && f.m.method !== "item/completed") continue;
      const type = (f.m.params as { item: { type: string } }).item.type;
      const mapped = notificationToEvent(f.m as ServerNotification) !== null;
      seen.set(type, (seen.get(type) ?? false) || mapped);
    }
  }
  const unmapped = [...seen].filter(([t, mapped]) => !mapped && !(t in IGNORED_ITEM_TYPES)).map(([t]) => t);
  assert.deepEqual(unmapped, [], "map these in normalize.ts or list them in IGNORED_ITEM_TYPES");
  const stale = Object.keys(IGNORED_ITEM_TYPES).filter((t) => seen.get(t) === true);
  assert.deepEqual(stale, [], "these are mapped now; drop them from IGNORED_ITEM_TYPES");
});

test("every event the normalizer produces from the fixtures honors the contract", () => {
  for (const { name, frames } of fixtures) {
    for (const f of frames.filter(isNotification)) {
      const ev = notificationToEvent(f.m as ServerNotification);
      if (ev) assert.doesNotThrow(() => AgentEvent.parse(ev), `${name}: ${f.m.method}`);
    }
  }
});

// ── end-to-end replay ────────────────────────────────────────────────────────

/**
 * A Codex client that answers from a recording: `thread/start` returns the
 * recorded response, and each `turn/start` replays the next recorded turn,
 * every server frame up to and including its `turn/completed`. A turn the
 * recording started some other way (`thread/compact/start`) has no `turn/start`
 * response, so it gets one built from its own `turn/started`.
 */
class ReplayClient extends EventEmitter {
  isRunning = true;
  private readonly frames: Frame[];
  private cursor: number;
  private turnStarts = 0;

  constructor(frames: Frame[]) {
    super();
    this.frames = frames;
    this.cursor = frames.findIndex((f) => f.d === "out" && f.m.method === "turn/start") + 1;
  }

  /** The recorded response to the `nth` request of `method`, if there was one. */
  private responseTo(method: string, nth = 0): unknown {
    const out = this.frames.filter((f) => f.d === "out" && f.m.method === method)[nth];
    if (!out) return undefined;
    const at = this.frames.indexOf(out);
    return this.frames.find((f, i) => i > at && f.d === "in" && f.m.id === out.m.id && f.m.method == null)?.m.result;
  }

  async threadStart(): Promise<unknown> {
    const result = this.responseTo("thread/start");
    assert.ok(result, "fixture never sent thread/start");
    return result;
  }

  async turnStart(): Promise<unknown> {
    const replay: Frame[] = [];
    let i = this.cursor;
    for (; i < this.frames.length; i++) {
      const f = this.frames[i];
      if (f.d !== "in" || f.m.method == null) continue;
      replay.push(f);
      if (f.m.method === "turn/completed") break;
    }
    this.cursor = i + 1;
    const started = replay.find((f) => f.m.method === "turn/started")?.m.params as { turn: unknown } | undefined;
    const result = this.responseTo("turn/start", this.turnStarts++) ?? { turn: started?.turn };
    // After the response resolves, as on the wire.
    setImmediate(() => {
      for (const f of replay) this.emit(isServerRequest(f) ? "approval" : "notification", f.m);
    });
    return result;
  }

  async turnSteer(): Promise<unknown> {
    return {};
  }
  async request(): Promise<unknown> {
    return {};
  }
  async resolveApproval(): Promise<void> {}
  async rejectServerRequest(): Promise<void> {}
  async stop(): Promise<void> {}
}

/** Consecutive repeats collapse (`agent.message.delta ×14`); errors show their
 *  code and whether they ended the turn. */
function summarize(events: AgentEvent[]): string[] {
  const out: Array<{ label: string; n: number }> = [];
  for (const ev of events) {
    const label =
      ev.type === "error.raised" ? `error.raised:${ev.code}:${ev.fatal === false ? "warning" : "fatal"}` : ev.type;
    const last = out.at(-1);
    if (last?.label === label) last.n += 1;
    else out.push({ label, n: 1 });
  }
  return out.map(({ label, n }) => (n > 1 ? `${label} ×${n}` : label));
}

/** Every recorded turn's events, in order, on one provider. */
async function replayTurns(frames: Frame[]): Promise<AgentEvent[][]> {
  const provider = new CodexAgentProvider({
    ...testCodexHome(), turnTimeoutMs: 10_000 });
  const slot = provider as unknown as { client: EventEmitter; started: boolean };
  // The constructor listens to its own client (usage, notices); carry those
  // listeners over so the replay feeds them too.
  const replay = new ReplayClient(frames);
  for (const l of slot.client.listeners("notification")) replay.on("notification", l as (...a: unknown[]) => void);
  slot.client = replay;
  slot.started = true;
  const thread = await provider.startThread({ cwd: "/ws" });
  const turns = frames.filter((f) => f.d === "in" && f.m.method === "turn/completed").length;
  const out: AgentEvent[][] = [];
  for (let n = 0; n < turns; n++) {
    const events: AgentEvent[] = [];
    for await (const ev of provider.sendTurn(thread.id, { text: "replayed" })) events.push(ev);
    out.push(events);
  }
  return out;
}

/** The golden's lines: each turn summarized, later turns headed `turn N`. */
const goldenLines = (turns: AgentEvent[][]): string[] =>
  turns.flatMap((events, i) => [...(i > 0 ? [`turn ${i + 1}`] : []), ...summarize(events)]);

test("a recorded manual compaction reports its real before and after sizes", async (t) => {
  const fixture = fixtures.find((f) => f.name === "compaction-manual");
  if (!fixture) return t.skip("no compaction fixture for this pin");
  const done = (await replayTurns(fixture.frames))
    .flat()
    .find((e) => e.type === "context.compaction" && e.phase === "completed");
  assert.ok(done?.type === "context.compaction");
  // The recording's last usage before it (3,521 total, no reasoning tokens),
  // and the size Codex reports once the compacted history is loaded. On a
  // conversation this short the summary prompt outweighs what it replaced.
  assert.equal(done.preTokens, 3_521);
  assert.equal(done.postTokens, 4_184);
});

for (const { name, frames } of fixtures) {
  test(`replaying ${name} yields its golden event sequence`, async () => {
    const actual = goldenLines(await replayTurns(frames));
    const goldenPath = join(FIXTURE_DIR, `${name}.golden.json`);
    if (process.env.UPDATE_GOLDENS) writeFileSync(goldenPath, JSON.stringify(actual, null, 2) + "\n");
    assert.ok(existsSync(goldenPath), `no golden for ${name}; run with UPDATE_GOLDENS=1`);
    assert.deepEqual(actual, JSON.parse(readFileSync(goldenPath, "utf8")));
  });
}
