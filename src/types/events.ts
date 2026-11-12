/**
 * The event stream every provider produces: a stable, transport-agnostic union
 * discriminated on `type`. Codex's app-server notifications and Claude's SDK
 * messages are both normalized into it, so nothing downstream is coupled to
 * either backend's wire.
 */

import { z } from "zod";

import { ApprovalRequest } from "./approvals.ts";
import { ToolDenial } from "./denial.ts";
import { DocumentRef, ImageAttachment } from "./shared.ts";
import { AgentSubagentUpdated } from "./subagents.ts";
import { WorkSummaryStep } from "./work-summary.ts";

export const ThreadStarted = z.object({
  type: z.literal("thread.started"),
  threadId: z.string(),
});

/** The message that started a turn. Providers never set it; a host that keeps
 *  an event log may stamp it on `turn.started` so the log carries the prompt. */
export const UserPrompt = z.object({
  text: z.string(),
  images: z.array(ImageAttachment).optional(),
  /** The attached documents by name; their contents stay out of the log. */
  documents: z.array(DocumentRef).optional(),
});
export type UserPrompt = z.infer<typeof UserPrompt>;

/**
 * Why the system (not a person) started a turn: a schedule, a webhook, another
 * turn finishing. Open-ended: `kind` names the source and the rest is the
 * host's own. Providers pass it through untouched.
 */
export const TurnTrigger = z.looseObject({ kind: z.string() });
export type TurnTrigger = z.infer<typeof TurnTrigger>;

export const TurnStarted = z.object({
  type: z.literal("turn.started"),
  threadId: z.string(),
  turnId: z.string(),
  prompt: UserPrompt.optional(),
  /** The backend execution selected for this turn, when known. */
  provider: z.string().optional(),
  model: z.string().optional(),
  effort: z.string().optional(),
  /** Execution-speed tier. `null` means standard. */
  serviceTier: z.string().nullable().optional(),
  /** Set when the system started this turn (see {@link TurnTrigger}). */
  trigger: TurnTrigger.optional(),
});

export const TurnCompleted = z.object({
  type: z.literal("turn.completed"),
  threadId: z.string(),
  turnId: z.string(),
});

/**
 * A message delivered into the turn already running (a mid-turn steer), instead
 * of queued behind it. Providers don't emit it; a host that steers records it
 * between the turn's `turn.started` and its terminal event.
 */
export const TurnSteered = z.object({
  type: z.literal("turn.steered"),
  threadId: z.string(),
  /** The running turn the message was folded into. */
  turnId: z.string(),
  text: z.string(),
  /** The steer's id, so the sender can match the backend's echo to it. */
  steerId: z.string().optional(),
  /** The backend reports when the agent takes the text in: a
   *  {@link TurnSteerRead} with this `steerId` is coming. */
  readReceipt: z.boolean().optional(),
});

/** The backend put a steered message into the agent's context. May land
 *  before the matching `turn.steered`. */
export const TurnSteerRead = z.object({
  type: z.literal("turn.steer.read"),
  threadId: z.string(),
  steerId: z.string(),
});

export const AgentMessageDelta = z.object({
  type: z.literal("agent.message.delta"),
  threadId: z.string(),
  delta: z.string(),
});

export const AgentMessageCompleted = z.object({
  type: z.literal("agent.message.completed"),
  threadId: z.string(),
  itemId: z.string(),
  text: z.string(),
});

export const AgentReasoningDelta = z.object({
  type: z.literal("agent.reasoning.delta"),
  threadId: z.string(),
  delta: z.string(),
});

export const AgentReasoningCompleted = z.object({
  type: z.literal("agent.reasoning.completed"),
  threadId: z.string(),
  itemId: z.string(),
  /** Authoritative reasoning-summary text (finalizes any preceding deltas). */
  text: z.string(),
  /** Provider-neutral display rows (see `normalizeWorkSummary`). */
  summary: z.array(WorkSummaryStep).optional(),
});

/** One part of the agent's plan. */
export const AgentPlanPart = z.object({
  text: z.string(),
  status: z.enum(["pending", "in_progress", "completed"]),
  /** Present-tense label for the running part (Claude's task `activeForm`);
   *  Codex's plan has no equivalent. */
  active: z.string().optional(),
});
export type AgentPlanPart = z.infer<typeof AgentPlanPart>;

/** A snapshot of the plan from the backend's native plan tools: Codex's
 *  `update_plan` (whole-list replace) and Claude's task tools (create/update by
 *  id, accumulated in the provider). Every event carries the WHOLE plan, so a
 *  consumer renders the newest one. */
export const AgentPlanUpdated = z.object({
  type: z.literal("agent.plan.updated"),
  threadId: z.string(),
  provider: z.enum(["codex", "claude"]),
  parts: z.array(AgentPlanPart),
});

export const ToolStarted = z.object({
  type: z.literal("tool.started"),
  threadId: z.string(),
  itemId: z.string(),
  /** The MCP server, as the thread's `mcpServers` names it, or `builtin`. */
  server: z.string(),
  tool: z.string(),
  arguments: z.unknown(),
});

export const ToolProgress = z.object({
  type: z.literal("tool.progress"),
  threadId: z.string(),
  itemId: z.string(),
  message: z.string(),
});


export const ToolCompleted = z.object({
  type: z.literal("tool.completed"),
  threadId: z.string(),
  itemId: z.string(),
  server: z.string(),
  tool: z.string(),
  status: z.string(),
  result: z.unknown().optional(),
  error: z.unknown().optional(),
  durationMs: z.number().nullable().optional(),
  /** Set, with `status: "declined"`, when the call was refused rather than run (Claude). Only the
   *  host's own refusals (guard, `canUseTool`) are declined straight away; any other refusal is
   *  first reported as `error`, and a later `tool.completed` for the same item says `declined`
   *  once the turn's result lists it (a call listed before its tool result came back gets only
   *  that one). Declined is final: nothing turns it back into an error. */
  denial: ToolDenial.optional(),
});

/** One slice of what occupies the context window ("System prompt", "MCP
 *  tools", "Messages"). Only Claude reports a breakdown. */
export const ContextUsageCategory = z.object({
  name: z.string(),
  tokens: z.number(),
});
export type ContextUsageCategory = z.infer<typeof ContextUsageCategory>;

/**
 * The thread's context-window fill, distinct from account-scoped
 * `ProviderUsage`. `usedTokens` is what occupies the window now (it climbs
 * within a conversation and steps down after a compaction); `contextWindow` is
 * the model's total window, or null when the backend doesn't say.
 */
export const ContextUsage = z.object({
  type: z.literal("context.usage"),
  threadId: z.string(),
  turnId: z.string().optional(),
  usedTokens: z.number(),
  contextWindow: z.number().nullable(),
  breakdown: z.array(ContextUsageCategory).optional(),
});

/**
 * The backend is compacting the conversation to fit its context window, or
 * finished or failed doing so. Tokens are the context size before and after,
 * when known (Claude reports both; for Codex the provider fills `preTokens`
 * from the thread's last usage).
 */
export const ContextCompaction = z.object({
  type: z.literal("context.compaction"),
  threadId: z.string(),
  turnId: z.string().optional(),
  phase: z.enum(["started", "completed", "failed"]),
  trigger: z.enum(["auto", "manual"]).optional(),
  preTokens: z.number().optional(),
  postTokens: z.number().optional(),
  /** Why a compaction failed, in the backend's words. */
  message: z.string().optional(),
});

export const ApprovalRequested = z.object({
  type: z.literal("approval.requested"),
  request: ApprovalRequest,
});

/**
 * Provider-neutral error classes. Each backend maps its own error kinds onto these
 * (Codex `unauthorized` → `not_logged_in`, a spawn ENOENT → `binary_missing`), so
 * a caller can write one message per class.
 */
export const ERROR_CODES = [
  "binary_missing",
  "not_logged_in",
  "network",
  "timeout",
  "mcp_unavailable",
  /** The backend CLI is older than the oldest release it can run turns on. */
  "cli_outdated",
  /** The backend rejected its own config and fell back to defaults, so the
   *  turn runs without MCP servers or feature gates. Non-fatal. */
  "config_invalid",
  /** The account ran out of quota (a subscription window or credits). The
   *  message names the window and its reset when known. */
  "usage_limit",
  /** The model API is overloaded; retrying later usually works. */
  "overloaded",
  /** The conversation no longer fits the model's context window. */
  "context_full",
  /** Non-fatal: the backend answered with a different model than asked for. */
  "model_rerouted",
  /** Non-fatal: the backend announced that something in use is deprecated. */
  "deprecated",
  "turn_failed",
  "interrupted",
  "unknown",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

/** A queued message handed back unsent (see {@link ErrorRaised.returned}). */
export const ReturnedPrompt = z.object({
  submitId: z.string(),
  text: z.string(),
  images: z.array(ImageAttachment).optional(),
});
export type ReturnedPrompt = z.infer<typeof ReturnedPrompt>;

export const ErrorRaised = z.object({
  type: z.literal("error.raised"),
  message: z.string(),
  threadId: z.string().optional(),
  turnId: z.string().optional(),
  /** One of {@link ERROR_CODES}; a plain string so an unknown code from another
   *  version still parses. */
  code: z.string().optional(),
  /** Whether this error ended the turn. ABSENT MEANS FATAL. `false` marks a
   *  warning: the turn stays open. */
  fatal: z.boolean().optional(),
  /** Raw provider error payload, if any. */
  raw: z.unknown().optional(),
  /** Set by a host when a restart cut this turn short and it can continue. */
  resumable: z.boolean().optional(),
  /** Messages queued behind this turn when it died, handed back unsent. */
  returned: z.array(ReturnedPrompt).optional(),
});

/** Messages a host hands back unsent with no failed turn to carry them. */
export const PromptsReturned = z.object({
  type: z.literal("prompts.returned"),
  threadId: z.string(),
  returned: z.array(ReturnedPrompt),
});

/** The event union. */
export const AgentEvent = z.discriminatedUnion("type", [
  ThreadStarted,
  TurnStarted,
  TurnSteered,
  TurnSteerRead,
  TurnCompleted,
  AgentMessageDelta,
  AgentMessageCompleted,
  AgentReasoningDelta,
  AgentReasoningCompleted,
  AgentPlanUpdated,
  AgentSubagentUpdated,
  ToolStarted,
  ToolProgress,
  ToolCompleted,
  ContextUsage,
  ContextCompaction,
  ApprovalRequested,
  ErrorRaised,
  PromptsReturned,
]);
export type AgentEvent = z.infer<typeof AgentEvent>;

/** Discriminant string literals, handy for switch exhaustiveness. */
export type AgentEventType = AgentEvent["type"];

/**
 * A tool call's arguments while the model is still writing them. Transient:
 * the `tool.started` that follows carries the whole input and supersedes it,
 * so a host forwards it live and never stores it. Only the Claude backend
 * streams input, and only for the tools named in its `streamedInputTools`
 * option; Codex reports arguments once they are complete.
 */
export const ToolInputDelta = z.object({
  type: z.literal("tool.input.delta"),
  threadId: z.string(),
  turnId: z.string(),
  /** The tool call id: the `itemId` of the `tool.started` that will follow. */
  itemId: z.string(),
  tool: z.string(),
  /** Where `delta` starts in the call's input text. */
  offset: z.number().int().nonnegative(),
  delta: z.string(),
});
export type ToolInputDelta = z.infer<typeof ToolInputDelta>;

/** What a provider's turn stream yields: durable events plus transient input
 *  deltas. */
export const TurnStreamEvent = z.union([AgentEvent, ToolInputDelta]);
export type TurnStreamEvent = AgentEvent | ToolInputDelta;
