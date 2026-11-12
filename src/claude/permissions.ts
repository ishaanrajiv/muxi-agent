/**
 * Claude's approvals, bridged into the same `approval.requested` +
 * `resolveApproval` round-trip the Codex provider speaks: tool permissions from
 * the SDK's `canUseTool`, MCP elicitations (a tool's question for a person),
 * and a workspace thread's native tool calls, whose hard refusals also run as a
 * `PreToolUse` hook.
 */

import { randomUUID } from "node:crypto";

import type { AgentEvent, ApprovalDecision, ApprovalKind, SubagentRef, ToolDenial } from "../types/index.ts";
import type {
  ElicitationRequest,
  ElicitationResult,
  HookInput,
  Options,
  PermissionResult,
} from "@anthropic-ai/claude-agent-sdk";

import { questionEnvelopeSummary } from "../normalize.ts";
import type { ToolGuard } from "../provider.ts";
import { guardReason } from "./hooks.ts";
import { decideSubagentLaunch, SUBAGENT_TOOLS, subagentRefOf, type TurnSubagents } from "./subagents.ts";
import { nativeToolApproval, type WorkspaceState } from "./workspace.ts";
import { ASK_USER, parseToolName, PLAN_TOOLS, STRUCTURED_OUTPUT, TOOL_SEARCH } from "./tools.ts";
import { CLAUDE_WEB_TOOLS } from "../web-search.ts";

/** The deny message when a decline carries no reason of its own. */
const DEFAULT_DENY_MESSAGE = "Denied by the approval policy";

/** A parked tool-permission request awaiting a UI decision; `settle` resolves the
 *  SDK `canUseTool` callback. */
export interface PendingApproval {
  turnId: string;
  threadId: string;
  settle: (decision: ApprovalDecision) => void;
}

/** Where a turn's approvals park and go: the provider's pending map, the turn
 *  that owns them, and its event stream. */
export interface ApprovalBridge {
  pending: Map<string, PendingApproval>;
  threadId: string;
  turnId: string;
  push: (ev: AgentEvent) => void;
  /** The host's hard refusals, checked before anything else is decided. */
  guard?: ToolGuard;
  /** The turn's refusals by tool_use_id, for `tool.completed.denial`. */
  denials?: Map<string, ToolDenial>;
}

/** Who asked: the CLI agent id when a subagent made the call (absent for the
 *  main agent), and the running turn's subagents. */
export interface ToolCaller {
  agentId?: string;
  subagents: TurnSubagents | null;
}

/** Bridge the SDK `canUseTool` callback into an `approval.requested` event.
 *  `workspace` is the thread's workspace state, when it is in workspace mode. */
export function toolPermission(
  bridge: ApprovalBridge,
  workspace: WorkspaceState | undefined,
  toolName: string,
  toolInput: Record<string, unknown>,
  toolUseId: string,
  caller: ToolCaller = { subagents: null },
): Promise<PermissionResult> {
  // The host's guard holds before anything is allowed, here as in its hook.
  if (bridge.guard) {
    const refused = guardReason(bridge.guard, {
      threadId: bridge.threadId,
      tool: toolName,
      input: toolInput,
      ...(caller.agentId != null ? { agentId: caller.agentId } : {}),
    });
    if (refused) {
      bridge.denials?.set(toolUseId, { by: "guard", reason: refused });
      return Promise.resolve({ behavior: "deny", message: refused });
    }
  }
  // The plan tools, tool search and structured output write nothing outside
  // the transcript, so they are allowed here, before the bridge. An unprefixed name is by
  // definition a built-in: an MCP tool arrives as `mcp__<s>__<t>`.
  if (PLAN_TOOLS.has(toolName) || toolName === TOOL_SEARCH || toolName === STRUCTURED_OUTPUT) {
    return Promise.resolve({ behavior: "allow", updatedInput: toolInput });
  }
  // Web search and fetch read the web and write nothing, so they run unasked,
  // as Codex's search does. A thread has them only when it started with
  // `webSearch`, and a subagent never does.
  if (CLAUDE_WEB_TOOLS.includes(toolName) && caller.agentId == null) {
    return Promise.resolve({ behavior: "allow", updatedInput: toolInput });
  }
  // A subagent start the hook already decided, asked again by the CLI.
  if (SUBAGENT_TOOLS.has(toolName)) {
    const decision = decideSubagentLaunch(caller.subagents?.tracker ?? null, toolUseId, toolInput, caller.agentId != null);
    return Promise.resolve(
      decision.allow
        ? { behavior: "allow", updatedInput: decision.input }
        : { behavior: "deny", message: decision.reason },
    );
  }
  // A question for the person: only the main agent asks one (a subagent has
  // no person to talk to), and it is answered, not approved.
  if (toolName === ASK_USER) {
    if (caller.agentId != null) {
      return Promise.resolve({ behavior: "deny", message: "A subagent can't ask the person; carry on with what you have." });
    }
    return askUser(bridge, toolInput, toolUseId);
  }
  const subagent: SubagentRef | undefined =
    caller.agentId != null ? subagentRefOf(caller.subagents, caller.agentId, toolUseId) : undefined;
  if (workspace && !toolName.startsWith("mcp__")) {
    return workspaceToolPermission(bridge, workspace, toolName, toolInput, toolUseId, subagent);
  }
  const { pending, threadId, turnId, push } = bridge;
  const { server, tool } = parseToolName(toolName);
  const approvalId = randomUUID();
  return new Promise<PermissionResult>((resolve) => {
    pending.set(approvalId, {
      turnId,
      threadId,
      settle: (decision) => resolve(permissionResultOf(decision, toolInput)),
    });
    // Shape `detail` like Codex's mcp_tool_call confirmation, so one reader
    // (`mcpToolCallOf`, `toolArgsOf`) serves both backends.
    push({
      type: "approval.requested",
      request: {
        requestId: approvalId,
        kind: "command" satisfies ApprovalKind,
        threadId,
        turnId,
        summary: `Run ${server} tool "${tool}"`,
        detail: {
          _meta: { codex_approval_kind: "mcp_tool_call", tool_params: toolInput },
          serverName: server,
          toolName: tool,
          message: `Allow the ${server} MCP server to run tool "${tool}"?`,
          toolUseId,
        },
        ...(subagent ? { subagent } : {}),
      },
    });
  });
}

/** The deny message when a person leaves a question unanswered. */
const NO_ANSWER = "The person didn't answer. Use your best judgment and carry on.";

/**
 * Claude's AskUserQuestion, as a `userInput` approval whose detail carries the
 * questions as the model wrote them (`questionsOf` reads them). An accept with
 * `content.answers` (question text → answer) allows the call with the answers
 * in `updatedInput.answers`, which is how the CLI hands them to the model; a
 * bare allow would make it report that the person didn't answer. Anything
 * else denies it with the decision's reason.
 */
function askUser(bridge: ApprovalBridge, toolInput: Record<string, unknown>, toolUseId: string): Promise<PermissionResult> {
  const { pending, threadId, turnId, push } = bridge;
  const questions = Array.isArray(toolInput.questions) ? toolInput.questions : [];
  const texts = questions
    .map((q) => (q && typeof q === "object" ? (q as { question?: unknown }).question : undefined))
    .filter((q): q is string => typeof q === "string" && q.trim() !== "");
  const approvalId = randomUUID();
  return new Promise<PermissionResult>((resolve) => {
    pending.set(approvalId, {
      turnId,
      threadId,
      settle: (decision) => {
        const content = decision.content && typeof decision.content === "object" ? (decision.content as Record<string, unknown>) : {};
        const given = content.answers && typeof content.answers === "object" && !Array.isArray(content.answers) ? (content.answers as Record<string, unknown>) : {};
        const answers: Record<string, string> = {};
        // The host keys answers by the question trimmed (`questionsOf`); the CLI
        // matches them to the question as the model wrote it.
        for (const q of texts) {
          const a = given[q.trim()] ?? given[q];
          if (typeof a === "string" && a.trim()) answers[q] = a.trim();
        }
        if ((decision.action === "accept" || decision.action === "approve_for_session") && Object.keys(answers).length) {
          resolve({ behavior: "allow", updatedInput: { ...toolInput, answers } });
        } else {
          resolve({ behavior: "deny", message: decision.reason?.trim() || NO_ANSWER });
        }
      },
    });
    const extra = texts.length - 1;
    push({
      type: "approval.requested",
      request: {
        requestId: approvalId,
        kind: "userInput" satisfies ApprovalKind,
        threadId,
        turnId,
        summary: texts.length ? `${texts[0]}${extra > 0 ? ` (+${extra} more)` : ""}` : "Agent asks a clarifying question",
        detail: { toolName: ASK_USER, questions, toolUseId },
      },
    });
  });
}

/**
 * A workspace thread's native tool call. Every one, a read inside the root
 * included, parks on an `approval.requested` for the host to decide. A
 * decline's reason becomes the deny message the model reads as the tool's
 * result.
 */
function workspaceToolPermission(
  bridge: ApprovalBridge,
  workspace: WorkspaceState,
  toolName: string,
  toolInput: Record<string, unknown>,
  toolUseId: string,
  subagent: SubagentRef | undefined,
): Promise<PermissionResult> {
  const refused = workspace.refusal(nativeToolApproval(toolName, toolInput, workspace));
  if (refused) return Promise.resolve({ behavior: "deny", message: refused });
  const { pending, threadId, turnId, push } = bridge;
  const approval = nativeToolApproval(toolName, toolInput, workspace);
  const approvalId = randomUUID();
  return new Promise<PermissionResult>((resolve) => {
    pending.set(approvalId, {
      turnId,
      threadId,
      settle: (decision) => resolve(permissionResultOf(decision, toolInput)),
    });
    push({
      type: "approval.requested",
      request: {
        requestId: approvalId,
        kind: approval.kind,
        threadId,
        turnId,
        summary: approval.summary,
        detail: { ...approval.detail, toolUseId },
        ...(subagent ? { subagent } : {}),
      },
    });
  });
}

/**
 * Bridge an MCP elicitation (a tool's question for a person) into the same
 * `approval.requested` + `resolveApproval` round-trip as tool permissions. The
 * event's `detail` mirrors Codex's `mcpServer/elicitation/request` params
 * (`serverName`/`message`/`requestedSchema`) so a host parses one shape for
 * both providers; the answer rides back in `decision.content` and becomes the
 * MCP `ElicitResult.content` the tool receives.
 */
export function elicitation(
  bridge: ApprovalBridge,
  request: ElicitationRequest,
): Promise<ElicitationResult> {
  const { pending, threadId, turnId, push } = bridge;
  const approvalId = randomUUID();
  // A question envelope carries the question text in `message`; surface it as
  // the summary so a list of approvals reads as the questions themselves.
  const summary = questionEnvelopeSummary(request.message) ?? "Agent asks a clarifying question";
  return new Promise<ElicitationResult>((resolve) => {
    pending.set(approvalId, {
      turnId,
      threadId,
      settle: (decision) => {
        if (decision.action === "accept" || decision.action === "approve_for_session") {
          // ElicitResult.content only admits MCP primitive values — drop the rest.
          const content: Record<string, string | number | boolean> = {};
          if (decision.content && typeof decision.content === "object") {
            for (const [key, value] of Object.entries(decision.content)) {
              if (
                typeof value === "string" ||
                typeof value === "number" ||
                typeof value === "boolean"
              ) {
                content[key] = value;
              }
            }
          }
          resolve({ action: "accept", content });
        } else {
          resolve({ action: decision.action === "cancel" ? "cancel" : "decline" });
        }
      },
    });
    push({
      type: "approval.requested",
      request: {
        requestId: approvalId,
        kind: "mcpElicitation" satisfies ApprovalKind,
        threadId,
        turnId,
        summary,
        detail: {
          serverName: request.serverName,
          message: request.message,
          ...(request.requestedSchema ? { requestedSchema: request.requestedSchema } : {}),
        },
      },
    });
  });
}

/**
 * A workspace thread's `PreToolUse` hook. Hooks run before the CLI's own
 * permission logic, so the hard refusals hold however the CLI would decide a
 * call. Every call the refusals pass is sent on to `canUseTool`, and so to the
 * host: an MCP call to its policy, a native call to its workspace policy.
 */
export function workspaceHooks(workspaceOf: () => WorkspaceState | undefined): NonNullable<Options["hooks"]> {
  const ask = (reason: string) => ({
    hookSpecificOutput: { hookEventName: "PreToolUse" as const, permissionDecision: "ask" as const, permissionDecisionReason: reason },
  });
  const handle = async (input: HookInput) => {
    const workspace = workspaceOf();
    if (input.hook_event_name !== "PreToolUse" || !workspace) return { continue: true };
    const tool = input.tool_name;
    if (PLAN_TOOLS.has(tool) || tool === TOOL_SEARCH || tool === STRUCTURED_OUTPUT) return { continue: true };
    // Web tools touch no files, nor does a question: `canUseTool` decides them as in any thread.
    if (CLAUDE_WEB_TOOLS.includes(tool) || tool === ASK_USER) return { continue: true };
    if (tool.startsWith("mcp__")) return ask("The host decides MCP tool calls.");
    const toolInput = (input.tool_input ?? {}) as Record<string, unknown>;
    const reason = workspace.refusal(nativeToolApproval(tool, toolInput, workspace));
    if (reason) {
      return {
        hookSpecificOutput: { hookEventName: "PreToolUse" as const, permissionDecision: "deny" as const, permissionDecisionReason: reason },
      };
    }
    return ask("The host decides this call.");
  };
  return { PreToolUse: [{ hooks: [handle] }] };
}

/** The SDK permission result for a decision. The SDK validates an "allow" and
 *  requires `updatedInput` as a record, so the original input passes through
 *  unchanged. A deny carries the decision's reason when it has one. */
function permissionResultOf(decision: ApprovalDecision, toolInput: Record<string, unknown>): PermissionResult {
  if (decision.action === "accept" || decision.action === "approve_for_session") {
    return { behavior: "allow", updatedInput: toolInput };
  }
  return { behavior: "deny", message: decision.reason?.trim() || DEFAULT_DENY_MESSAGE };
}
