/**
 * Codex threads as the provider sees them: the thread objects the app-server returns,
 * the loaded-thread bookkeeping, which thread a request or event belongs to,
 * and the thread RPCs whose answers need translating.
 */

import type { AgentEvent, Thread } from "../types/index.ts";

import type { CodexClient } from "../codex-client.ts";
import type { ServerRequest } from "../generated/ServerRequest.ts";
import type { ThreadResumeParams } from "../generated/v2/ThreadResumeParams.ts";
import type { ThreadStartParams } from "../generated/v2/ThreadStartParams.ts";
import type { UtilityTurnInput } from "../provider.ts";
import { errorMessage } from "../shared.ts";

/** Minimal shape of the `thread` object returned by thread/* RPCs. */
export interface RawThread {
  id: string;
  cwd?: string | null;
  status?: unknown;
  modelProvider?: string | null;
}

/** A thread the running app-server has loaded (see `CodexAgentProvider.liveThreads`). */
export interface LiveThread {
  /** When the last operation on the thread finished (epoch ms). */
  lastActiveAt: number;
  /** Operations running on the thread right now: a turn, a rollback, a fork, a steer. */
  busy: number;
}

/**
 * The thread object itself carries only `modelProvider`, such as "openai". The
 * actual model id rides at the RPC response's top level, so callers pass it in.
 * Never report the provider name as the model: it gets persisted on the thread
 * row and echoed back to Codex as a model id, which the backend rejects.
 */
export function toDomainThread(t: RawThread, model?: string | null): Thread {
  return {
    id: t.id,
    cwd: t.cwd != null ? String(t.cwd) : null,
    status: threadStatusToString(t.status),
    model: model ?? null,
    provider: "codex",
  };
}

function threadStatusToString(status: unknown): string {
  if (typeof status === "string") return status;
  if (status && typeof status === "object" && "type" in status) {
    const type = (status as { type?: unknown }).type;
    if (typeof type === "string") return type;
  }
  return "unknown";
}

/** The thread a server request belongs to, when its params name one. */
export function requestThreadId(req: ServerRequest): string | null {
  const p = (req.params ?? {}) as { threadId?: unknown; conversationId?: unknown };
  if (typeof p.threadId === "string") return p.threadId;
  return typeof p.conversationId === "string" ? p.conversationId : null;
}

export function eventThreadId(ev: AgentEvent): string | null {
  if ("threadId" in ev) return ev.threadId ?? null;
  if (ev.type === "approval.requested") return ev.request.threadId;
  return null;
}

/**
 * `thread/resume` for metadata only: a host keeps its own transcript, and
 * rollback pages turns with `thread/turns/list`, so the hydrated history is
 * never read (Codex deprecates asking for it). Its one known-cryptic failure is
 * translated: codex merges a rollout's stdio MCP server config with a new
 * streamable-HTTP (`url =`) one of the same name and rejects the whole load.
 * `overrides` carries the thread's config and workspace settings.
 */
export async function resumeThreadRaw(
  client: CodexClient,
  threadId: string,
  overrides: Partial<ThreadResumeParams>,
): Promise<{ thread: RawThread; model?: string | null }> {
  try {
    const params = { threadId, excludeTurns: true, ...overrides };
    return (await client.request("thread/resume", params)) as {
      thread: RawThread;
      model?: string | null;
    };
  } catch (err) {
    const msg = errorMessage(err);
    if (msg.includes("url is not supported for stdio")) {
      throw new Error(
        "This thread was created with a stdio MCP server of a name that is now an HTTP server, " +
          "and Codex can't resume it. Start a new thread.",
      );
    }
    throw err;
  }
}

/**
 * Resolve the id of the `n`th-newest turn via `thread/turns/list` (descending,
 * metadata only). When the thread has fewer than `n` turns, returns the oldest
 * turn's id — reverting to before it clears the whole history, so a `numTurns`
 * that covers every turn empties the thread. Returns null only
 * for a thread with no turns at all.
 */
export async function nthNewestTurnId(
  client: CodexClient,
  threadId: string,
  n: number,
): Promise<string | null> {
  let cursor: string | null = null;
  let remaining = n;
  let oldestSeen: string | null = null;
  do {
    const res = (await client.request("thread/turns/list", {
      threadId,
      limit: remaining,
      sortDirection: "desc",
      itemsView: "notLoaded",
      ...(cursor !== null ? { cursor } : {}),
    })) as { data: Array<{ id: string }>; nextCursor: string | null };
    if (res.data.length === 0) break;
    const take = Math.min(remaining, res.data.length);
    oldestSeen = res.data[take - 1].id;
    remaining -= take;
    cursor = res.nextCursor;
  } while (remaining > 0 && cursor !== null);
  return oldestSeen;
}

/** The `thread/start` params of a utility turn's thread: read-only, never
 *  asks, ephemeral, and no MCP servers or web search. */
export function utilityThreadParams(input: UtilityTurnInput): ThreadStartParams {
  return {
    cwd: input.cwd,
    model: input.model,
    sandbox: "read-only",
    approvalPolicy: "never",
    baseInstructions: input.systemInstructions,
    developerInstructions: "Return only the requested structured output.",
    // `environments`, `runtimeWorkspaceRoots`, and `dynamicTools` are left
    // unset: their defaults are what we want, and they are experimentalApi
    // fields whose shape can move between codex builds.
    ephemeral: true,
    config: {
      model_verbosity: "low",
      web_search: "disabled",
    },
  } as ThreadStartParams;
}
