/**
 * Claude's SDK messages mapped onto the package's events: streamed deltas,
 * assistant blocks, tool calls and results, plan snapshots, compaction,
 * retries, refusals, rate limits, and the result that ends a turn. Content
 * reaches the stream exactly as Codex's does, so both backends fold the same.
 */

import type { AgentEvent, ToolDenial, ToolInputDelta } from "../types/index.ts";
import { normalizeWorkSummary, WEB_SEARCH_TOOL } from "../types/index.ts";
import type { SDKMessage, SDKRateLimitInfo } from "@anthropic-ai/claude-agent-sdk";

import { epochToDate } from "../shared.ts";
import { claudeWindowLabel, usageLimitMessage } from "../usage-limit.ts";
import { claudeResultOutcome, isRateLimitBlocked, refusalMessage, retryMessage } from "./failures.ts";
import {
  finishSubagentFromResult,
  subagentFrameOwner,
  SUBAGENT_TOOLS,
  isSubagentTaskMessage,
  mapSubagentFrame,
  mapSubagentTask,
} from "./subagents.ts";
import { applyPlanResult, type PlanState } from "./plan.ts";
import { parseToolName, PLAN_TOOLS, toContentBlocks, TOOL_SEARCH } from "./tools.ts";
import { closeTurnInput, consumedPrompts, type LiveTurn } from "./turn.ts";
import { CLAUDE_WEB_SEARCH, claudeWebSearchResult } from "../web-search.ts";

/** One in-flight tool call, keyed by tool_use id, so the matching tool_result can
 *  name the call and report its wall-clock duration. `input` is retained only for
 *  the plan tools, whose results are prose that never echoes the call's arguments
 *  (subject/activeForm live in the input alone), and for a web search, whose
 *  result names its query only in its structured half. */
interface ToolCallRecord {
  server: string;
  tool: string;
  startedAt: number;
  input?: unknown;
}

/** One turn's state, as {@link mapMessage} reads and writes it. */
export interface TurnScope {
  threadId: string;
  turnId: string;
  /** tool_use id → the call it names (see `sendTurn`). */
  toolNames: Map<string, ToolCallRecord>;
  push: (ev: AgentEvent) => void;
  /** Queue a transient input delta (never persisted, never terminal). */
  pushInput: (ev: ToolInputDelta) => void;
  /** Content-block index → the streamed-input tool call it holds, for the
   *  current model message (see {@link streamedInputTools}). */
  inputBlocks: Map<number, { itemId: string; tool: string; offset: number }>;
  /** The tools whose input streams as `tool.input.delta` (the provider's
   *  `streamedInputTools` option). Every other call stays silent until
   *  `tool.started`. */
  streamedInputTools: ReadonlySet<string>;
  /** The MCP servers the thread was given, which must all connect. */
  mcpServers: readonly string[];
  /** The `error` on the last top-level assistant message; a later one without
   *  it clears this. */
  assistantError: string | null;
  /** Rejected rate-limit windows already warned about, keyed
   *  `${rateLimitType}:${resetsAt}`. */
  rateLimitWarned: Set<string>;
  /** The sentence of the last rejected rate limit, for the result to reuse. */
  usageLimitMessage: string | null;
  /** Armed by a rejected rate limit and cleared by any later message. If it
   *  fires, the CLI went quiet on a limit that won't lift mid-turn, so the turn
   *  ends rather than waiting out the turn timeout. */
  parkTimer: ReturnType<typeof setTimeout> | null;
  /** Stop the CLI's turn: close its input, interrupt, then abort. */
  stop: () => void;
  /** A compaction started and has not yet finished or failed. */
  compacting: boolean;
  /** The turn's registration, whose prompt bookkeeping decides which result
   *  ends it. */
  live: LiveTurn;
  /** Whether a mid-turn message folds into the turn (the provider's
   *  `supportsSteer`). */
  supportsSteer: boolean;
  /** How long a rejected rate limit may park the turn (see {@link onRateLimit}). */
  rateLimitParkMs: number;
  /** The thread's plan accumulator, which a plan tool's result folds into. */
  plan: () => PlanState;
  /** The refusals the host's side made itself, by tool_use_id (the guard and canUseTool). They
   *  are known for certain, so a call they name is declined as soon as its result arrives. */
  denials: Map<string, ToolDenial>;
  /** The CLI's `permission_denied` messages, by tool_use_id. Advisory: the SDK may send one for
   *  a call its result doesn't list as refused, so it names who refused a call only once the
   *  result's `permission_denials` lists it. */
  advisories: Map<string, ToolDenial>;
  /** Every call this turn drew as a row (`tool.started`), by tool_use_id, with how it was
   *  reported so far, so the result's `permission_denials` can decline it: one reported as a
   *  plain `error`, or one whose result never came back. */
  calls: Map<string, { server: string; tool: string; reported?: "completed" | "error" | "declined" }>;
}

/** The CLI's `decision_reason_type` as a denial's `by`. */
function deniedBy(type: string | undefined): ToolDenial["by"] {
  if (type === "classifier") return "classifier";
  if (type === "rule") return "rule";
  if (type === "mode") return "mode";
  if (type === "hook") return "guard";
  return "other";
}

/**
 * The result's `permission_denials`, the CLI's record of the calls it refused, settles who
 * refused each: the host's side if it did, else the CLI's advisory, else "other". A rail call
 * reported as a plain error, or whose result never came back, is declined now (a second
 * `tool.completed`, or its only one); a subagent's call gets the denial on its row. A call
 * already declined, or one that completed, is left alone.
 */
function reconcileDenials(msg: SDKMessage, scope: TurnScope): void {
  const listed = (msg as { permission_denials?: { tool_use_id?: string }[] }).permission_denials ?? [];
  for (const { tool_use_id: id } of listed) {
    if (!id) continue;
    const denial = scope.denials.get(id) ?? scope.advisories.get(id) ?? { by: "other" as const };
    const subagents = scope.live.subagents;
    const owner = subagents?.owners.get(id);
    if (owner && subagents) {
      subagents.tracker.declineCall(owner, id, denial);
      continue;
    }
    const call = scope.calls.get(id);
    if (!call || call.reported === "declined" || call.reported === "completed") continue;
    call.reported = "declined";
    const startedAt = scope.toolNames.get(id)?.startedAt;
    scope.push({
      type: "tool.completed",
      threadId: scope.threadId,
      itemId: id,
      server: call.server,
      tool: call.tool,
      status: "declined",
      denial,
      ...(startedAt != null ? { durationMs: Date.now() - startedAt } : {}),
    });
  }
}

/**
 * A rejected rate limit: warn once per window, then park. The CLI usually
 * ends the turn with an error result right after, which clears the park and
 * becomes the terminal. If it goes quiet instead, the park ends the turn as a
 * usage-limit stop and stops the CLI.
 */
function onRateLimit(info: SDKRateLimitInfo, scope: TurnScope): void {
  if (!isRateLimitBlocked(info)) return;
  const message = usageLimitMessage("Claude Code", {
    label: claudeWindowLabel(info.rateLimitType),
    resetsAt: info.resetsAt ? epochToDate(info.resetsAt) : null,
  });
  scope.usageLimitMessage = message;
  const key = `${info.rateLimitType ?? ""}:${info.resetsAt ?? ""}`;
  const base = {
    type: "error.raised" as const,
    threadId: scope.threadId,
    turnId: scope.turnId,
    code: "usage_limit",
    message,
    raw: info,
  };
  if (!scope.rateLimitWarned.has(key)) {
    scope.rateLimitWarned.add(key);
    scope.push({ ...base, fatal: false });
  }
  if (scope.parkTimer) return;
  scope.parkTimer = setTimeout(() => {
    scope.parkTimer = null;
    scope.push({ ...base, fatal: true });
    scope.stop();
  }, scope.rateLimitParkMs);
}

/** Translate one SDK message into zero or more domain events. */
export function mapMessage(msg: SDKMessage, scope: TurnScope): void {
  const { threadId, turnId, toolNames, push } = scope;
  // The CLI is still talking, so a rejected rate limit did not strand the turn.
  if (msg.type !== "rate_limit_event" && scope.parkTimer) {
    clearTimeout(scope.parkTimer);
    scope.parkTimer = null;
  }

  if (msg.type === "rate_limit_event") {
    onRateLimit(msg.rate_limit_info, scope);
    return;
  }

  if (msg.type === "stream_event") {
    // Partial frames only exist because `includePartialMessages` is on. They
    // carry ONE Anthropic Messages-API streaming event; the two content-block
    // deltas a UI renders become the same provider-neutral delta events Codex
    // emits (threadId + text only, no item id — the fold appends them to the
    // trailing item and the matching `*.completed` then supersedes it).
    //
    // A subagent's frames name the spawning tool call in `parent_tool_use_id`;
    // they belong to a nested transcript, never to this turn's answer.
    if (msg.parent_tool_use_id != null) return;
    const event = msg.event as {
      type?: string;
      index?: number;
      delta?: Record<string, unknown>;
      content_block?: Record<string, unknown>;
    };
    // A streamed-input tool call's arguments, chunk by chunk, so its card can
    // fill in while the model writes it. Keyed by block index, which restarts
    // with every model message.
    if (event?.type === "message_start") {
      scope.inputBlocks.clear();
      return;
    }
    if (event?.type === "content_block_start") {
      const block = event.content_block;
      if (block?.type === "tool_use" && typeof block.id === "string" && typeof event.index === "number") {
        const { tool } = parseToolName(String(block.name ?? ""));
        if (scope.streamedInputTools.has(tool)) scope.inputBlocks.set(event.index, { itemId: block.id, tool, offset: 0 });
      }
      return;
    }
    if (event?.type === "content_block_stop") {
      if (typeof event.index === "number") scope.inputBlocks.delete(event.index);
      return;
    }
    if (event?.type !== "content_block_delta") return;
    const delta = event.delta;
    if (delta?.type === "input_json_delta") {
      const call = typeof event.index === "number" ? scope.inputBlocks.get(event.index) : undefined;
      const chunk = delta.partial_json;
      if (call && typeof chunk === "string" && chunk) {
        scope.pushInput({
          type: "tool.input.delta",
          threadId,
          turnId,
          itemId: call.itemId,
          tool: call.tool,
          offset: call.offset,
          delta: chunk,
        });
        call.offset += chunk.length;
      }
    } else if (delta?.type === "text_delta") {
      if (typeof delta.text === "string" && delta.text) {
        push({ type: "agent.message.delta", threadId, delta: delta.text });
      }
    } else if (delta?.type === "thinking_delta") {
      // Under `thinking.display: "summarized"` these frames stream the readable
      // summary rather than the raw trace (raw thinking is not available to the
      // SDK). Either way they are the reasoning of this turn.
      if (typeof delta.thinking === "string" && delta.thinking) {
        push({ type: "agent.reasoning.delta", threadId, delta: delta.thinking });
      }
    }
    return;
  }

  if (isSubagentTaskMessage(msg)) {
    mapSubagentTask(msg, scope.live.subagents);
    return;
  }

  // A call the CLI refused without asking (auto mode's classifier, a rule, the mode). Advisory:
  // kept aside until the result's `permission_denials`, the record, lists the call.
  if (msg.type === "system" && (msg as { subtype?: string }).subtype === "permission_denied") {
    const d = msg as unknown as { tool_use_id?: string; decision_reason_type?: string; decision_reason?: string; message?: string };
    if (d.tool_use_id && !scope.advisories.has(d.tool_use_id)) {
      const reason = d.decision_reason || d.message;
      scope.advisories.set(d.tool_use_id, { by: deniedBy(d.decision_reason_type), ...(reason ? { reason } : {}) });
    }
    return;
  }

  if (msg.type === "system" && msg.subtype === "init") {
    // A thread MCP server that didn't connect leaves the agent without its
    // tools, and it may fabricate the calls as text: make that failure loud.
    for (const name of scope.mcpServers) {
      const server = msg.mcp_servers?.find((s: { name: string; status: string }) => s.name === name);
      if (server?.status === "connected") continue;
      const status = server?.status ?? "absent";
      console.warn(`[muxi-agent:claude] MCP server ${name} not connected (status: ${status})`);
      // A warning, NOT a terminal failure: the turn keeps running, degraded.
      push({
        type: "error.raised",
        threadId,
        turnId,
        code: "mcp_unavailable",
        fatal: false,
        message: `The ${name} tools are unavailable (MCP status: ${status}).`,
        raw: msg.mcp_servers,
      });
    }
    return;
  }

  if (msg.type === "system" && msg.subtype === "status") {
    if (msg.status === "compacting" && !scope.compacting) {
      scope.compacting = true;
      push({ type: "context.compaction", threadId, turnId, phase: "started" });
    } else if (msg.compact_result === "failed") {
      scope.compacting = false;
      push({
        type: "context.compaction",
        threadId,
        turnId,
        phase: "failed",
        ...(msg.compact_error ? { message: msg.compact_error } : {}),
      });
    }
    return;
  }

  if (msg.type === "system" && msg.subtype === "compact_boundary") {
    scope.compacting = false;
    const meta = msg.compact_metadata;
    push({
      type: "context.compaction",
      threadId,
      turnId,
      phase: "completed",
      trigger: meta.trigger,
      preTokens: meta.pre_tokens,
      ...(meta.post_tokens != null ? { postTokens: meta.post_tokens } : {}),
    });
    return;
  }

  if (msg.type === "system" && msg.subtype === "api_retry") {
    // The CLI is walking its retry ladder against a transient API failure. Codex
    // surfaces the same blips as `willRetry` warnings (non-fatal `network`); say
    // so here too, or a retry storm reads as the agent going silent. When the
    // ladder runs out with nothing produced, `sendTurn` promotes the last of
    // these to the turn's stated failure, the same rule Codex applies.
    push({
      type: "error.raised",
      threadId,
      turnId,
      code: "network",
      fatal: false,
      message: retryMessage(msg),
      raw: msg,
    });
    return;
  }

  if (
    msg.type === "system" &&
    (msg.subtype === "model_refusal_fallback" || msg.subtype === "model_refusal_no_fallback")
  ) {
    // The model ended the stream with stop_reason "refusal". With a fallback the
    // turn is retried on another model and the refused partial is RETRACTED; the
    // event contract has no retraction (an emitted `agent.message.completed` is
    // final), so the warning names what was withdrawn instead. Without a fallback
    // the refusal ends the turn, and the `result` message that follows carries the
    // terminal error, so this stays non-fatal either way, and becomes the turn's
    // stated failure only if nothing else arrives.
    push({
      type: "error.raised",
      threadId,
      turnId,
      code: "unknown",
      fatal: false,
      message: refusalMessage(msg),
      raw: msg,
    });
    return;
  }

  if (msg.type === "assistant") {
    // A subagent's frames feed its row, never this turn's answer, rail or API error.
    const subagentId = subagentFrameOwner(msg.parent_tool_use_id, scope.live.subagents);
    if (subagentId && scope.live.subagents) {
      mapSubagentFrame(subagentId, msg.message?.content, scope.live.subagents, scope.denials);
      return;
    }
    // A subagent's API error is its own; only the main loop's names the turn's.
    if (msg.parent_tool_use_id == null) scope.assistantError = msg.error ?? null;
    const blocks = (msg.message?.content ?? []) as unknown as Array<Record<string, unknown>>;
    blocks.forEach((block, i) => {
      const itemId = `${msg.uuid}:${i}`;
      if (block.type === "text" && typeof block.text === "string") {
        push({ type: "agent.message.completed", threadId, itemId, text: block.text });
      } else if (
        block.type === "thinking" &&
        typeof block.thinking === "string" &&
        block.thinking.trim()
      ) {
        // With `thinking.display: "summarized"` this block carries Claude's
        // readable reasoning summary. Normalize it here so every downstream
        // surface receives the same provider-neutral rows Codex produces
        // rather than Claude-specific prose.
        push({
          type: "agent.reasoning.completed",
          threadId,
          itemId,
          text: block.thinking,
          summary: normalizeWorkSummary(block.thinking),
        });
      } else if (block.type === "tool_use" && typeof block.id === "string") {
        const parsed = parseToolName(String(block.name ?? ""));
        const isPlan = parsed.server === "builtin" && PLAN_TOOLS.has(parsed.tool);
        // A web search reports under the one name both backends share.
        const isSearch = parsed.server === "builtin" && parsed.tool === CLAUDE_WEB_SEARCH;
        const { server, tool } = isSearch ? { server: parsed.server, tool: WEB_SEARCH_TOOL } : parsed;
        toolNames.set(block.id, {
          server,
          tool,
          startedAt: Date.now(),
          ...(isPlan || isSearch ? { input: block.input } : {}),
        });
        if (isPlan) {
          // A plan tool is bookkeeping: it becomes a plan snapshot, not a tool
          // row (its result is skipped below too). Nothing
          // is emitted here — the CLI mints the task id in the RESULT, and a
          // call that fails must not move the plan, so the accumulator is
          // applied there.
          return;
        }
        // Loading a deferred tool is bookkeeping too.
        if (server === "builtin" && tool === TOOL_SEARCH) return;
        // A subagent start draws as its subagent's row, from the hook that let it start.
        if (server === "builtin" && SUBAGENT_TOOLS.has(tool)) return;
        scope.calls.set(block.id, { server, tool });
        push({
          type: "tool.started",
          threadId,
          itemId: block.id,
          server,
          tool,
          arguments: block.input,
        });
      }
    });
    return;
  }

  if (msg.type === "user") {
    // The CLI's echo of a steer: the agent has it now.
    if ("isReplay" in msg && msg.isReplay) {
      const steerId = scope.live.steerIds.get(msg.uuid);
      if (steerId) {
        scope.live.steerIds.delete(msg.uuid);
        push({ type: "turn.steer.read", threadId, steerId });
      }
      return;
    }
    const subagentId = subagentFrameOwner(msg.parent_tool_use_id, scope.live.subagents);
    if (subagentId && scope.live.subagents) {
      mapSubagentFrame(subagentId, msg.message?.content, scope.live.subagents, scope.denials);
      return;
    }
    // tool_result blocks ride back on a synthetic user message.
    const content = msg.message?.content;
    const blocks = Array.isArray(content)
      ? (content as unknown as Array<Record<string, unknown>>)
      : [];
    for (const block of blocks) {
      if (block.type !== "tool_result" || typeof block.tool_use_id !== "string") continue;
      const named = toolNames.get(block.tool_use_id);
      // Built-in check mirrors the tool_use branch: a hypothetical MCP tool
      // that happens to be named TaskCreate must stay an ordinary rail row.
      if (named?.server === "builtin" && PLAN_TOOLS.has(named.tool)) {
        // An errored plan call must not move the plan: its prose ("Task #N
        // could not be …") can still look like a confirmation to the parsers.
        if (block.is_error !== true) {
          const parts = applyPlanResult(scope.plan(), named.tool, named.input, block.content);
          if (parts) push({ type: "agent.plan.updated", threadId, provider: "claude", parts });
        }
        continue;
      }
      if (named?.server === "builtin" && named.tool === TOOL_SEARCH) continue;
      if (named?.server === "builtin" && SUBAGENT_TOOLS.has(named.tool)) {
        finishSubagentFromResult(scope.live.subagents, block.tool_use_id, block.content, block.is_error === true);
        continue;
      }
      const isError = block.is_error === true;
      const call = scope.calls.get(block.tool_use_id);
      // The result already declined it; that stands.
      if (call?.reported === "declined") continue;
      if (named?.server === "builtin" && named.tool === WEB_SEARCH_TOOL && !isError) {
        // The CLI's structured result belongs to the message's one tool result.
        const structured = blocks.length === 1 && "tool_use_result" in msg ? msg.tool_use_result : undefined;
        const text = toContentBlocks(block.content)
          .map((b) => b.text)
          .join("\n");
        if (call) call.reported = "completed";
        push({
          type: "tool.completed",
          threadId,
          itemId: block.tool_use_id,
          server: named.server,
          tool: named.tool,
          status: "completed",
          durationMs: Date.now() - named.startedAt,
          result: claudeWebSearchResult(named.input, structured, text),
        });
        continue;
      }
      // Only a refusal the host's side made is declined here. One the CLI only advised of stays an
      // error until the result lists it (see below), so a host is never told "declined" wrongly.
      const denial = isError ? scope.denials.get(block.tool_use_id) : undefined;
      const status = denial ? "declined" : isError ? "error" : "completed";
      if (call) call.reported = status;
      push({
        type: "tool.completed",
        threadId,
        itemId: block.tool_use_id,
        server: named?.server ?? "unknown",
        tool: named?.tool ?? "unknown",
        status,
        ...(denial ? { denial } : {}),
        // Wall-clock from the tool_use block to its result (same span as
        // Codex's native durationMs) — feeds the rail's duration label.
        ...(named ? { durationMs: Date.now() - named.startedAt } : {}),
        // Normalize to the Codex result shape `{ content: [{type:"text", text}] }`
        // so readers find the tool's text at `result.content[0].text` on both
        // backends.
        result: { content: toContentBlocks(block.content) },
        ...(isError ? { error: block.content } : {}),
      });
    }
    return;
  }

  if (msg.type === "result") {
    reconcileDenials(msg, scope);
    const outcome = claudeResultOutcome(msg, {
      assistantError: scope.assistantError,
      usageLimitMessage: scope.usageLimitMessage,
    });
    // One result per prompt the CLI takes up on its own: a steer that arrived
    // after the last tool round gets a result of its own, inside this turn.
    const { live } = scope;
    for (const uuid of consumedPrompts(msg, live.pushed)) live.pushed.delete(uuid);
    // A subagent still running (one the CLI moved to the background) reports
    // into this turn, so the turn waits for it.
    const unanswered =
      live.pushed.size > 0 ||
      (msg.queued_turn_count ?? 0) > 0 ||
      (live.subagents?.tracker.liveIds().length ?? 0) > 0;
    if (outcome.kind === "completed" && unanswered) {
      live.accepting = scope.supportsSteer && !live.input.isClosed;
      return;
    }
    closeTurnInput(live);
    // The CLI still runs a steer it holds after its input closes, and that
    // run would stream into a turn that has already failed.
    if (outcome.kind === "failed" && unanswered) scope.stop();
    if (outcome.kind === "failed") {
      // The fatal error IS this turn's terminal event (contract: absent `fatal`
      // means fatal). Following it with `turn.completed` would settle the turn
      // twice — and a terminal event arriving after the turn closed is what
      // opens a stray bubble in the transcript.
      push({
        type: "error.raised",
        threadId,
        turnId,
        code: outcome.code,
        fatal: true,
        message: outcome.message,
        raw: msg,
      });
      return;
    }
    // A turn run with an output schema answers through structured output; it
    // becomes the turn's last message, as JSON, which is where a Codex turn's
    // schema-shaped answer lands too.
    const structured = (msg as { structured_output?: unknown }).structured_output;
    if (structured !== undefined) {
      push({
        type: "agent.message.completed",
        threadId,
        itemId: `${msg.uuid}:structured`,
        text: JSON.stringify(structured),
      });
    }
    push({ type: "turn.completed", threadId, turnId });
  }
}
