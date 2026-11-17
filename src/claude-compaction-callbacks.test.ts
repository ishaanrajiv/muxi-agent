/**
 * The host's compaction callbacks as the hooks a Claude turn registers.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { HookInput } from "@anthropic-ai/claude-agent-sdk";

import { compactionHooks } from "./claude/hooks.ts";
import type { CompactionCallbacks } from "./provider.ts";

const BASE = { session_id: "s", transcript_path: "/w/t.jsonl", cwd: "/w" };

/** Run the hook registered for `input`'s event, as the CLI would. */
async function fire(callbacks: CompactionCallbacks, input: Record<string, unknown>) {
  const hooks = compactionHooks("thread-1", callbacks) ?? {};
  const event = input.hook_event_name as keyof typeof hooks;
  const hook = hooks[event]?.[0]?.hooks[0];
  assert.ok(hook, `a hook is registered for ${event}`);
  return hook({ ...BASE, ...input } as HookInput, undefined, { signal: new AbortController().signal });
}

test("no callbacks register no hooks, and each callback registers only its own event", () => {
  assert.equal(compactionHooks("thread-1", undefined), null);
  assert.deepEqual(Object.keys(compactionHooks("thread-1", { after: () => {} }) ?? {}), ["PostCompact"]);
});

test("before and after are told the thread, the trigger and what the CLI passed", async () => {
  const seen: unknown[] = [];
  const callbacks: CompactionCallbacks = { before: (c) => void seen.push(c), after: (c) => void seen.push(c) };
  await fire(callbacks, { hook_event_name: "PreCompact", trigger: "auto", custom_instructions: "" });
  await fire(callbacks, { hook_event_name: "PostCompact", trigger: "manual", compact_summary: "what happened" });
  assert.deepEqual(seen, [
    { threadId: "thread-1", trigger: "auto", instructions: null },
    { threadId: "thread-1", trigger: "manual", summary: "what happened" },
  ]);
});

test("a callback is awaited before the hook answers", async () => {
  let saved = false;
  await fire(
    { before: async () => { await new Promise((r) => setTimeout(r, 5)); saved = true; } },
    { hook_event_name: "PreCompact", trigger: "auto", custom_instructions: null },
  );
  assert.equal(saved, true);
});

test("contextAfter adds context only as a compacted conversation resumes", async () => {
  const callbacks: CompactionCallbacks = { contextAfter: () => "re-read the notes" };
  assert.deepEqual(await fire(callbacks, { hook_event_name: "SessionStart", source: "compact" }), {
    hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "re-read the notes" },
  });
  assert.deepEqual(await fire(callbacks, { hook_event_name: "SessionStart", source: "resume" }), { continue: true });
  assert.deepEqual(await fire({ contextAfter: () => null }, { hook_event_name: "SessionStart", source: "compact" }), { continue: true });
});

test("a subagent's compaction calls nothing", async () => {
  let called = false;
  await fire({ before: () => void (called = true) }, { hook_event_name: "PreCompact", trigger: "auto", custom_instructions: null, agent_id: "a1" });
  assert.equal(called, false);
});

test("a callback that throws leaves the compaction alone", async () => {
  const warn = console.warn;
  console.warn = () => {};
  try {
    const out = await fire(
      { contextAfter: () => { throw new Error("boom"); } },
      { hook_event_name: "SessionStart", source: "compact" },
    );
    assert.deepEqual(out, { continue: true });
  } finally {
    console.warn = warn;
  }
});
