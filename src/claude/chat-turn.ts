/**
 * The two halves of a Claude chat turn that `ClaudeAgentProvider.sendTurn`
 * wires together: the SDK options the turn runs under (the isolation, and for a
 * workspace thread its sandbox), and the background producer that reads the
 * SDK's messages into the turn's event queue.
 */

import type { McpServerConfig, TurnStreamEvent } from "../types/index.ts";
import type {
  EffortLevel,
  McpServerConfig as SdkMcpServerConfig,
  Options,
  Query,
  SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";

import { errorMessage, toError, type TurnOutput, type TurnQueue } from "../shared.ts";
import type { Redactor } from "./redact.ts";
import { mapMessage, type TurnScope } from "./events.ts";
import type { SubagentRole } from "../subagents.ts";
import { SUBAGENT_TOOL, subagentTurnOptions } from "./subagents.ts";
import type { PlanState } from "./plan.ts";
import { workspaceEnv, workspaceSandbox, workspaceToolNames, type WorkspaceState } from "./workspace.ts";
import { executableOption, ISOLATED_SETTINGS, SANDBOX_OFF } from "./sdk.ts";
import { ASK_USER, BUILTIN_TOOL_NAMES, CLAUDE_TOOL_NAME_NOTE } from "./tools.ts";
import { closeTurnInput } from "./turn.ts";
import { CLAUDE_WEB_TOOLS } from "../web-search.ts";
import { pickContextWindow, readContextUsage } from "./usage.ts";

/** Per-thread state the SDK doesn't persist for us across turns/process restarts. */
export interface ThreadState extends PlanState {
  cwd: string;
  systemPrompt: string | undefined;
  /** True until the first turn creates the SDK session (then we `resume` it). */
  fresh: boolean;
  /** Cold (the process restarted) and not yet checked: the session the thread points at may never
   *  have been saved, if the CLI was killed early in its first turn. Checked once before the next
   *  turn. */
  unverified?: boolean;
  /** The SDK session this thread now points at, when it diverged from the
   *  thread id: an edit/rewind forks the transcript at the boundary and the fork
   *  is a NEW session. The external thread id never changes; every SDK call goes
   *  through `ClaudeAgentProvider.sdkSessionId` instead. */
  sessionAlias?: string;
  /** Set on a cold resume: the in-memory plan accumulator is gone while the CLI
   *  session still holds the tasks, so the next turn asks the agent to re-read
   *  them once (see `PLAN_RESYNC_HINT`). */
  planResync?: boolean;
  /** Sticky model/effort for the thread — seeded at start, updated by per-turn
   *  overrides, so later override-less turns keep the last selection (Codex-like). */
  model?: string;
  effort?: string;
  /** The thread's MCP servers: the only ones its turns see. */
  mcpServers?: Record<string, McpServerConfig>;
  /** The thread has web search and fetch. */
  webSearch?: boolean;
  /** The thread may start subagents. */
  subagents?: boolean;
  /** The thread may ask the person questions (AskUserQuestion). */
  askUser?: boolean;
  /** Set once the thread is in workspace mode (see {@link WorkspaceState}). */
  workspace?: WorkspaceState;
  /** The model's context window, from the last turn's `result`. Only a result
   *  reports it, so a turn reports its fill as it runs only once it is known. */
  contextWindow?: number | null;
}

/** What a chat turn's SDK options are built from. */
export interface ChatTurnSetup {
  state: ThreadState;
  model: string;
  effort: EffortLevel | undefined;
  /** The SDK session behind the thread: a fresh thread names it, later turns
   *  resume it. */
  sessionId: string;
  controller: AbortController;
  /** The executable to hand the SDK (see `sdkExecutablePath`). */
  executablePath: string | undefined;
  supportsSteer: boolean;
  mcpServers: Record<string, SdkMcpServerConfig>;
  /** Masks the turn's MCP credentials in what the turn logs (see redact.ts). */
  redactor: Redactor;
  canUseTool: NonNullable<Options["canUseTool"]>;
  onElicitation: NonNullable<Options["onElicitation"]>;
  hooks: NonNullable<Options["hooks"]>;
  /** The subagent role, on a turn that may start subagents; absent otherwise. */
  subagents?: SubagentRole;
  /** The turn may search the web. Never set on a workspace thread. */
  webSearch?: boolean;
  /** The turn may ask the person questions (AskUserQuestion). */
  askUser?: boolean;
  /** A JSON schema the turn's answer must match (structured output). */
  outputSchema?: Record<string, unknown>;
  /** The turn's permission mode (TurnInput.permissionMode); "default" when absent. */
  permissionMode?: "default" | "auto";
}

/** The SDK options of one chat turn. */
export function chatTurnOptions(setup: ChatTurnSetup): Options {
  const { state } = setup;
  return {
    model: setup.model,
    ...(setup.effort ? { effort: setup.effort } : {}),
    // Adaptive reasoning with a summarized thinking display: Claude returns a
    // human-readable summary of its reasoning, which the assistant-message
    // handler normalizes into the same provider-neutral work-summary rows Codex
    // produces (so both backends drive the collapsible Work summary in chat).
    // The signed thinking block is still preserved for continuity.
    thinking: { type: "adaptive", display: "summarized" },
    // Stream the raw Anthropic content-block deltas (`stream_event` messages)
    // so the transcript types out an answer as it is written, the way Codex's
    // `item/agentMessage/delta` does. The assembled assistant message still
    // arrives after them and stays authoritative (see {@link mapMessage}).
    includePartialMessages: true,
    // The CLI echoes each message it reads from the prompt as an `isReplay`
    // user message. A steer's echo comes when the CLI folds it into the
    // conversation, not when it is pushed, so it is the steer's read receipt
    // (see `reportsSteerRead`). Other echoes carry no tool results and map to
    // nothing.
    ...(setup.supportsSteer ? { extraArgs: { "replay-user-messages": null } } : {}),
    cwd: state.cwd,
    abortController: setup.controller,
    ...executableOption(setup.executablePath),
    // Isolation (see the `claude-provider.ts` header). A workspace thread adds
    // the file tools and a sandboxed shell; everything else about the
    // isolation stays.
    settingSources: [],
    settings: ISOLATED_SETTINGS,
    strictMcpConfig: true,
    skills: [],
    plugins: [],
    tools: state.workspace
      ? [
          ...BUILTIN_TOOL_NAMES,
          ...workspaceToolNames(state.workspace),
          ...(setup.webSearch ? CLAUDE_WEB_TOOLS : []),
          ...(setup.askUser ? [ASK_USER] : []),
        ]
      : [
          ...BUILTIN_TOOL_NAMES,
          ...(setup.subagents ? [SUBAGENT_TOOL] : []),
          ...(setup.webSearch ? CLAUDE_WEB_TOOLS : []),
          ...(setup.askUser ? [ASK_USER] : []),
        ],
    // The sandbox only ever confines Bash. Without a shell there is nothing to confine, and
    // requiring it would fail every turn on a machine without its dependencies (bubblewrap, socat).
    ...(state.workspace
      ? {
          sandbox: state.workspace.shell === false ? SANDBOX_OFF : workspaceSandbox(state.workspace),
          env: workspaceEnv(state.workspace.cacheDir),
        }
      : {}),
    ...(setup.subagents ? subagentTurnOptions(setup.subagents) : {}),
    // Always explicit: left out, the CLI starts in `auto` wherever that is its
    // default, and its classifier would then approve calls the host must see.
    // "auto" only when the host asked for it, turn by turn.
    permissionMode: setup.permissionMode === "auto" ? "auto" : "default",
    // `snapshot` records the rendered prompt once in the session transcript and
    // replays it verbatim on every later request, including cold resumes. A
    // prompt that re-renders differently between two launches (a CLI upgrade, a
    // host's instructions edit) would both bust the cache prefix and discard
    // the model's earlier thinking blocks. The trade: an instructions edit
    // reaches new threads at once and existing ones only at their next
    // compaction. Inert where the feature isn't enabled for the account yet.
    ...(state.systemPrompt
      ? {
          systemPrompt: {
            type: "custom" as const,
            prompt: Object.keys(setup.mcpServers).length
              ? `${state.systemPrompt}\n\n${CLAUDE_TOOL_NAME_NOTE}`
              : state.systemPrompt,
            snapshot: true,
          },
        }
      : {}),
    ...(setup.outputSchema ? { outputFormat: { type: "json_schema" as const, schema: setup.outputSchema } } : {}),
    mcpServers: setup.mcpServers,
    // Surface CLI diagnostics to the server log — MCP spawn/protocol failures
    // (the #1 reason the agent silently falls back to fabricating tool calls),
    // but also auth/network complaints, so the label stays neutral.
    stderr: (data) => setup.redactor.write(data),
    // Bind the session id on the first turn; resume it after.
    ...(state.fresh ? { sessionId: setup.sessionId } : { resume: setup.sessionId }),
    // Every tool call routes through here so the orchestrator owns the gate.
    canUseTool: setup.canUseTool,
    // MCP elicitations (a tool's question for a person) bridge into the same
    // `approval.requested` round-trip as tool permissions, so an elicitation
    // always reaches the host, never auto-accepts.
    onElicitation: setup.onElicitation,
    // The CLI's own task lifecycle, straight from the source: `TaskCreated` /
    // `TaskCompleted` carry the structural task id and subject, so the plan
    // accumulator no longer depends on reading them out of the tool's
    // confirmation prose (see `planHooks`). The prose parsers stay for what no
    // hook reports: in-progress and deleted transitions, a renamed subject, the
    // `activeForm` label, and the whole-list `TaskList` resync after a cold
    // resume. A workspace thread adds its `PreToolUse` hook (see `workspaceHooks`).
    hooks: setup.hooks,
  };
}

/** What a chat turn's background producer reads and writes. */
export interface TurnPump {
  q: Query;
  state: ThreadState;
  scope: TurnScope;
  /** The turn's model, for the context window when the SDK can't say. */
  model: string;
  controller: AbortController;
  turn: TurnQueue<TurnStreamEvent>;
  output: TurnOutput;
  /** Whether the turn already has its terminal event. */
  isSettled: () => boolean;
  /** The turn's redactor: stderr's last line is flushed through it when the turn ends. */
  redactor: Redactor;
}

/** Background producer: translate SDK messages into domain events. */
export async function pumpTurn(pump: TurnPump): Promise<void> {
  const { q, state, scope, model, controller, turn, output, isSettled, redactor } = pump;
  const { threadId, turnId, live, push } = scope;
  let sawResult = false;
  // Track the context-window fill. Each main-thread assistant message carries
  // the usage of the request that produced it; the LAST one is the
  // conversation's current size (the cumulative `usage` on the `result`
  // message sums every request in the turn, so it would massively overcount
  // on a tool-heavy turn — we deliberately don't use it here). A subagent's
  // messages measure its own context, not this one.
  let usedTokens = 0;
  try {
    for await (const msg of q) {
      // The first message proves the CLI booted and bound our thread id to a
      // real SDK session — only then is `resume` valid for later turns. A turn
      // that dies before it (binary missing, logged out) leaves the thread
      // `fresh`, so a retry creates the session instead of resuming one that
      // never existed (which would fail forever).
      state.fresh = false;
      const m = msg as SDKMessage;
      if (m.type === "assistant" && !m.parent_tool_use_id) {
        const u = m.message?.usage;
        if (u) {
          const next =
            (u.input_tokens ?? 0) +
            (u.cache_read_input_tokens ?? 0) +
            (u.cache_creation_input_tokens ?? 0) +
            (u.output_tokens ?? 0);
          // Report the fill as the turn runs, once a past result has told us
          // the window. One request's content blocks arrive as separate
          // messages with the same usage, so only a change is reported.
          if (next !== usedTokens && state.contextWindow) {
            push({ type: "context.usage", threadId, turnId, usedTokens: next, contextWindow: state.contextWindow });
          }
          usedTokens = next;
        }
      }
      // A compaction shrank the context: the size the turn reports at its end
      // is the compacted one, until the next request says otherwise.
      if (m.type === "system" && m.subtype === "compact_boundary" && m.compact_metadata.post_tokens != null) {
        usedTokens = m.compact_metadata.post_tokens;
      }
      if (m.type === "result") {
        sawResult = true;
        // This result may be the turn's last. No steer may land until
        // `mapMessage` has judged it, or it could be pushed onto a turn that
        // is about to close.
        live.accepting = false;
        // Emit context fill BEFORE mapMessage pushes `turn.completed`, so a
        // consumer has the final `context.usage` when the turn settles. Prefer the SDK's
        // `getContextUsage()` (the data behind `/context`): it gives the
        // authoritative total + window AND a per-category breakdown. It's a
        // live control call on the still-open session, so we bound it with a
        // short timeout and fall back to the message-derived numbers
        // (`modelUsage`, only on the result message) if it's slow or absent.
        const ctx = await readContextUsage(q);
        const contextWindow =
          ctx?.contextWindow ??
          pickContextWindow(
            (m as { modelUsage?: Record<string, { contextWindow: number }> }).modelUsage,
            model,
          );
        if (contextWindow) state.contextWindow = contextWindow;
        push({
          type: "context.usage",
          threadId,
          turnId,
          usedTokens: ctx?.usedTokens ?? usedTokens,
          contextWindow,
          ...(ctx?.breakdown && ctx.breakdown.length ? { breakdown: ctx.breakdown } : {}),
        });
      }
      mapMessage(m, scope);
    }
    if (!sawResult) {
      if (controller.signal.aborted) {
        // Interrupt/timeout: the CLI closed the stream without a result. Settle
        // the turn (the timeout's own failure, if any, still surfaces below).
        push({ type: "turn.completed", threadId, turnId });
      } else {
        // The session ended on its own with no result message — the turn has no
        // answer, so it must not read as a clean completion. When the turn did
        // warn on the way (a retry storm, a refusal), that warning is the
        // informative sentence; promote it rather than adding a generic one.
        push(
          output.promoted() ?? {
            type: "error.raised",
            threadId,
            turnId,
            code: "unknown",
            fatal: true,
            message:
              "The Claude Code session ended before the turn produced an answer. Re-run to continue.",
          },
        );
      }
    } else if (!isSettled()) {
      // The last result left a steer unanswered and the CLI ended anyway (a
      // Stop landed first): nothing more is coming, so the turn is over.
      push({ type: "turn.completed", threadId, turnId });
    }
  } catch (err) {
    if (isSettled()) {
      // The turn is already terminated by an event we emitted. The SDK's
      // rejection is the SAME failure worded again (it replaces the child's
      // exit error with the `result` text) — rethrowing it would make the
      // orchestrator persist a second `error.raised` for one failure. Log it;
      // never duplicate it.
      console.warn(
        `[muxi-agent:claude] turn ${turnId} already settled; ignoring trailing stream error: ${redactor.text(errorMessage(err))}`,
      );
    } else if (controller.signal.aborted && !turn.failure) {
      // Graceful interrupt (or timeout already recorded a failure): close the
      // turn so the orchestrator flips the thread back to idle.
      push({ type: "turn.completed", threadId, turnId });
    } else if (!turn.failure) {
      turn.failure = toError(err);
    }
  } finally {
    if (scope.parkTimer) clearTimeout(scope.parkTimer);
    closeTurnInput(live);
    redactor.flush();
    turn.end();
  }
}
