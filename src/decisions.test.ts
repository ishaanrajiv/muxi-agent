import assert from "node:assert/strict";
import { test } from "node:test";

import type { ApprovalDecision, ApprovalKind } from "./types/index.ts";

import { decisionToWire, decisionToWireForRequest } from "./normalize.ts";

const accept: ApprovalDecision = { action: "accept" };
const decline: ApprovalDecision = { action: "decline" };

// The Phase 1 spike regression guard: command/file approvals use the
// ReviewDecision enum, NOT "accept". This is the bug that lay dormant because
// the read-only spike only ever triggered MCP elicitation.

test("decisionToWire maps each approval kind to its wire shape", () => {
  const cases: Array<[kind: ApprovalKind, decision: ApprovalDecision, wire: unknown, label: string]> = [
    ["command", accept, { decision: "approved" }, "command approval maps accept -> { decision: 'approved' }, not 'accept'"],
    ["command", decline, { decision: "denied" }, "command approval maps decline -> { decision: 'denied' }"],
    ["fileChange", accept, { decision: "approved" }, "fileChange approval uses the ReviewDecision shape"],
    [
      "command",
      { action: "approve_for_session" },
      { decision: "approved_for_session" },
      "approve_for_session maps to 'approved_for_session'",
    ],
    ["command", { action: "abort" }, { decision: "abort" }, "abort maps to 'abort'"],
    [
      "mcpElicitation",
      accept,
      { action: "accept", content: null, _meta: null },
      "mcpElicitation maps accept -> { action: 'accept', content, _meta }",
    ],
    [
      "mcpElicitation",
      { action: "accept", content: { ok: true }, _meta: { x: 1 } },
      { action: "accept", content: { ok: true }, _meta: { x: 1 } },
      "mcpElicitation passes through content and _meta",
    ],
    [
      "mcpElicitation",
      decline,
      { action: "decline", content: null, _meta: null },
      "mcpElicitation maps decline -> { action: 'decline' }",
    ],
  ];
  for (const [kind, decision, wire, label] of cases) {
    assert.deepEqual(decisionToWire(kind, decision), wire, label);
  }
});

test("decisionToWireForRequest maps each request method to its wire shape", () => {
  const cases: Array<
    [method: Parameters<typeof decisionToWireForRequest>[0], decision: ApprovalDecision, wire: unknown, label: string]
  > = [
    [
      "item/commandExecution/requestApproval",
      accept,
      { decision: "accept" },
      "v2 command approval maps accept -> { decision: 'accept' }",
    ],
    [
      "item/fileChange/requestApproval",
      { action: "approve_for_session" },
      { decision: "acceptForSession" },
      "v2 file approval maps approve_for_session -> acceptForSession",
    ],
    ["execCommandApproval", accept, { decision: "approved" }, "legacy exec approval keeps ReviewDecision shape"],
    [
      "item/tool/requestUserInput",
      { action: "accept", content: { q1: "yes", q2: ["a", "b"] } },
      { answers: { q1: { answers: ["yes"] }, q2: { answers: ["a", "b"] } } },
      "userInput converts content map to Codex answer objects",
    ],
  ];
  for (const [method, decision, wire, label] of cases) {
    assert.deepEqual(decisionToWireForRequest(method, decision), wire, label);
  }
});
