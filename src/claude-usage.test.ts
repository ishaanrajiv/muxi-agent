import assert from "node:assert/strict";
import { test } from "node:test";

import type { query } from "@anthropic-ai/claude-agent-sdk";
import type { StartThreadInput, TurnInput, TurnStreamEvent } from "./types/index.ts";

import { ClaudeAgentProvider } from "./claude-provider.ts";
import { parseClaudeUsage, pickContextWindow, readContextUsage } from "./claude/usage.ts";

// A representative `claude -p "/usage"` body (the `result` string of the JSON
// envelope). We only assert on the parsed windows — the prose below the windows
// is intentionally ignored.
const SAMPLE = [
  "You are currently using your subscription to power your Claude Code usage",
  "",
  "Current session: 34% used · resets Jun 17 at 6:19pm (Asia/Calcutta)",
  "Current week (all models): 10% used · resets Jun 23 at 1:29am (Asia/Calcutta)",
  "Current week (Fable): 13% used · resets Jun 23 at 1:29am (Asia/Calcutta)",
  "Current week (Sonnet only): 0% used",
  "",
  "What's contributing to your limits usage?",
  "Last 24h · 789 requests · 19 sessions",
].join("\n");

test("drops the Fable-only weekly bucket", () => {
  const usage = parseClaudeUsage(SAMPLE, "claude-code");
  assert.ok(usage);
  assert.ok(!usage.windows.some((w) => /fable/i.test(w.label)));
});

test("parses every window with tidied labels and stripped tz", () => {
  const usage = parseClaudeUsage(SAMPLE, "claude-code");
  assert.ok(usage);
  assert.equal(usage.provider, "claude-code");
  assert.equal(usage.scope, "machine");
  assert.deepEqual(
    usage.windows.map((w) => ({ label: w.label, pct: w.usedPercent, resets: w.resetsLabel })),
    [
      { label: "Session", pct: 34, resets: "Jun 17 at 6:19pm" },
      { label: "Week", pct: 10, resets: "Jun 23 at 1:29am" },
      { label: "Week · Sonnet", pct: 0, resets: null },
    ],
  );
  // Window kind inferred from the label so the UI can format resets by duration.
  assert.deepEqual(usage.windows.map((w) => w.windowMins), [300, 10080, 10080]);
});

test("anchors the reset instant in the zone the CLI names", () => {
  const usage = parseClaudeUsage("Current session: 34% used · resets Jun 18 at 6:19pm (Asia/Calcutta)", "claude-code");
  assert.ok(usage);
  const iso = usage.windows[0].resetsAt;
  assert.ok(iso, "resetsAt should be populated");
  // 6:19pm IST on Jun 18 == 12:49 UTC on Jun 18 (IST is UTC+5:30, fixed).
  const d = new Date(iso!);
  assert.equal(d.getUTCHours(), 12);
  assert.equal(d.getUTCMinutes(), 49);
  assert.equal(d.getUTCMonth(), 5); // June
  assert.equal(d.getUTCDate(), 18);
});

test("a different host zone yields a different instant for the same label", () => {
  const usage = parseClaudeUsage("Current session: 34% used · resets Jun 18 at 6:19pm (UTC)", "claude-code");
  assert.ok(usage);
  const d = new Date(usage.windows[0].resetsAt!);
  assert.equal(d.getUTCHours(), 18);
  assert.equal(d.getUTCMinutes(), 19);
  assert.equal(d.getUTCDate(), 18);
});

test("resolves DST-observing zones at the labeled instant", () => {
  // 6:19pm EDT on Jun 18 == 22:19 UTC (America/New_York is UTC-4 in June).
  const usage = parseClaudeUsage("Current session: 34% used · resets Jun 18 at 6:19pm (America/New_York)", "claude-code");
  assert.ok(usage);
  const d = new Date(usage.windows[0].resetsAt!);
  assert.equal(d.getUTCHours(), 22);
  assert.equal(d.getUTCMinutes(), 19);
});

test("an unknown or missing zone leaves resetsAt null, resetsLabel as fallback", () => {
  const unknown = parseClaudeUsage("Current session: 34% used · resets Jun 18 at 6:19pm (Middle/Nowhere)", "claude-code");
  assert.ok(unknown);
  assert.equal(unknown.windows[0].resetsAt, null);
  assert.equal(unknown.windows[0].resetsLabel, "Jun 18 at 6:19pm");

  const noTz = parseClaudeUsage("Current session: 34% used · resets Jun 18 at 6:19pm", "claude-code");
  assert.ok(noTz);
  assert.equal(noTz.windows[0].resetsAt, null);
  assert.equal(noTz.windows[0].resetsLabel, "Jun 18 at 6:19pm");
});

test("returns null when no windows are present (e.g. API-key billing)", () => {
  assert.equal(parseClaudeUsage("You are using an API key for billing.", "claude-code"), null);
  assert.equal(parseClaudeUsage("", "claude-code"), null);
});

test("tolerates extra whitespace and integer-only lines", () => {
  const usage = parseClaudeUsage("  Current session:   7%  used  ", "claude-code");
  assert.ok(usage);
  assert.equal(usage.windows.length, 1);
  assert.equal(usage.windows[0].usedPercent, 7);
  assert.equal(usage.windows[0].resetsLabel, null);
});

test("pickContextWindow prefers the entry matching the thread's model", () => {
  const mu = {
    "claude-opus-4-8": { contextWindow: 200_000 },
    "claude-haiku-4-5": { contextWindow: 200_000 },
  };
  assert.equal(pickContextWindow(mu, "claude-opus-4-8"), 200_000);
});

test("pickContextWindow falls back to the largest window when no model matches", () => {
  const mu = {
    "claude-haiku-4-5": { contextWindow: 200_000 },
    "claude-opus-4-8[1m]": { contextWindow: 1_000_000 },
  };
  assert.equal(pickContextWindow(mu, "some-unlisted-model"), 1_000_000);
});

test("pickContextWindow returns null when modelUsage is empty or absent", () => {
  assert.equal(pickContextWindow({}, "claude-opus-4-8"), null);
  assert.equal(pickContextWindow(undefined, "claude-opus-4-8"), null);
});

test("readContextUsage breaks down only the rows counted in the total", async () => {
  const categories = [
    { name: "Free space", tokens: 889_000, kind: "free" },
    { name: "MCP tools", tokens: 44_000, kind: "used" },
    { name: "Autocompact buffer", tokens: 33_000, kind: "buffer" },
    { name: "System prompt", tokens: 13_000, kind: "used" },
    { name: "Messages", tokens: 9_000, kind: "used" },
    { name: "Deferred tools", tokens: 6_000, kind: "deferred" },
    { name: "System tools", tokens: 4_000, kind: "used" },
    { name: "Skills", tokens: 0, kind: "used" },
  ];
  const ctx = await readContextUsage({
    getContextUsage: async () => ({ categories, totalTokens: 70_000, maxTokens: 1_000_000 }),
  });
  assert.deepEqual(ctx?.breakdown.map((c) => c.name), ["MCP tools", "System prompt", "Messages", "System tools"]);
  assert.equal(ctx?.breakdown.reduce((sum, c) => sum + c.tokens, 0), ctx?.usedTokens);
});

test("context fill updates before the turn ends once a past turn reported the window", async () => {
  const assistant = (uuid: string, input: number, parent: string | null = null) => ({
    type: "assistant",
    uuid,
    parent_tool_use_id: parent,
    message: { content: [], usage: { input_tokens: input, output_tokens: 0 } },
  });
  const result = { type: "result", subtype: "success", is_error: false, result: "ok", modelUsage: { m: { contextWindow: 200_000 } } };
  const turns = [
    [assistant("a0", 10_000), result],
    [assistant("a1", 20_000), assistant("a1b", 20_000), assistant("s1", 90_000, "toolu_1"), assistant("a2", 30_000), result],
  ];
  let call = 0;
  const provider = new ClaudeAgentProvider({
    queryFn: (() => {
      const frames = turns[call++];
      return (async function* () {
        for (const f of frames) yield f;
      })();
    }) as unknown as typeof query,
  });
  const thread = await provider.startThread({ cwd: "/ws" } as StartThreadInput);
  const fills = async () => {
    const out: Array<number | string> = [];
    for await (const ev of provider.sendTurn(thread.id, { text: "q" } as TurnInput) as AsyncIterable<TurnStreamEvent>) {
      if (ev.type === "context.usage") out.push(ev.usedTokens);
      if (ev.type === "turn.completed") out.push("end");
    }
    return out;
  };
  assert.deepEqual(await fills(), [10_000, "end"], "the first turn has no window until its result");
  assert.deepEqual(await fills(), [20_000, 30_000, 30_000, "end"], "repeats and subagent sizes are not reported");
});
