/**
 * Claude edit/rewind + cold-resume steering (agent-parity wave 1). Three things
 * are covered here, all without a CLI:
 *
 *  - {@link isClaudeHumanTurnStart}: tool results come back as top-level `user`
 *    entries with no parent tool call, so only content tells a prompt apart.
 *  - {@link cutUuid}: the fork boundary for keeping the first N turns is the LAST
 *    chain entry of the last kept turn, not its last assistant message — a turn
 *    ending in a tool tail or a structured-output attachment carries entries that
 *    belong to it.
 *  - {@link keptPrompts}: a steer the CLI ran as its own prompt looks like a
 *    turn start and a folded one leaves nothing, so the boundary is found by
 *    matching each turn's logged steers against the prompts that follow it.
 *  - The steering a resumed thread runs under. A cold thread takes ONLY the state
 *    the caller persisted for it; the process-global "last system prompt" fallback is
 *    gone, so one thread can never inherit another's instructions. Driven through
 *    the `queryFn` seam.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { query, SDKUserMessage, SessionMessage } from "@anthropic-ai/claude-agent-sdk";

import { ClaudeAgentProvider } from "./claude-provider.ts";
import { CLAUDE_TOOL_NAME_NOTE } from "./claude/tools.ts";
import { cutUuid, isClaudeHumanTurnStart, keptPrompts } from "./claude/transcript.ts";
import type { Transcript } from "./claude/transcript.ts";
import type { StartThreadInput, TurnInput } from "./types/index.ts";

type QueryArgs = Parameters<typeof query>[0];

/** A `query()` double that captures the args and yields one trivial success. */
function fakeQuery(captured: QueryArgs[]): typeof query {
  return ((args: QueryArgs) => {
    captured.push(args);
    async function* run() {
      yield {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "ok",
        usage: { input_tokens: 1, output_tokens: 1 },
      };
    }
    return run();
  }) as unknown as typeof query;
}

/** The text of the one message a finished turn's prompt carried. */
async function promptText(prompt: QueryArgs["prompt"]): Promise<string> {
  const msgs: SDKUserMessage[] = [];
  for await (const m of prompt as AsyncIterable<SDKUserMessage>) msgs.push(m);
  assert.equal(msgs.length, 1);
  return msgs[0].message.content as string;
}

async function drain(events: AsyncIterable<unknown>): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  for await (const _ of events) {
    // drain — the background producer runs the fake query and settles the turn
  }
}

/** Build a transcript of `turns` turns, each `human, assistant, …tail`, in the
 *  shapes the SDK really returns: a tool result is a top-level `user` entry with
 *  NO parent tool call, told apart from a prompt only by its content. Turn starts
 *  come from {@link isClaudeHumanTurnStart}, the same test the provider runs. */
function transcript(
  turns: Array<{ prompt?: unknown; tail?: Array<"tool_result" | "assistant" | "system"> }>,
): Transcript {
  const msgs: SessionMessage[] = [];
  const push = (type: SessionMessage["type"], message: unknown) => {
    msgs.push({
      type,
      uuid: `m${msgs.length}`,
      session_id: "s",
      message,
      parent_tool_use_id: null,
      parent_agent_id: null,
    });
  };
  for (const turn of turns) {
    push("user", { role: "user", content: turn.prompt ?? "a question" });
    push("assistant", { content: [{ type: "tool_use", id: "call-1" }] });
    for (const entry of turn.tail ?? []) {
      if (entry === "tool_result") {
        push("user", { role: "user", content: [{ type: "tool_result", tool_use_id: "call-1" }] });
      } else {
        push(entry, {});
      }
    }
  }
  return { msgs, starts: msgs.flatMap((m, i) => (isClaudeHumanTurnStart(m) ? [i] : [])) };
}

test("tool results are not turn starts, even with no parent tool call", () => {
  // turn 0 runs two tool rounds; only the two human prompts open turns.
  const t = transcript([{ tail: ["tool_result", "assistant", "tool_result", "assistant"] }, {}]);
  assert.deepEqual(t.starts, [0, 6]);
});

test("the interrupt marker a Stop leaves closes its turn instead of opening one", () => {
  // A real transcript after a mid-tool Stop holds the tool result, this marker
  // as a `user` text entry, and a synthetic "No response requested." reply.
  const base = transcript([{}]).msgs[0];
  const marker = (text: string): SessionMessage => ({
    ...base,
    message: { role: "user", content: [{ type: "text", text }] },
  });
  assert.equal(isClaudeHumanTurnStart(marker("[Request interrupted by user for tool use]")), false);
  assert.equal(isClaudeHumanTurnStart(marker("[Request interrupted by user]")), false);
  assert.equal(
    isClaudeHumanTurnStart({ ...base, message: { role: "user", content: "[Request interrupted by user]" } }),
    false,
  );
  assert.equal(isClaudeHumanTurnStart(marker("[Request interrupted by user] and then a question")), true);
});

test("the summary a compaction leaves is not a turn start", () => {
  // getSessionMessages keeps the summary as a `user` entry flagged is_meta, so
  // a fork cut after a compaction would otherwise land one turn early.
  const base = transcript([{}]).msgs[0];
  const summary = {
    ...base,
    message: { role: "user", content: "This session is being continued from a previous conversation..." },
    isCompactSummary: true,
    is_meta: true,
  } as SessionMessage;
  assert.equal(isClaudeHumanTurnStart(summary), false);
  assert.equal(isClaudeHumanTurnStart(base), true);
});

test("a prompt with text and image parts is a turn start; a subagent's is not", () => {
  const prompt = [
    { type: "image", source: {} },
    { type: "text", text: "what is this?" },
  ];
  const t = transcript([{ prompt }]);
  assert.deepEqual(t.starts, [0]);
  assert.equal(
    isClaudeHumanTurnStart({ ...t.msgs[0], parent_tool_use_id: "call-9" }),
    false,
    "a subagent's prompt belongs to a nested transcript",
  );
});

test("cutUuid keeps every turn when the boundary is at or past the last one", () => {
  const t = transcript([{}, {}]);
  assert.equal(cutUuid(t, 2), undefined);
  assert.equal(cutUuid(t, 7), undefined);
});

test("cutUuid cuts at the last chain entry of the last kept turn", () => {
  // turn 0: human, assistant, tool_result, structured-output attachment.
  const t = transcript([{ tail: ["tool_result", "system"] }, {}]);
  const boundary = t.starts[1];
  assert.equal(cutUuid(t, 1), t.msgs[boundary - 1].uuid);
  // Not the kept turn's last assistant message — that would strand its own tail.
  assert.notEqual(cutUuid(t, 1), t.msgs[1].uuid);
});

test("cutUuid returns nothing when the first turn is the boundary", () => {
  assert.equal(cutUuid(transcript([{}, {}]), 0), undefined);
});

test("keptPrompts with no steers takes one prompt per turn", () => {
  const t = transcript([{}, {}, {}]);
  assert.equal(keptPrompts(t, { keepTurns: 2 }), 2);
  assert.equal(keptPrompts(t, { dropTurns: 1 }), 2);
  assert.equal(keptPrompts(t, { keepTurns: 2 }, [[], [], []]), 2);
  assert.equal(cutUuid(t, keptPrompts(t, { keepTurns: 2 })), cutUuid(t, 2));
});

test("keptPrompts cuts after a steered turn's second prompt, not between its two", () => {
  // turn 0 ran a tool round and took a steer; turn 1 is plain. Three prompts.
  const t = transcript([
    { tail: ["tool_result", "assistant"] },
    { prompt: "also split it by app", tail: ["tool_result", "assistant"] },
    {},
  ]);
  assert.equal(t.starts.length, 3);
  const steers = [["also split it by app"], []];
  // Keeping turn 0 keeps both of its prompts: the cut lands before turn 1's.
  assert.equal(keptPrompts(t, { keepTurns: 1 }, steers), 2);
  assert.equal(cutUuid(t, keptPrompts(t, { keepTurns: 1 }, steers)), t.msgs[t.starts[2] - 1].uuid);
  // Counting turns alone would have cut inside turn 0, at its steer.
  assert.equal(cutUuid(t, 1), t.msgs[t.starts[1] - 1].uuid);
  assert.equal(keptPrompts(t, { keepTurns: 0 }, steers), 0);
  assert.equal(keptPrompts(t, { keepTurns: 2 }, steers), 3);
  // A rollback of the last turn keeps turn 0 whole.
  assert.equal(keptPrompts(t, { dropTurns: 1 }, steers), 2);
});

test("keptPrompts finds turn boundaries when only some steers left a prompt", () => {
  // Three turns, prompts per the log [2, 2, 1]. One steer ran as its own
  // prompt and the other folded into a tool round, so the transcript holds
  // four prompts, and which turn lost one decides every cut.
  const steers = [["split it by app"], ["only last week"], []];

  // Turn 0's steer is a prompt; turn 1's folded.
  const early = transcript([{}, { prompt: "split it by app" }, {}, {}]);
  assert.equal(early.starts.length, 4);
  assert.equal(keptPrompts(early, { keepTurns: 1 }, steers), 2);
  assert.equal(keptPrompts(early, { keepTurns: 2 }, steers), 3);
  assert.equal(keptPrompts(early, { dropTurns: 1 }, steers), 3);
  assert.equal(keptPrompts(early, { dropTurns: 2 }, steers), 2);

  // Turn 0's steer folded; turn 1's is a prompt.
  const late = transcript([{}, {}, { prompt: "only last week" }, {}]);
  assert.equal(keptPrompts(late, { keepTurns: 1 }, steers), 1);
  assert.equal(keptPrompts(late, { keepTurns: 2 }, steers), 3);
  assert.equal(keptPrompts(late, { dropTurns: 1 }, steers), 3);
  assert.equal(keptPrompts(late, { dropTurns: 2 }, steers), 1);
});

test("keptPrompts matches a steer against a prompt with text parts", () => {
  const t = transcript([{}, { prompt: [{ type: "text", text: "split it by app\n" }] }, {}]);
  assert.equal(keptPrompts(t, { keepTurns: 1 }, [["split it by app"], []]), 2);
});

test("keptPrompts reads a prompt the CLI never took as a turn", () => {
  // The log recorded a turn the CLI never took (a Stop beat it), so the
  // transcript holds one prompt fewer than the log has turns. The thread stays
  // editable: the cut counts the transcript's own prompts.
  const tr = transcript([{}, {}]);
  assert.equal(keptPrompts(tr, { keepTurns: 1 }, [[], [], []]), 1);
  assert.equal(keptPrompts(tr, { dropTurns: 1 }, [[], [], []]), 1);
  assert.equal(keptPrompts(tr, { dropTurns: 3 }, [[], [], []]), 0);
  assert.equal(keptPrompts(tr, { keepTurns: 3 }, [[], [], []]), 2);
});

test("rolling back a never-run thread resets it whatever the log says", async () => {
  const provider = new ClaudeAgentProvider({});
  const thread = await provider.startThread({ cwd: "/ws" } as StartThreadInput);
  // Two turns in the log that never reached the CLI: there is no session to cut.
  const result = await provider.rollbackThread(thread.id, 1, { steersPerTurn: [[], []] });
  assert.ok(result.providerSessionId);
  assert.notEqual(result.providerSessionId, thread.id);
});

test("a resumed thread runs under ITS OWN persisted steering, not the last thread's", async () => {
  const captured: QueryArgs[] = [];
  const provider = new ClaudeAgentProvider({
   defaultCwd: "/default",
    queryFn: fakeQuery(captured),
    sessionCheck: { state: async () => "saved", clear: async () => false },
  });
  // Another thread starts in this process and leaves its steering behind.
  await provider.startThread({
    cwd: "/other",
    baseInstructions: "OTHER STEERING",
  } as StartThreadInput);
  // The cold thread is resumed with the state the caller persisted for it.
  const resumed = await provider.resumeThread("cold-thread", {
    providerSessionId: "forked-session",
    systemPrompt: "MY STEERING",
    effort: "high",
    cwd: "/mine",
    mcpServers: { lab: { type: "http", url: "http://127.0.0.1:1/mcp" } },
  });
  assert.equal(resumed.cwd, "/mine");
  await drain(provider.sendTurn("cold-thread", { text: "hi" } as TurnInput));

  const options = captured[0].options!;
  // The prompt is sent in the recorded (`snapshot`) form, so it is the object's
  // `prompt` that has to carry this thread's own steering, plus the tool-name
  // note because the thread has an MCP server.
  assert.deepEqual(options.systemPrompt, {
    type: "custom",
    prompt: `MY STEERING\n\n${CLAUDE_TOOL_NAME_NOTE}`,
    snapshot: true,
  });
  assert.deepEqual(Object.keys(options.mcpServers ?? {}), ["lab"], "the persisted servers come back");
  assert.equal(options.cwd, "/mine");
  assert.equal(options.effort, "high");
  // The thread resumes the SESSION it was forked onto, never the thread id.
  assert.equal((options as { resume?: string }).resume, "forked-session");
});

test("the cold-resume plan-resync ask rides on the user message, not the recorded prompt", async () => {
  const captured: QueryArgs[] = [];
  const provider = new ClaudeAgentProvider({
   defaultCwd: "/default",
    queryFn: fakeQuery(captured),
  });
  await provider.resumeThread("cold-thread", { systemPrompt: "MY STEERING" });

  // First turn after the cold resume: the accumulator is empty, so the CLI is
  // asked for one `TaskList`. The system prompt is snapshotted for the
  // conversation, so the ask has to reach the model some other way.
  await drain(provider.sendTurn("cold-thread", { text: "hi" } as TurnInput));
  const first = await promptText(captured[0].prompt);
  assert.match(first, /call TaskList/);
  assert.match(first, /hi$/);
  assert.equal(
    (captured[0].options!.systemPrompt as { prompt: string }).prompt,
    "MY STEERING",
    "the recorded prompt stays exactly the thread's steering (no MCP servers, so no tool-name note)",
  );

  // The ask is one-shot: the second turn carries the user's text alone.
  await drain(provider.sendTurn("cold-thread", { text: "again" } as TurnInput));
  assert.equal(await promptText(captured[1].prompt), "again");
});

test("a cold thread with nothing persisted gets no system prompt at all", async () => {
  const captured: QueryArgs[] = [];
  const provider = new ClaudeAgentProvider({
   defaultCwd: "/default",
    queryFn: fakeQuery(captured),
  });
  await provider.startThread({
    cwd: "/other",
    baseInstructions: "OTHER STEERING",
  } as StartThreadInput);
  await drain(provider.sendTurn("unknown-thread", { text: "hi" } as TurnInput));

  const options = captured[0].options!;
  assert.equal(options.systemPrompt, undefined);
  assert.equal(options.cwd, "/default");
});

test("rolling back every turn resets the thread to a brand-new session", async () => {
  const captured: QueryArgs[] = [];
  const provider = new ClaudeAgentProvider({
   queryFn: fakeQuery(captured),
  });
  const thread = await provider.startThread({ cwd: "/ws" } as StartThreadInput);
  // A never-run thread has no transcript to fork: rollback resets it instead.
  const result = await provider.rollbackThread(thread.id, 1);
  assert.ok(result.providerSessionId);
  assert.notEqual(result.providerSessionId, thread.id);

  await drain(provider.sendTurn(thread.id, { text: "hi" } as TurnInput));
  const options = captured[0].options!;
  // Fresh again: the next turn CREATES the new session rather than resuming one.
  assert.equal((options as { sessionId?: string }).sessionId, result.providerSessionId);
  assert.equal((options as { resume?: string }).resume, undefined);
});

test("a branch that keeps no turn starts a session of its own", async () => {
  const captured: QueryArgs[] = [];
  const provider = new ClaudeAgentProvider({
   queryFn: fakeQuery(captured),
  });
  const thread = await provider.startThread({ cwd: "/ws" } as StartThreadInput);
  // A thread that never ran has no session to copy, whatever the cut.
  const unran = await provider.forkThread(thread.id);
  await drain(provider.sendTurn(thread.id, { text: "hi" } as TurnInput));
  // Keeping no turn copies nothing, even from a thread that has run.
  const empty = await provider.forkThread(thread.id, { keepTurns: 0, totalTurns: 1, steersPerTurn: [[]] });

  for (const fork of [unran, empty]) {
    assert.notEqual(fork.id, thread.id);
    await drain(provider.sendTurn(fork.id, { text: "next" } as TurnInput));
    const options = captured.at(-1)!.options as { sessionId?: string; resume?: string };
    assert.equal(options.sessionId, fork.id, "its first turn creates the session");
    assert.equal(options.resume, undefined);
  }
});

test("rollbackThread rejects a non-positive turn count", async () => {
  const provider = new ClaudeAgentProvider({});
  await assert.rejects(() => provider.rollbackThread("t", 0), /numTurns must be an integer >= 1/);
});

test("a cold thread resumes a saved session; starts afresh under the same id if none was saved, or if an empty one could be cleared", async () => {
  const cases = [
    { found: "saved", cleared: false, fresh: false },
    { found: "absent", cleared: false, fresh: true },
    { found: "empty", cleared: true, fresh: true },
    { found: "empty", cleared: false, fresh: false },
  ] as const;
  for (const c of cases) {
    const captured: QueryArgs[] = [];
    const asked: string[] = [];
    const clears: string[] = [];
    const provider = new ClaudeAgentProvider({
      queryFn: fakeQuery(captured),
      sessionCheck: { state: async (id) => (asked.push(id), c.found), clear: async (id) => (clears.push(id), c.cleared) },
    });
    await provider.resumeThread("cold", { providerSessionId: "cold-session", cwd: "/ws" });
    await drain(provider.sendTurn("cold", { text: "1" } as TurnInput));
    await drain(provider.sendTurn("cold", { text: "2" } as TurnInput));
    assert.deepEqual(asked, ["cold-session"], `${c.found}: checked once, for the session the thread points at`);
    assert.deepEqual(clears, c.found === "empty" ? ["cold-session"] : [], `${c.found}: only an empty session is cleared`);
    const [first, second] = captured.map((q) => q.options!);
    if (c.fresh) {
      assert.equal(first!.resume, undefined, `${c.found}/${c.cleared}`);
      assert.equal(first!.sessionId, "cold-session");
    } else assert.equal(first!.resume, "cold-session", `${c.found}/${c.cleared}`);
    assert.equal(second!.resume, "cold-session", "later turns resume it either way");
  }
});
