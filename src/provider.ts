/**
 * AgentProvider: the transport-agnostic seam between a host and an agent
 * backend. The Codex app-server is experimental and churns across CLI releases;
 * everything above this interface speaks only the types in `./types`, so the
 * backend stays swappable.
 */

import type {
  AgentModel,
  ApprovalDecision,
  ApprovalRequest,
  McpServerConfig,
  ProviderId,
  ProviderStatus,
  ProviderUsage,
  StartThreadInput,
  Thread,
  TurnInput,
  TurnStreamEvent,
} from "./types/index.ts";

/** JSON-RPC request id, as surfaced on an approval request. */
export type ApprovalRequestId = number | string;

/** A one-shot, tool-free model task that joins no thread and persists nothing:
 *  a title, a classification, an extraction. */
export interface UtilityTurnInput {
  model: string;
  effort?: string;
  cwd: string;
  systemInstructions: string;
  prompt: string;
  outputSchema: Record<string, unknown>;
  timeoutMs: number;
}

export interface UtilityTurnResult {
  output: unknown;
  text: string;
  durationMs: number;
  inputTokens?: number;
  outputTokens?: number;
}

/**
 * The single system prompt a thread's base and developer instructions compose
 * into. Exported so a host persists exactly the string the Claude provider hands
 * the SDK, and a cold resume restores it byte for byte.
 */
export function composeSystemPrompt(
  baseInstructions?: string,
  developerInstructions?: string,
): string | undefined {
  return [baseInstructions, developerInstructions].filter(Boolean).join("\n\n") || undefined;
}

/**
 * Thread state a host persists and hands back when it resumes a thread cold
 * (after a restart). Without it a backend that keeps per-thread settings in
 * memory would have to guess them. Every field is optional: a provider reads
 * only what it needs.
 */
export interface ResumeThreadState {
  /** The backend session the thread points at, when it diverged from the
   *  thread id (a Claude rollback forks the session, minting a new id). */
  providerSessionId?: string | null;
  /** The exact system prompt the thread was started with (Claude). */
  systemPrompt?: string | null;
  /** The reasoning effort of the thread's last turn. */
  effort?: string | null;
  /** The thread's working directory. */
  cwd?: string | null;
  /** The thread's model (Claude; Codex keeps its own). */
  model?: string | null;
  /** The thread's MCP servers. Both backends need them again after a restart:
   *  neither persists a thread's servers. */
  mcpServers?: Record<string, McpServerConfig> | null;
  /** Whether the thread had web search and subagents. */
  webSearch?: boolean | null;
  subagents?: boolean | null;
  /** Whether the thread may ask the person questions (Claude's AskUserQuestion). */
  askUser?: boolean | null;
}

/**
 * Outcome of {@link AgentProvider.rollbackThread}. `providerSessionId` is set
 * when the rollback moved the thread to a different backend session (Claude
 * forks at the boundary, minting a new session id): persist it and hand it back
 * in {@link ResumeThreadState}, or a restart would resurrect the old transcript.
 */
export interface RollbackResult {
  providerSessionId?: string;
}

/** A rollback the backend refuses as invalid rather than as broken. */
export class InvalidRollbackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidRollbackError";
  }
}

/** Where a rollback or point fork cuts a thread's history. */
export interface HistoryCut {
  keepTurns?: number;
  totalTurns?: number;
  /**
   * The texts steered into each of the thread's turns, oldest turn first. A
   * backend whose history marks prompts rather than turns (Claude) needs them to
   * find where a turn ends. Absent means no turn was steered.
   */
  steersPerTurn?: string[][];
}

/**
 * What a provider needs to switch a thread into workspace mode: the agent works
 * in `root` with file tools and a sandboxed shell (network off unless
 * `network`), and every native tool call comes back as an `approval.requested`
 * for the host to decide, after {@link refusal} hard-refuses what is never
 * allowed.
 *
 * A host hands this over once when it switches the thread (`introduce: true`)
 * and again whenever it hydrates the thread in a new process (`introduce` only
 * while no turn has completed since), so a provider keeps it in memory only.
 */
/** One tool call, as a {@link ToolGuard} sees it. */
export interface ToolGuardCall {
  /** The provider's thread id. */
  threadId: string;
  /** The tool's name as the backend calls it: a built-in (`Read`, `WebFetch`) or
   *  `mcp__<server>__<tool>`. */
  tool: string;
  input: Record<string, unknown>;
  /** The CLI agent id when a subagent made the call. */
  agentId?: string;
}

/**
 * A host's hard refusals for every tool call on every thread: the reason a call
 * is refused, or null. It holds however the call would otherwise be decided,
 * the calls a backend runs unasked (web search and fetch, the plan tools)
 * included. Claude runs it in a `PreToolUse` hook ahead of every other hook
 * (main agent and subagents alike) and again before `canUseTool` bridges a call
 * to the host. Codex has no such hook: its MCP calls and workspace calls reach
 * the host as approvals, and its web search is the backend's own.
 */
export type ToolGuard = (call: ToolGuardCall) => string | null;

export interface WorkspaceSettings {
  /** The working folder: the thread's new cwd and the only place it writes
   *  (besides `cacheDir`). Its `.git` stays read-only and its env files
   *  unreadable to the shell. */
  root: string;
  /** Folders the shell may not read at all, except the path down to `root` or
   *  `cacheDir` when one lies inside (so a data folder that holds the
   *  workspace can still be protected around it). */
  protectedPaths?: string[];
  /** A folder the shell may write besides `root`: package manager caches (uv,
   *  pip, npm) point here. Omitted, the caches stay unset and unwritable. */
  cacheDir?: string;
  /** Let the shell reach the network (this machine's own servers stay
   *  blocked on Claude). Off by default. */
  network?: boolean;
  /** Claude only: give the agent the Bash tool. Default true. Codex reads and
   *  edits through its shell, so it always has one. */
  shell?: boolean;
  /** The thread's developer instructions with the workspace steering appended.
   *  A backend that takes developer instructions per load (Codex) uses it. */
  developerInstructions: string;
  /** The whole system prompt with the workspace steering appended. Claude adopts
   *  it wherever it renders the prompt afresh. */
  systemPrompt: string;
  /** The workspace steering alone, delivered once on the next turn's message
   *  when `introduce` is set (Claude snapshots its system prompt; a resumed
   *  Codex thread keeps the developer message it started with). */
  instructions: string;
  /** True on the switch itself, and on a re-apply after a restart until the
   *  first turn since completes. */
  introduce: boolean;
  /**
   * Hard refusals: the reason a native call is refused whatever the host would
   * decide, or null. Claude runs it in a `PreToolUse` hook, before its own
   * permission logic; both backends still send every call it passes to the
   * host as an approval.
   */
  refusal: (request: Pick<ApprovalRequest, "kind" | "detail">) => string | null;
}

export interface AgentProvider {
  /** Which backend this is. */
  readonly id: ProviderId;

  /** Detect the backend: binary path, version, login, app-server launch. */
  probe(): Promise<ProviderStatus>;

  /** The models the backend offers (its live, login-dependent catalog). */
  listModels(): Promise<AgentModel[]>;

  /**
   * The subscription's usage windows, or `null` when the backend can't report
   * them (API-key auth, logged out, parse failure). Costs no quota, so callers
   * may poll it.
   */
  getUsage(): Promise<ProviderUsage | null>;

  /** Run a structured, tool-free, non-persistent utility task. */
  runUtilityTurn(input: UtilityTurnInput): Promise<UtilityTurnResult>;

  /** Start a new thread. */
  startThread(input: StartThreadInput): Promise<Thread>;

  /**
   * Resume a thread by id, rehydrating it with the state the host persisted
   * ({@link ResumeThreadState}). Called once per thread per process, before its
   * first turn.
   */
  resumeThread(threadId: string, state?: ResumeThreadState): Promise<Thread>;

  /** Run one turn, streaming normalized events until it completes. */
  sendTurn(threadId: string, input: TurnInput): AsyncIterable<TurnStreamEvent>;

  /** Resolve a pending approval surfaced by an `approval.requested` event.
   *  Throws {@link PendingApprovalNotFoundError} when its turn is gone. */
  resolveApproval(requestId: ApprovalRequestId, decision: ApprovalDecision): Promise<void>;

  /** Interrupt an in-flight turn, and every subagent it started. */
  interrupt(threadId: string, turnId: string): Promise<void>;

  /** Forget a thread this process holds in memory. Its persisted rollout or
   *  transcript is left alone, and an unknown id is a no-op. */
  releaseThread(threadId: string): Promise<void>;

  /**
   * Switch `threadId` into workspace mode (see {@link WorkspaceSettings}).
   * Other threads are untouched. Idempotent.
   */
  configureWorkspace(threadId: string, settings: WorkspaceSettings): Promise<void>;

  /**
   * Drop the last `numTurns` turns from a thread's history. Does NOT revert side
   * effects a turn already committed. `numTurns` must be >= 1.
   */
  rollbackThread(
    threadId: string,
    numTurns: number,
    opts?: Pick<HistoryCut, "steersPerTurn">,
  ): Promise<RollbackResult>;

  /** Fork a thread into a new, independent thread carrying its history, or the
   *  first `opts.keepTurns` turns of it. */
  forkThread(threadId: string, opts?: HistoryCut): Promise<Thread>;

  /** Whether this backend can fold a message into the running turn
   *  ({@link steerTurn}). When false, queue the message as the next turn. */
  readonly supportsSteer?: boolean;

  /**
   * Deliver `text` into the RUNNING turn `turnId`. Rejects when `turnId` is not
   * the active turn. Bounded: rejects rather than hangs when the backend doesn't
   * answer. `steerId` tags the message so the backend's read receipt
   * (`turn.steer.read`) can name it.
   */
  steerTurn?(threadId: string, turnId: string, text: string, steerId?: string): Promise<void>;

  /** The turn's stream carries `turn.steer.read` for every steer taken in. */
  readonly reportsSteerRead?: boolean;

  /** Stop one subagent of the running turn. Resolves false when the turn has no
   *  such live subagent. */
  stopSubagent?(threadId: string, subagentId: string): Promise<boolean>;
}
