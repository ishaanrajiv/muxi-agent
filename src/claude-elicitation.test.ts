/**
 * Elicitation bridge on the Claude backend: an MCP server's `ask_user` question
 * (an MCP elicitation) must surface as an `approval.requested` event of kind
 * `mcpElicitation`, block until {@link ClaudeAgentProvider.resolveApproval}
 * settles it, and translate the decision into the MCP `ElicitResult` the SDK
 * hands back to the MCP tool. Driven through the `queryFn` seam — no CLI.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { query } from "@anthropic-ai/claude-agent-sdk";
import type { TurnStreamEvent } from "./types/index.ts";

import { ClaudeAgentProvider } from "./claude-provider.ts";

type QueryArgs = Parameters<typeof query>[0];
type ApprovalRequested = Extract<TurnStreamEvent, { type: "approval.requested" }>;

const initConnected = {
  type: "system",
  subtype: "init",
  mcp_servers: [{ name: "lab", status: "connected" }],
};
const resultOk = {
  type: "result",
  subtype: "success",
  is_error: false,
  result: "hi",
  usage: { input_tokens: 1, output_tokens: 1 },
};

const QUESTION_ENVELOPE = JSON.stringify({
  kind: "question",
  question: "Which definition of active users?",
  options: ["Celsius (default)", "Fahrenheit"],
  context: "",
});

const QUESTION_ENVELOPE_V2 = JSON.stringify({
  kind: "question",
  version: 2,
  context: "",
  questions: [
    { question: "Which definition of active users?", options: [] },
    { question: "Include internal accounts?", options: [] },
  ],
});

/** A turn whose stream raises one elicitation mid-turn via `onElicitation`. */
function elicitingTurn(
  args: QueryArgs,
  message: string,
  onResult: (r: unknown) => void,
): AsyncGenerator<unknown> {
  return (async function* () {
    yield initConnected;
    const handler = args.options?.onElicitation;
    assert.ok(handler, "provider must register onElicitation");
    onResult(
      await handler(
        { serverName: "lab", message, mode: "form", requestedSchema: { type: "object" } },
        { signal: new AbortController().signal, requestId: "elicit-1" },
      ),
    );
    yield resultOk;
  })();
}

async function runTurnWithElicitation(
  message: string,
  decide: (provider: ClaudeAgentProvider, request: ApprovalRequested["request"]) => void,
): Promise<{ events: TurnStreamEvent[]; elicitResult: unknown }> {
  let elicitResult: unknown;
  const provider = new ClaudeAgentProvider({
    queryFn: ((args: QueryArgs) =>
      elicitingTurn(args, message, (r) => {
        elicitResult = r;
      })) as unknown as typeof query,
  });
  const thread = await provider.startThread({ cwd: "/tmp" } as Parameters<
    ClaudeAgentProvider["startThread"]
  >[0]);
  const events: TurnStreamEvent[] = [];
  for await (const ev of provider.sendTurn(thread.id, {
    text: "hello",
  } as Parameters<ClaudeAgentProvider["sendTurn"]>[1])) {
    events.push(ev);
    if (ev.type === "approval.requested") decide(provider, ev.request);
  }
  return { events, elicitResult };
}

test("ask_user elicitation surfaces as mcpElicitation and returns the answer", async () => {
  const { events, elicitResult } = await runTurnWithElicitation(
    QUESTION_ENVELOPE,
    (provider, request) => {
      void provider.resolveApproval(request.requestId, {
        action: "accept",
        content: { answer: "MAU", ignored: { nested: true } },
      });
    },
  );
  const approval = events.find((e) => e.type === "approval.requested") as ApprovalRequested;
  assert.ok(approval, "elicitation must surface as approval.requested");
  assert.equal(approval.request.kind, "mcpElicitation");
  // The envelope's question becomes the summary so Inbox rows read as the question.
  assert.equal(approval.request.summary, "Which definition of active users?");
  const detail = approval.request.detail as Record<string, unknown>;
  assert.equal(detail.serverName, "lab");
  assert.equal(detail.message, QUESTION_ENVELOPE);
  // Non-primitive content values are dropped; the answer rides through.
  assert.deepEqual(elicitResult, { action: "accept", content: { answer: "MAU" } });
});

test("declining the question resolves the elicitation as declined", async () => {
  const { elicitResult } = await runTurnWithElicitation(QUESTION_ENVELOPE, (provider, request) => {
    void provider.resolveApproval(request.requestId, { action: "decline" });
  });
  assert.deepEqual(elicitResult, { action: "decline" });
});

test("a v2 multi-question envelope summarizes as first question plus count", async () => {
  const { events, elicitResult } = await runTurnWithElicitation(
    QUESTION_ENVELOPE_V2,
    (provider, request) => {
      void provider.resolveApproval(request.requestId, {
        action: "accept",
        content: { answer_1: "MAU", answer_2: "Exclude internal" },
      });
    },
  );
  const approval = events.find((e) => e.type === "approval.requested") as ApprovalRequested;
  assert.equal(approval.request.summary, "Which definition of active users? (+1 more)");
  assert.deepEqual(elicitResult, {
    action: "accept",
    content: { answer_1: "MAU", answer_2: "Exclude internal" },
  });
});

test("a non-envelope elicitation keeps a generic summary", async () => {
  const { events } = await runTurnWithElicitation("plain confirmation text", (provider, request) => {
    void provider.resolveApproval(request.requestId, { action: "decline" });
  });
  const approval = events.find((e) => e.type === "approval.requested") as ApprovalRequested;
  assert.equal(approval.request.summary, "Agent asks a clarifying question");
});
