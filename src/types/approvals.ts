/**
 * Approvals: one normalized request packet and one decision, whatever the
 * backend. Codex sends several request shapes and Claude asks through its
 * permission callback; both collapse into {@link ApprovalRequest}, and each
 * provider maps an {@link ApprovalDecision} back onto its own wire.
 */

import { z } from "zod";

import { SubagentRef } from "./subagents.ts";

/** What the agent is asking permission to do. */
export const ApprovalKind = z.enum([
  "command", // run a shell command, a native tool, or an MCP tool call
  "fileChange", // apply a patch or edit a file
  "mcpElicitation", // an MCP server's elicitation (a question for a person)
  "permissions", // expand the permission profile
  "userInput", // free-form question(s) back to the user
]);
export type ApprovalKind = z.infer<typeof ApprovalKind>;

/**
 * A normalized approval request. `detail` carries the provider's params for
 * renderers that want the full payload (see `mcpToolCallOf` / `toolArgsOf` to
 * read an MCP tool call out of it); `summary` is a one-line description.
 */
export const ApprovalRequest = z.object({
  /**
   * Provider-assigned, process-unique approval id: pass it back verbatim to
   * resolve. Not the backend's native request id (those can repeat across
   * concurrent turns); the provider maps it back internally.
   */
  requestId: z.union([z.number(), z.string()]),
  kind: ApprovalKind,
  threadId: z.string().nullable(),
  turnId: z.string().nullable(),
  /** Human-readable one-line summary of what is being approved. */
  summary: z.string(),
  /** Provider-specific params, for rich renderers and policy. */
  detail: z.unknown(),
  /** Set when one of the turn's subagents made the call. */
  subagent: SubagentRef.optional(),
});
export type ApprovalRequest = z.infer<typeof ApprovalRequest>;

/**
 * A decision on an approval request. `action` is the intent; the provider maps
 * it to the wire shape of the request's kind. `content`/`_meta` carry an MCP
 * elicitation's answer.
 */
export const ApprovalDecision = z.object({
  action: z.enum(["accept", "decline", "cancel", "approve_for_session", "abort"]),
  content: z.unknown().optional(),
  _meta: z.unknown().optional(),
  /** Why a decline happened, for the model. Claude hands it back as the tool's
   *  result; Codex's wire has no such field and drops it. */
  reason: z.string().optional(),
});
export type ApprovalDecision = z.infer<typeof ApprovalDecision>;
