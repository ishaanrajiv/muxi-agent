/**
 * Codex app-server → event normalization (pure functions).
 *
 * This module is the *only* place that knows the shape of Codex's experimental
 * protocol on the event path. It maps the ~60 `ServerNotification` variants down
 * to the small `AgentEvent` union and the 10 `ServerRequest` variants to the
 * normalized `ApprovalRequest`, and translates an `ApprovalDecision` back into
 * the correct per-method wire shape.
 *
 * Keeping these pure (no I/O, no client) makes them table-testable — see
 * `normalize.test.ts` and `decisions.test.ts`.
 */

import type {
  AgentEvent,
  ApprovalDecision,
  ApprovalKind,
  ApprovalRequest,
  ErrorCode,
} from "./types/index.ts";
import { WEB_SEARCH_TOOL, mcpToolCallOf, normalizeWorkSummary } from "./types/index.ts";

import type { ServerNotification } from "./generated/ServerNotification.ts";
import type { ServerRequest } from "./generated/ServerRequest.ts";
import type { CodexErrorInfo } from "./generated/v2/CodexErrorInfo.ts";
import type { PatchChangeKind } from "./generated/v2/PatchChangeKind.ts";
import type { Turn } from "./generated/v2/Turn.ts";
import type { TurnError } from "./generated/v2/TurnError.ts";
import { codexWebSearchArgs, codexWebSearchResult } from "./web-search.ts";

// ── Notifications → domain events ──────────────────────────────────────────

/**
 * Server methods the provider receives and deliberately maps to nothing, each with the
 * reason. The replay test (`codex-replay.test.ts`) fails on any method in the
 * recorded fixtures that is neither mapped nor listed here, so a Codex upgrade
 * that starts sending something new is noticed instead of silently dropped.
 */
export const IGNORED_METHODS: Readonly<Record<string, string>> = {
  "remoteControl/status/changed": "Codex remote control; never enabled here",
  "mcpServer/startupStatus/updated": "MCP boot progress; a failed server surfaces on the tool call",
  "thread/settings/updated": "echo of the settings the provider itself sent on turn/start",
  "thread/status/changed": "idle/active flips; turn.started and turn.completed carry the same facts",
  "account/updated": "plan and auth mode; read on demand by the usage probe",
  "account/rateLimits/updated": "usage windows; the provider merges them into its usage snapshot",
  "serverRequest/resolved": "handled by the provider itself, which releases a paused thread clock",
  "turn/moderationMetadata": "the backend's moderation scores for a turn; nothing to show",
  "thread/readState/changed": "a client's unread marker; this package keeps no read state",
};

/** Item types `item/started` and `item/completed` carry that the provider maps to
 *  nothing, each with the reason (see {@link IGNORED_METHODS}). */
export const IGNORED_ITEM_TYPES: Readonly<Record<string, string>> = {
  userMessage: "echo of the prompt the provider sent; the host already has it (a steer's echo, tagged with its id, maps to turn.steer.read)",
};

/**
 * Map a Codex app-server notification to an event, or `null` for the many
 * variants not surfaced (realtime audio, fs watches, account
 * updates, etc.). Dropping is intentional — only the listed cases pass through.
 */
export function notificationToEvent(n: ServerNotification): AgentEvent | null {
  switch (n.method) {
    case "thread/started":
      return { type: "thread.started", threadId: n.params.thread.id };

    case "turn/started":
      return {
        type: "turn.started",
        threadId: n.params.threadId,
        turnId: n.params.turn.id,
      };

    case "turn/completed":
      return {
        type: "turn.completed",
        threadId: n.params.threadId,
        turnId: n.params.turn.id,
      };

    case "item/agentMessage/delta":
      return {
        type: "agent.message.delta",
        threadId: n.params.threadId,
        delta: n.params.delta,
      };

    // The readable reasoning summary (requested via `summary: "auto"`) streams in
    // parts. `item/reasoning/textDelta` is the raw trace instead, which Codex
    // doesn't send for these models and is never shown, so it stays unmapped.
    case "item/reasoning/summaryTextDelta":
      return {
        type: "agent.reasoning.delta",
        threadId: n.params.threadId,
        delta: n.params.delta,
      };

    case "item/reasoning/summaryPartAdded":
      // A new part opens a paragraph, matching the `summary.join("\n\n")` the
      // completed item carries, so the live text splits the same way.
      return n.params.summaryIndex > 0
        ? { type: "agent.reasoning.delta", threadId: n.params.threadId, delta: "\n\n" }
        : null;

    case "turn/plan/updated":
      // Codex's native `update_plan` tool (enabled in the managed config.toml).
      // Codex spells the running status `inProgress`; the `explanation` it sends
      // alongside is turn-level prose, not part text, so it is dropped.
      return {
        type: "agent.plan.updated",
        threadId: n.params.threadId,
        provider: "codex",
        parts: n.params.plan.map((s) => ({
          text: s.step,
          status: s.status === "inProgress" ? "in_progress" : s.status,
        })),
      };

    case "thread/tokenUsage/updated": {
      // Context-window fill after the turn. The `last` breakdown is the most
      // recent turn's usage; the tokens that persist into the next turn's context
      // are its total minus the (ephemeral, dropped) reasoning output — matching
      // how Codex's own TUI computes the "context left" gauge.
      const last = n.params.tokenUsage.last;
      return {
        type: "context.usage",
        threadId: n.params.threadId,
        turnId: n.params.turnId,
        usedTokens: Math.max(0, last.totalTokens - last.reasoningOutputTokens),
        contextWindow: n.params.tokenUsage.modelContextWindow,
      };
    }

    case "item/mcpToolCall/progress":
      return {
        type: "tool.progress",
        threadId: n.params.threadId,
        itemId: n.params.itemId,
        message: n.params.message,
      };

    case "item/started": {
      const item = n.params.item;
      if (item.type === "contextCompaction") return compactionEvent(n.params.threadId, n.params.turnId, "started");
      // Codex records a steer as a user message once it hands it to the model,
      // tagged with the `clientUserMessageId` the steer call sent. The turn's
      // own prompt carries no id, so it stays an ignored echo.
      if (item.type === "userMessage") {
        return item.clientId ? { type: "turn.steer.read", threadId: n.params.threadId, steerId: item.clientId } : null;
      }
      if (item.type === "mcpToolCall") {
        return {
          type: "tool.started",
          threadId: n.params.threadId,
          itemId: item.id,
          server: item.server,
          tool: item.tool,
          arguments: item.arguments,
        };
      }
      // A workspace thread's shell and edits (no other thread has the tools). Named
      // like Claude's built-ins: server "builtin", the native item type as tool.
      if (item.type === "commandExecution") {
        return {
          type: "tool.started",
          threadId: n.params.threadId,
          itemId: item.id,
          server: "builtin",
          tool: "commandExecution",
          arguments: { command: item.command, cwd: item.cwd },
        };
      }
      if (item.type === "fileChange") {
        return {
          type: "tool.started",
          threadId: n.params.threadId,
          itemId: item.id,
          server: "builtin",
          tool: "fileChange",
          arguments: { changes: item.changes.map((c) => ({ path: c.path, kind: c.kind.type })) },
        };
      }
      if (item.type === "webSearch") {
        return {
          type: "tool.started",
          threadId: n.params.threadId,
          itemId: item.id,
          server: "builtin",
          tool: WEB_SEARCH_TOOL,
          arguments: codexWebSearchArgs(item),
        };
      }
      return null;
    }

    case "item/completed": {
      const item = n.params.item;
      if (item.type === "contextCompaction") return compactionEvent(n.params.threadId, n.params.turnId, "completed");
      if (item.type === "mcpToolCall") {
        return {
          type: "tool.completed",
          threadId: n.params.threadId,
          itemId: item.id,
          server: item.server,
          tool: item.tool,
          status: item.status,
          durationMs: item.durationMs,
          ...(item.result != null ? { result: withoutImageBlocks(item.result) } : {}),
          ...(item.error != null ? { error: item.error } : {}),
        };
      }
      if (item.type === "commandExecution") {
        return {
          type: "tool.completed",
          threadId: n.params.threadId,
          itemId: item.id,
          server: "builtin",
          tool: "commandExecution",
          status: item.status,
          durationMs: item.durationMs,
          result: {
            content: [{ type: "text", text: item.aggregatedOutput ?? "" }],
            exitCode: item.exitCode,
          },
        };
      }
      if (item.type === "fileChange") {
        return {
          type: "tool.completed",
          threadId: n.params.threadId,
          itemId: item.id,
          server: "builtin",
          tool: "fileChange",
          status: item.status,
          result: { changes: item.changes.map((c) => ({ path: c.path, kind: c.kind.type, diff: c.diff })) },
        };
      }
      if (item.type === "webSearch") {
        return {
          type: "tool.completed",
          threadId: n.params.threadId,
          itemId: item.id,
          server: "builtin",
          tool: WEB_SEARCH_TOOL,
          status: "completed",
          result: codexWebSearchResult(item),
        };
      }
      if (item.type === "agentMessage") {
        return {
          type: "agent.message.completed",
          threadId: n.params.threadId,
          itemId: item.id,
          text: item.text,
        };
      }
      if (item.type === "reasoning") {
        // The streamed summary parts finalize here. The human-readable text
        // lives in `summary`; `content` is the raw trace, used only when a model
        // sends no summary.
        const text = (item.summary.length ? item.summary : item.content).join("\n\n");
        return {
          type: "agent.reasoning.completed",
          threadId: n.params.threadId,
          itemId: item.id,
          text,
          summary: normalizeWorkSummary(text),
        };
      }
      return null;
    }

    case "error":
      return {
        type: "error.raised",
        ...threadTurnFields(n.params.threadId, n.params.turnId),
        message: turnErrorMessage(n.params.error),
        code: codexErrorCode(n.params.error.codexErrorInfo),
        // Codex retries transient failures itself, so a `willRetry` error is a
        // warning about a blip it recovered from — it must not close the turn.
        fatal: !n.params.willRetry,
        raw: n.params,
      };

    case "configWarning":
      // Codex's config load is all-or-nothing: one bad key in the managed
      // config.toml and the app-server "uses defaults" — no MCP servers, no
      // feature gates — while every turn otherwise proceeds as if healthy.
      // Surface it as a turn warning; it has no thread, and an unattributed
      // warning beats a silently unconfigured agent. That warning names the
      // file it failed on. One with no `path` is about project-local config in
      // the working folder (the trust notice for a `.codex` directory), which
      // the isolated home never uses, so it is not the reader's business.
      if (n.params.path == null) return null;
      return {
        type: "error.raised",
        message:
          `Codex rejected its managed config (running on defaults): ${n.params.summary}` +
          (n.params.details ? ` — ${n.params.details}` : ""),
        code: "config_invalid",
        fatal: false,
        raw: n.params,
      };

    case "model/rerouted":
      return {
        type: "error.raised",
        ...threadTurnFields(n.params.threadId, n.params.turnId),
        message:
          `Codex answered this turn with ${n.params.toModel} instead of ${n.params.fromModel}` +
          `${REROUTE_REASONS[n.params.reason] ? `, because ${REROUTE_REASONS[n.params.reason]}` : ""}.`,
        code: "model_rerouted",
        fatal: false,
        raw: n.params,
      };

    case "deprecationNotice":
      // Thread-less, like `configWarning`: the provider holds it for the next
      // turn when none is running.
      return {
        type: "error.raised",
        message: `Codex deprecation notice: ${n.params.summary}${n.params.details ? ` ${n.params.details}` : ""}`,
        code: "deprecated",
        fatal: false,
        raw: n.params,
      };

    default:
      return null;
  }
}

/** Why Codex rerouted a turn, as a clause that reads after "because". */
const REROUTE_REASONS: Record<string, string> = {
  highRiskCyberActivity: "it flagged the request as possible high-risk cyber activity",
};

/** Non-fatal codes that are notices about the turn, never its likely cause of
 *  failure: a turn with no output must not promote one to its terminal error. */
export const NOTICE_CODES: ReadonlySet<string> = new Set(["model_rerouted", "deprecated"]);

/**
 * A compaction item's start or end. The item carries no token counts, so the
 * provider fills `preTokens` from the thread's last usage. Codex only compacts
 * on its own today (the provider never asks), so the trigger is always auto. The
 * deprecated `thread/compacted` notification is left unmapped; 0.156.1 no
 * longer sends it.
 */
function compactionEvent(threadId: string, turnId: string, phase: "started" | "completed"): AgentEvent {
  return {
    type: "context.compaction",
    threadId,
    ...(turnId ? { turnId } : {}),
    phase,
    trigger: "auto",
  };
}

/** What a stopped turn says when Codex gives no reason. Worded like Claude's
 *  own stop note, so a stopped turn reads the same on either backend. */
const INTERRUPTED_MESSAGE = "Stopped on your request; the turn ended where it was.";

/**
 * The error event a finished Codex turn implies, or `null` when it finished
 * cleanly. `turn.error` is only populated for a `failed` status. An interrupted
 * turn is reported as a non-fatal `interrupted` warning, with or without a
 * reason: the user's own Stop ends the turn, it isn't a failure, but the web
 * still needs to know the turn was cut short (a queued follow-up waits for it).
 */
export function turnStatusEvent(threadId: string, turn: Turn): AgentEvent | null {
  if (turn.status === "failed") {
    return {
      type: "error.raised",
      ...threadTurnFields(threadId, turn.id),
      message: turn.error ? turnErrorMessage(turn.error) : "The turn failed without a reason.",
      code: turn.error ? codexErrorCode(turn.error.codexErrorInfo) : "turn_failed",
      fatal: true,
      ...(turn.error ? { raw: turn.error } : {}),
    };
  }
  if (turn.status === "interrupted") {
    return {
      type: "error.raised",
      ...threadTurnFields(threadId, turn.id),
      message: turn.error ? turnErrorMessage(turn.error) : INTERRUPTED_MESSAGE,
      code: "interrupted",
      fatal: false,
      ...(turn.error ? { raw: turn.error } : {}),
    };
  }
  return null;
}

/** HTTP statuses that mean the request was refused for WHO you are, not for how
 *  the connection went: no credentials (401) or credentials without access (403). */
function isAuthStatus(status: number | null | undefined): boolean {
  return status === 401 || status === 403;
}

/** The `httpStatusCode` a transport variant forwards, when it carries one. Read
 *  structurally: every such variant is `{ <name>: { httpStatusCode } }`, so this
 *  keeps working when Codex adds another one. */
function variantStatus(info: Exclude<CodexErrorInfo, string>): number | null {
  for (const value of Object.values(info as Record<string, unknown>)) {
    const status = (value as { httpStatusCode?: unknown } | null)?.httpStatusCode;
    if (typeof status === "number") return status;
  }
  return null;
}

/** The plain-string `CodexErrorInfo` variants with a sentence of their own. */
const CODEX_ERROR_CODES: Partial<Record<Extract<CodexErrorInfo, string>, ErrorCode>> = {
  unauthorized: "not_logged_in",
  usageLimitExceeded: "usage_limit",
  rateLimitExceeded: "usage_limit",
  sessionBudgetExceeded: "usage_limit",
  serverOverloaded: "overloaded",
  contextWindowExceeded: "context_full",
};

/**
 * Map Codex's error classes onto the provider-neutral {@link ErrorCode}.
 * Unmapped variants stay `unknown` on purpose — a wrong-but-specific sentence
 * ("check your connection") is worse copy than the generic fallback.
 *
 * The transport variants describe the LEG that failed, not why: a signed-out CLI
 * reports `responseStreamDisconnected` with `httpStatusCode: 401`, which read as
 * a network wobble and told the user to re-run instead of to sign in. The status
 * code decides when it carries one.
 */
export function codexErrorCode(info: CodexErrorInfo | null | undefined): ErrorCode {
  if (info == null) return "unknown";
  if (typeof info === "string") return CODEX_ERROR_CODES[info] ?? "unknown";
  const status = variantStatus(info);
  if (isAuthStatus(status)) return "not_logged_in";
  if (status === 429) return "usage_limit";
  if (status === 529) return "overloaded";
  if (
    "httpConnectionFailed" in info ||
    "responseStreamConnectionFailed" in info ||
    "responseStreamDisconnected" in info ||
    "responseTooManyFailedAttempts" in info
  ) {
    return "network";
  }
  return "unknown";
}

/** Codex splits its prose across `message` + `additionalDetails`; keep both. */
function turnErrorMessage(error: TurnError): string {
  const detail = error.additionalDetails?.trim();
  if (!detail || error.message.includes(detail)) return error.message;
  return `${error.message} — ${detail}`;
}

/** Only stamp ids the app-server actually sent (older builds omit them). */
function threadTurnFields(
  threadId: unknown,
  turnId: unknown,
): { threadId?: string; turnId?: string } {
  return {
    ...(typeof threadId === "string" && threadId ? { threadId } : {}),
    ...(typeof turnId === "string" && turnId ? { turnId } : {}),
  };
}

// ── Server requests → normalized approval packet ───────────────────────────

/**
 * The set of server requests surfaced to a host and resolved by it.
 *
 * Read-only lockdown (security): the agent's NATIVE shell / file-edit /
 * permission-escalation requests are intentionally excluded. For those,
 * {@link requestToApproval} returns `null` and the provider auto-rejects them:
 * outside workspace mode the agent's only write path is its MCP tools, which
 * ride `item/mcpToolCall/*` + `mcpServer/elicitation/request` (kept below), not
 * these methods. Do NOT re-add `item/commandExecution/requestApproval`,
 * `execCommandApproval`, `item/fileChange/requestApproval`, `applyPatchApproval`,
 * or `item/permissions/requestApproval` without revisiting that guarantee.
 */
const USER_FACING_REQUEST_METHODS = new Set<ServerRequest["method"]>([
  "item/tool/requestUserInput",
  "mcpServer/elicitation/request",
]);

/**
 * The native shell and file-edit requests a WORKSPACE thread surfaces (see
 * {@link RequestToApprovalOptions.workspaceMode}). Workspace mode is the one
 * exception to the lockdown above: the agent works in its root folder, and the
 * host decides every request. Every other thread still gets null.
 */
const WORKSPACE_REQUEST_METHODS = new Set<ServerRequest["method"]>([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
]);

export interface RequestToApprovalOptions {
  /** The request's thread is in workspace mode: surface its native shell and
   *  edit requests too. */
  workspaceMode?: boolean;
  /** The changes a `fileChange` item announced on `item/started`, by item id.
   *  The approval request carries only the item id. */
  fileChanges?: (itemId: string) => ReadonlyArray<{ path: string; kind: PatchChangeKind }> | undefined;
}

/** A file change's kind in the approval vocabulary. */
function changeKind(kind: PatchChangeKind): "add" | "update" | "delete" {
  return kind.type;
}

/** The `detail` a workspace thread's native request carries (the same shapes
 *  the Claude provider sends for its native tools). */
function nativeDetail(req: ServerRequest, opts: RequestToApprovalOptions): Record<string, unknown> {
  if (req.method === "item/commandExecution/requestApproval") {
    const p = req.params;
    return {
      command: p.command ?? "",
      cwd: p.cwd ?? "",
      ...(p.reason ? { reason: p.reason } : {}),
      itemId: p.itemId,
      _meta: { native_tool: "commandExecution" },
    };
  }
  const p = (req as Extract<ServerRequest, { method: "item/fileChange/requestApproval" }>).params;
  const changes = (opts.fileChanges?.(p.itemId) ?? []).flatMap((c) => {
    const main = { path: c.path, kind: changeKind(c.kind) };
    // A move writes its destination too, which the host must see.
    return c.kind.type === "update" && c.kind.move_path
      ? [main, { path: c.kind.move_path, kind: "add" as const }]
      : [main];
  });
  return {
    changes,
    ...(p.reason ? { reason: p.reason } : {}),
    ...(p.grantRoot ? { grantRoot: p.grantRoot } : {}),
    itemId: p.itemId,
    _meta: { native_tool: "fileChange" },
  };
}

function kindForMethod(method: ServerRequest["method"]): ApprovalKind {
  switch (method) {
    case "item/commandExecution/requestApproval":
    case "execCommandApproval":
      return "command";
    case "item/fileChange/requestApproval":
    case "applyPatchApproval":
      return "fileChange";
    case "mcpServer/elicitation/request":
      return "mcpElicitation";
    case "item/permissions/requestApproval":
      return "permissions";
    case "item/tool/requestUserInput":
      return "userInput";
    default:
      return "permissions";
  }
}

/** Best-effort thread/turn extraction across the heterogeneous param shapes. */
function threadTurnOf(params: unknown): { threadId: string | null; turnId: string | null } {
  const p = (params ?? {}) as Record<string, unknown>;
  const threadId =
    typeof p.threadId === "string"
      ? p.threadId
      : typeof p.conversationId === "string"
        ? p.conversationId
        : null;
  const turnId = typeof p.turnId === "string" ? p.turnId : null;
  return { threadId, turnId };
}

/**
 * A tool result without its image blocks. The model reads an image a tool
 * returns (a screenshot, a chart), but the event stream and a host keep only
 * the text, so a base64 picture never rides
 * along to the client or sits in the thread's history. Takes a bare block list
 * (Claude) or an MCP result with `content` (Codex).
 */
export function withoutImageBlocks<T>(result: T): T {
  const isImage = (b: unknown) => !!b && typeof b === "object" && (b as { type?: unknown }).type === "image";
  if (Array.isArray(result)) return result.filter((b) => !isImage(b)) as T;
  if (result && typeof result === "object" && Array.isArray((result as { content?: unknown }).content)) {
    const r = result as unknown as { content: unknown[] };
    return { ...r, content: r.content.filter((b) => !isImage(b)) } as T;
  }
  return result;
}

/**
 * The question an elicitation carries, as a one-line summary, or `null` when
 * the message isn't a question envelope. An MCP tool that asks a person
 * something may send its elicit message as JSON tagged `kind: "question"`,
 * with either `questions: [...]` or a single `question`: the MCP elicit message
 * has no other structured channel. Shared by both providers so an approval
 * reads as the real question on either backend instead of a static "requests
 * confirmation".
 */
export function questionEnvelopeSummary(message: string | null | undefined): string | null {
  if (typeof message !== "string" || !message.trimStart().startsWith("{")) return null;
  let envelope: {
    kind?: string;
    question?: string;
    questions?: Array<{ question?: string }>;
  };
  try {
    envelope = JSON.parse(message);
  } catch {
    return null;
  }
  if (envelope.kind !== "question") return null;
  const first =
    typeof envelope.question === "string" ? envelope.question : envelope.questions?.[0]?.question;
  if (typeof first !== "string" || !first.trim()) return null;
  const extra = (envelope.questions?.length ?? 0) - 1;
  return extra > 0 ? `${first} (+${extra} more)` : first;
}

const SUMMARIES: Record<ApprovalKind, string> = {
  command: "Agent requests approval to run a command",
  fileChange: "Agent requests approval to change files",
  mcpElicitation: "MCP server requests confirmation",
  permissions: "Agent requests expanded permissions",
  userInput: "Agent requests user input",
};

/** Normalize a Codex server request into an approval packet. */
export function requestToApproval(
  req: ServerRequest,
  opts: RequestToApprovalOptions = {},
): ApprovalRequest | null {
  const kind = kindForMethod(req.method);
  const { threadId, turnId } = threadTurnOf(req.params);
  if (opts.workspaceMode && WORKSPACE_REQUEST_METHODS.has(req.method)) {
    const detail = nativeDetail(req, opts);
    return {
      requestId: req.id,
      kind,
      threadId,
      turnId,
      summary:
        kind === "command" && typeof detail.command === "string" && detail.command
          ? `Run ${detail.command}`
          : SUMMARIES[kind],
      detail,
    };
  }
  if (!USER_FACING_REQUEST_METHODS.has(req.method)) {
    return null;
  }
  const message = (req.params as { message?: unknown } | null | undefined)?.message;
  // A tool-call confirmation names its tool, as the Claude bridge's does.
  const call = mcpToolCallOf({ detail: req.params });
  return {
    requestId: req.id,
    kind,
    threadId,
    turnId,
    // A clarifying question names itself; only the rest fall back to the static
    // per-kind sentence.
    summary:
      questionEnvelopeSummary(typeof message === "string" ? message : null) ??
      (call?.server && call.tool ? `Run ${call.server} tool "${call.tool}"` : SUMMARIES[kind]),
    detail: req.params,
  };
}

/** True if a host can surface and resolve this server request as an approval. */
export function isUserFacingRequestMethod(method: ServerRequest["method"]): boolean {
  return USER_FACING_REQUEST_METHODS.has(method);
}

// ── Decision → wire shape ──────────────────────────────────────────────────

/**
 * Translate a domain `ApprovalDecision` into the JSON-RPC response body the
 * originating request method expects.
 *
 * Legacy helper retained for callers that only know the normalized kind.
 * The live provider uses {@link decisionToWireForRequest} so it can distinguish
 * newer v2 app-server approval methods from the legacy `execCommandApproval`
 * and `applyPatchApproval` methods.
 */
export function decisionToWire(kind: ApprovalKind, decision: ApprovalDecision): unknown {
  if (kind === "command" || kind === "fileChange" || kind === "permissions") {
    return { decision: reviewDecision(decision.action) };
  }
  // mcpElicitation and userInput both use the MCP elicitation { action } shape.
  return {
    action: elicitationAction(decision.action),
    content: decision.content ?? null,
    _meta: decision._meta ?? null,
  };
}

/**
 * Translate a decision using the exact originating app-server method.
 *
 * Codex currently has both legacy request methods (`execCommandApproval`,
 * `applyPatchApproval`) and v2 item request methods. They are semantically the
 * same here, but their wire enums differ.
 */
export function decisionToWireForRequest(
  method: ServerRequest["method"],
  decision: ApprovalDecision,
  params?: unknown,
): unknown {
  switch (method) {
    case "item/commandExecution/requestApproval":
      return { decision: codexV2Decision(decision.action) };
    case "item/fileChange/requestApproval":
      return { decision: codexV2Decision(decision.action) };
    case "execCommandApproval":
    case "applyPatchApproval":
      return { decision: reviewDecision(decision.action) };
    case "mcpServer/elicitation/request":
      return {
        action: elicitationAction(decision.action),
        content: decision.content ?? null,
        _meta: decision._meta ?? null,
      };
    case "item/tool/requestUserInput":
      return { answers: userInputAnswers(decision.content) };
    case "item/permissions/requestApproval":
      return permissionsDecision(decision, params);
    default:
      return { decision: "denied" };
  }
}

function reviewDecision(action: ApprovalDecision["action"]): string {
  switch (action) {
    case "accept":
      return "approved";
    case "approve_for_session":
      return "approved_for_session";
    case "abort":
      return "abort";
    case "decline":
    case "cancel":
    default:
      return "denied";
  }
}

function codexV2Decision(action: ApprovalDecision["action"]): string {
  switch (action) {
    case "accept":
      return "accept";
    case "approve_for_session":
      return "acceptForSession";
    case "cancel":
      return "cancel";
    case "abort":
    case "decline":
    default:
      return "decline";
  }
}

function elicitationAction(action: ApprovalDecision["action"]): string {
  switch (action) {
    case "accept":
    case "approve_for_session":
      return "accept";
    case "cancel":
    case "abort":
      return "cancel";
    case "decline":
    default:
      return "decline";
  }
}

function userInputAnswers(content: unknown): Record<string, { answers: string[] }> {
  if (content && typeof content === "object" && !Array.isArray(content)) {
    const maybe = content as Record<string, unknown>;
    if ("answers" in maybe && maybe.answers && typeof maybe.answers === "object") {
      return maybe.answers as Record<string, { answers: string[] }>;
    }
    const out: Record<string, { answers: string[] }> = {};
    for (const [key, value] of Object.entries(maybe)) {
      out[key] = {
        answers: Array.isArray(value)
          ? value.map(String)
          : value == null
            ? []
            : [String(value)],
      };
    }
    return out;
  }
  return {};
}

function permissionsDecision(decision: ApprovalDecision, params: unknown): unknown {
  if (decision.action !== "accept" && decision.action !== "approve_for_session") {
    return {
      permissions: {},
      scope: "turn",
      strictAutoReview: true,
    };
  }
  const p = (params ?? {}) as Record<string, unknown>;
  return {
    permissions:
      decision.content && typeof decision.content === "object"
        ? decision.content
        : (p.permissions ?? {}),
    scope: decision.action === "approve_for_session" ? "session" : "turn",
    strictAutoReview: true,
  };
}
