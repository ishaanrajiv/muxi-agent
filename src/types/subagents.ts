/**
 * Subagents: read-only helpers the agent starts inside one turn to work the
 * independent slices of a question at the same time. Each provider runs its
 * own (Claude's `Agent` tool, Codex's `spawn_agent`); the caller names the role
 * and its instructions, this package holds the limits, and every subagent's
 * state streams with the turn that started it.
 */

import { z } from "zod";

import { ToolDenial } from "./denial.ts";

/** Subagents running at once in one thread. */
export const SUBAGENT_MAX_LIVE = 3;
/** Subagents one turn may start. A later start is refused (Claude) or stopped as
 *  soon as it appears (Codex, whose spawns can't be refused). */
export const SUBAGENT_MAX_PER_TURN = 6;

export const SubagentStatus = z.enum(["running", "completed", "failed", "stopped"]);
export type SubagentStatus = z.infer<typeof SubagentStatus>;

/** One MCP tool call a subagent made, oldest first. */
export const SubagentCall = z.object({
  id: z.string(),
  tool: z.string(),
  status: z.enum(["running", "completed", "failed"]),
  /** Set on a `failed` call that was refused rather than run (Claude), by the same rules as
   *  `tool.completed.denial`: the host's own refusals at once, the CLI's once the turn's result
   *  lists the call, which may be after the subagent finished. */
  denial: ToolDenial.optional(),
});
export type SubagentCall = z.infer<typeof SubagentCall>;

/** At most this many calls ride on a subagent's state; older ones drop off the
 *  front and `callCount` keeps the total. */
export const SUBAGENT_CALLS_KEPT = 30;

/** The whole state of one subagent. Every event carries all of it, so a consumer
 *  keeps the newest event per `subagentId` and drops the rest. */
export const AgentSubagentUpdated = z.object({
  type: z.literal("agent.subagent.updated"),
  threadId: z.string(),
  subagentId: z.string(),
  /** A short name for the subagent's slice ("Region"). */
  name: z.string(),
  /** The brief the main agent gave it. */
  brief: z.string(),
  status: SubagentStatus,
  /** What it is doing now, in the present tense, when the provider says
   *  (Claude's progress summaries). */
  action: z.string().optional(),
  calls: z.array(SubagentCall),
  /** Every call it made, including the ones dropped from `calls`. */
  callCount: z.number().int().nonnegative(),
  /** Its report to the main agent, once it finished. */
  report: z.string().optional(),
  /** Why it failed or was stopped, in words fit to show a person. */
  error: z.string().optional(),
});
export type AgentSubagentUpdated = z.infer<typeof AgentSubagentUpdated>;

/** Which subagent raised an approval. */
export const SubagentRef = z.object({ id: z.string(), name: z.string() });
export type SubagentRef = z.infer<typeof SubagentRef>;
