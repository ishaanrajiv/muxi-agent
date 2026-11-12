/**
 * AskUserQuestion on the Claude backend: offered only on a thread started with
 * `askUser`, raised as a `userInput` approval carrying the questions, and
 * answered through `updatedInput.answers` (a bare allow would make the CLI
 * report that the person didn't answer). Driven through the `queryFn` seam.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { query } from "@anthropic-ai/claude-agent-sdk";
import type { ApprovalDecision, TurnStreamEvent } from "./types/index.ts";
import { answersContent, questionsOf } from "./types/index.ts";

import { ClaudeAgentProvider } from "./claude-provider.ts";

type QueryArgs = Parameters<typeof query>[0];
type ApprovalRequested = Extract<TurnStreamEvent, { type: "approval.requested" }>;

const resultOk = { type: "result", subtype: "success", is_error: false, result: "ok", usage: { input_tokens: 1, output_tokens: 1 } };

const INPUT = {
  questions: [
    {
      question: "Which room should I clean?",
      header: "Room",
      multiSelect: false,
      options: [
        { label: "Kitchen", description: "The floor by the stove" },
        { label: "Office", description: "" },
      ],
    },
    { question: "When?", header: "Time", multiSelect: true, options: [{ label: "Now" }, { label: "Tonight" }] },
  ],
};

async function ask(decide: (request: ApprovalRequested["request"]) => ApprovalDecision, opts: { askUser?: boolean; agentID?: string; input?: typeof INPUT } = {}) {
  const input = opts.input ?? INPUT;
  let permission: unknown;
  let tools: unknown;
  const provider = new ClaudeAgentProvider({
    queryFn: ((args: QueryArgs) =>
      (async function* () {
        tools = args.options?.tools;
        yield { type: "system", subtype: "init", mcp_servers: [] };
        permission = await args.options!.canUseTool!("AskUserQuestion", input, {
          signal: new AbortController().signal,
          toolUseID: "toolu_1",
          ...(opts.agentID ? { agentID: opts.agentID } : {}),
        } as Parameters<NonNullable<NonNullable<QueryArgs["options"]>["canUseTool"]>>[2]);
        yield resultOk;
      })()) as unknown as typeof query,
  });
  const thread = await provider.startThread({ cwd: "/tmp", ...(opts.askUser === false ? {} : { askUser: true }) });
  const events: TurnStreamEvent[] = [];
  for await (const ev of provider.sendTurn(thread.id, { text: "hello" })) {
    events.push(ev);
    if (ev.type === "approval.requested") void provider.resolveApproval(ev.request.requestId, decide(ev.request));
  }
  const approval = events.find((e) => e.type === "approval.requested") as ApprovalRequested | undefined;
  return { permission, tools, approval };
}

test("a thread with askUser offers AskUserQuestion; one without doesn't", async () => {
  assert.ok(((await ask(() => ({ action: "decline" }))).tools as string[]).includes("AskUserQuestion"));
  assert.ok(!((await ask(() => ({ action: "decline" }), { askUser: false })).tools as string[]).includes("AskUserQuestion"));
});

test("the question arrives as userInput, and the answers reach the model in updatedInput", async () => {
  const { permission, approval } = await ask((request) => ({
    action: "accept",
    content: answersContent(request, { "Which room should I clean?": "Kitchen", "When?": "Now, Tonight", "Not asked?": "x" }),
  }));
  assert.ok(approval);
  assert.equal(approval.request.kind, "userInput");
  assert.equal(approval.request.summary, "Which room should I clean? (+1 more)");
  assert.deepEqual(questionsOf(approval.request), [
    { id: "Which room should I clean?", question: "Which room should I clean?", header: "Room", multiSelect: false, options: [{ label: "Kitchen", description: "The floor by the stove" }, { label: "Office" }] },
    { id: "When?", question: "When?", header: "Time", multiSelect: true, options: [{ label: "Now" }, { label: "Tonight" }] },
  ]);
  assert.deepEqual(permission, { behavior: "allow", updatedInput: { ...INPUT, answers: { "Which room should I clean?": "Kitchen", "When?": "Now, Tonight" } } });
});

test("a question the model padded with whitespace is still answered: the host keys it trimmed", async () => {
  const padded = { questions: [{ ...INPUT.questions[0]!, question: "  Which room should I clean?\n" }] };
  const { permission, approval } = await ask((request) => ({ action: "accept", content: answersContent(request, { "Which room should I clean?": "Office" }) }), { input: padded });
  assert.equal(questionsOf(approval!.request)?.[0]?.question, "Which room should I clean?");
  // Handed back under the question as the model wrote it, which is how the CLI matches it.
  assert.deepEqual(permission, { behavior: "allow", updatedInput: { ...padded, answers: { "  Which room should I clean?\n": "Office" } } });
});

test("a decline, or an accept with no answers, denies with the person's note or a default", async () => {
  assert.deepEqual((await ask(() => ({ action: "decline", reason: "The person declined and said: not today" }))).permission, {
    behavior: "deny",
    message: "The person declined and said: not today",
  });
  assert.deepEqual((await ask(() => ({ action: "accept", content: { answers: {} } }))).permission, {
    behavior: "deny",
    message: "The person didn't answer. Use your best judgment and carry on.",
  });
});

test("a subagent can't ask the person", async () => {
  const { permission, approval } = await ask(() => ({ action: "accept" }), { agentID: "agent-1" });
  assert.equal(approval, undefined);
  assert.equal((permission as { behavior: string }).behavior, "deny");
});

test("Codex's questions are read by id and answered by id", () => {
  const request = {
    kind: "userInput" as const,
    detail: { questions: [{ id: "q1", header: "Room", question: "Which room?", isOther: true, isSecret: false, options: [{ label: "Kitchen", description: "" }] }] },
  };
  assert.deepEqual(questionsOf(request), [{ id: "q1", question: "Which room?", header: "Room", multiSelect: false, options: [{ label: "Kitchen" }] }]);
  assert.deepEqual(answersContent(request, { "Which room?": "Office" }), { answers: { q1: { answers: ["Office"] } } });
  assert.equal(questionsOf({ kind: "command", detail: request.detail }), null);
});
