/**
 * CodexAgentProvider: the Codex-backed implementation of {@link AgentProvider}.
 *
 * Wraps the low-level {@link CodexClient} (an EventEmitter over app-server
 * JSON-RPC) and exposes the transport-agnostic provider surface: it bridges the
 * emitter into a per-turn `AsyncIterable<AgentEvent>`, normalizes events, and
 * routes approvals out-of-band with the correct wire shape.
 *
 * Isolation: the app-server runs under a dedicated `CODEX_HOME` the caller
 * names (`codexHome`), which the provider prepares on every start (see
 * `codex/home.ts`): project docs off, no plugins, apps, skills or shell, and
 * no MCP servers but the ones each thread brings. Threads start read-only and
 * ask on request, so every MCP tool call and elicitation reaches the host.
 */

import { randomUUID } from "node:crypto";

import type {
  AgentEvent,
  AgentModel,
  ApprovalDecision,
  ApprovalKind,
  ProviderStatus,
  ProviderUsage,
  StartThreadInput,
  Thread,
  TurnInput,
} from "./types/index.ts";

import { CodexClient, type CodexClientOptions } from "./codex-client.ts";
import { decisionToWireForRequest, notificationToEvent, requestToApproval } from "./normalize.ts";
import { codexBucket, codexUsage, codexUsageLimitMessage, isCodexBucket, mergeRateLimits } from "./codex-usage.ts";
import { readCodexAccount } from "./codex-account.ts";
import { probe } from "./probe.ts";
import type { AgentProvider } from "./provider.ts";
import type { RequestId } from "./generated/RequestId.ts";
import type { ServerNotification } from "./generated/ServerNotification.ts";
import type { ServerRequest } from "./generated/ServerRequest.ts";
import type { Model } from "./generated/v2/Model.ts";
import type { GetAccountRateLimitsResponse } from "./generated/v2/GetAccountRateLimitsResponse.ts";
import type { RateLimitSnapshot } from "./generated/v2/RateLimitSnapshot.ts";
import type { JsonValue } from "./generated/serde_json/JsonValue.ts";
import type { ThreadStartParams } from "./generated/v2/ThreadStartParams.ts";
import type { TokenUsageBreakdown } from "./generated/v2/TokenUsageBreakdown.ts";
import type {
  ResumeThreadState,
  RollbackResult,
  UtilityTurnInput,
  UtilityTurnResult,
  WorkspaceSettings,
} from "./provider.ts";
import { InvalidRollbackError } from "./provider.ts";
import { errorMessage, PendingApprovalNotFoundError, userPrompt } from "./shared.ts";
import { checkSubagentRole, type SubagentRole } from "./subagents.ts";
import { CompactionSizes } from "./codex/compaction.ts";
import { prepareCodexHome } from "./codex/home.ts";
import { CodexSubagents } from "./codex/subagents.ts";
import { EMPTY_SETUP, threadConfig, type ThreadSetup } from "./codex/thread-config.ts";
import { clampEffort, effortScale, type EffortScale, pickerModels } from "./codex/models.ts";
import { workspaceResumeOverrides, writeWorkspaceProfile } from "./codex/workspace.ts";
import {
  type LiveThread,
  nthNewestTurnId,
  type RawThread,
  requestThreadId,
  resumeThreadRaw,
  toDomainThread,
  utilityThreadParams,
} from "./codex/threads.ts";
import { TimeoutClock } from "./codex/timeout-clock.ts";
import { CodexTurn, type CodexTurnOptions, turnStartParams } from "./codex/turn.ts";

/**
 * How long a `turn/steer` round trip may take before it counts as failed.
 *
 * A steer is answered inline on the message-send request the user is waiting
 * on, and its only alternatives (queue it, or hand it back) are both cheap — so
 * a slow or wedged app-server must lose the race quickly rather than hold the
 * composer. Five seconds is far above the app-server's normal answer for a call
 * that only appends to the running turn, and far below the 60s default ceiling
 * that fits long-running requests with no one waiting on them.
 */
const STEER_TIMEOUT_MS = 5_000;

/** Why a Codex thread can't have both the web and a workspace (its shell). */
export const CODEX_WEB_AND_SHELL = "Codex can't work a workspace on a thread with web search: its shell and the web together aren't allowed.";

export interface CodexAgentProviderOptions extends Omit<CodexClientOptions, "env"> {
  /**
   * The dedicated `CODEX_HOME` the app-server runs under: a folder of the
   * provider's own, never the user's `~/.codex`. Prepared on every start (see
   * `codex/home.ts`), with the user's `~/.codex/auth.json` linked in.
   */
  codexHome: string;
  /** The user's own Codex home, whose login is linked in. Default `~/.codex`. */
  userCodexHome?: string;
  /** Extra env for every codex invocation. `CODEX_HOME` is always `codexHome`. */
  env?: Record<string, string>;
  /** The subagent role. Without it no thread gets subagents, whatever it asks. */
  subagent?: SubagentRole;
  /** Per-turn timeout in ms before `sendTurn` throws (default 30 minutes). */
  turnTimeoutMs?: number;
  /** How often idle threads are swept out of the app-server (default 5 minutes). */
  idleSweepMs?: number;
  /** How long a thread sits unused before a sweep unloads it (default 30 minutes). */
  idleUnloadMs?: number;
}

export class CodexAgentProvider implements AgentProvider {
  readonly id = "codex" as const;

  private client: CodexClient;
  private started = false;
  /**
   * In-flight start, memoized so concurrent callers share one spawn+initialize.
   * Without this, two near-simultaneous entrypoints (e.g. the model picker's
   * `listModels` racing a thread `boot`) both see `started === false` and each
   * send `initialize` to the same app-server — the second fails with
   * `-32600: Already initialized`.
   */
  private startPromise: Promise<void> | null = null;
  private readonly codexBin: string;
  private readonly turnTimeoutMs: number;
  /**
   * Env applied to every Codex invocation: the app-server spawn AND the
   * out-of-band `codex` exec calls in {@link probe}. Carries `CODEX_HOME` so
   * both target the dedicated home, never the user's `~/.codex`.
   */
  private readonly execEnv: Record<string, string>;
  private readonly codexHome: string;
  private readonly userCodexHome: string | undefined;
  private readonly subagentRole: SubagentRole | undefined;
  /**
   * Approval id → the pending approval. The KEY is a random UUID we mint per
   * request, NOT Codex's native request id:
   * Codex reuses native ids across turns/threads (they reset per turn), so two
   * concurrent turns (a utility turn overlapping a thread's approval, say) can
   * collide on the same native id and clobber each other's entry here and in a
   * host's approvals table. The UUID is the external handle, and it cannot
   * collide with the Claude provider's ids in a shared table. We keep the
   * native `rawId` here only to reply to Codex, which matches the response by its
   * own id and native type (numbers stay numbers).
   */
  private readonly pendingApprovals = new Map<
    string,
    {
      kind: ApprovalKind;
      method: ServerRequest["method"];
      rawId: RequestId;
      params: unknown;
      threadId: string;
      /** Resolves true once codex paused this thread's timeout accounting for
       *  the question (see {@link TimeoutClock.pause}). The reply awaits it,
       *  so a slow increment can never land after the decrement it pairs with. */
      paused: Promise<boolean>;
    }
  >();
  /**
   * Model id AND slug → the effort scale that model offers, filled from
   * `model/list` (see {@link listModels}). Read by {@link resolveEffort}: a turn
   * carrying an effort the model doesn't support is clamped to the model's own
   * default rather than sent through and silently ignored (or rejected).
   */
  private readonly modelEfforts = new Map<string, EffortScale>();
  /**
   * Thread ids the *current* app-server process has loaded into memory — via
   * `thread/start` or `thread/resume` since this process spawned. Codex keeps
   * threads in-memory per process: a thread persisted by a previous run (or
   * before a crash-respawn) is on disk but unknown to the running app-server,
   * so `turn/start` against it fails with `-32600: thread not found`. We resume
   * such threads on demand in {@link sendTurn}. Cleared whenever the app-server
   * (re)spawns (see {@link ensureStarted}), so a fresh process re-resumes lazily.
   *
   * A loaded thread holds its rollout and MCP state in the app-server for as
   * long as it stays loaded, so {@link sweepIdleThreads} unloads the ones nobody
   * has touched for {@link idleUnloadMs}; the next turn resumes them again.
   */
  private readonly liveThreads = new Map<string, LiveThread>();
  /** Unsubscribes the idle sweep has sent and Codex has not yet answered. A
   *  resume must wait for its thread's, or the late unload lands on the fresh load. */
  private readonly unloading = new Map<string, Promise<void>>();
  private readonly idleSweepMs: number;
  private readonly idleUnloadMs: number;
  private idleSweep: ReturnType<typeof setInterval> | null = null;
  /** Set by {@link retireAppServer} while a thread is still busy: the app-server
   *  stops the moment the last operation ends. */
  private retiring = false;
  /** Operations holding any thread (see {@link holdThread}). Counted apart from
   *  {@link liveThreads}, which a respawn or `thread/closed` can clear under a
   *  running turn. */
  private busyOps = 0;
  /** Each thread's timeout accounting, paused while a question waits on a human. */
  private readonly clock: TimeoutClock;
  /** The `codex` usage bucket: the last read, with every push since merged in.
   *  Names the window and its reset when a turn stops on a usage limit. */
  private rateLimits: RateLimitSnapshot | null = null;
  /** Turns currently listening for notifications. */
  private turnsInFlight = 0;
  /** Thread-less notices (`configWarning`, `deprecationNotice`) that arrived
   *  while no turn was listening, held for the next turn to show. Codex sends
   *  them at spawn, which happens before the first turn attaches. */
  private readonly heldNotices: AgentEvent[] = [];
  /** Workspace threads and their settings (see {@link configureWorkspace}).
   *  In memory only: a host re-applies them after a restart. Every load of one
   *  of these threads, and every turn on it, carries the overrides. */
  private readonly workspaceThreads = new Map<string, WorkspaceSettings>();
  /** Each workspace thread's permission profile id (see
   *  {@link writeWorkspaceProfile}), absent where this Codex has no profiles and
   *  the legacy sandbox applies. */
  private readonly workspaceProfiles = new Map<string, string>();
  /** The workspace steering a thread's next turn opens with, cleared once that
   *  turn completes. A resume's `developerInstructions` reaches only a thread
   *  whose rollout is new: an existing one keeps the developer message it
   *  started with (seen live on codex 0.163). */
  private readonly workspaceIntros = new Map<string, string>();
  /** The sizes each thread's compactions leave out (see {@link CompactionSizes}). */
  private readonly compactions = new CompactionSizes();
  /** Each thread's MCP servers and opt-in tools, from `startThread` or
   *  `resumeThread`. Sent again on every load (see `codex/thread-config.ts`). */
  private readonly setups = new Map<string, ThreadSetup>();
  /** The subagents of each thread's running turn, for Stop. */
  private readonly turnSubagents = new Map<string, CodexSubagents>();
  /** Every subagent child each thread's turns started (see {@link CodexSubagents}). */
  private readonly subagentLineage = new Map<string, Set<string>>();

  constructor(opts: CodexAgentProviderOptions) {
    const { turnTimeoutMs, idleSweepMs, idleUnloadMs, codexHome, userCodexHome, subagent, env, ...clientOpts } = opts;
    if (!codexHome) throw new Error("CodexAgentProvider needs a dedicated codexHome");
    this.codexHome = codexHome;
    this.userCodexHome = userCodexHome;
    this.subagentRole = subagent ? checkSubagentRole(subagent) : undefined;
    this.execEnv = { ...env, CODEX_HOME: codexHome };
    this.client = new CodexClient({ ...clientOpts, env: this.execEnv });
    this.clock = new TimeoutClock(this.client);
    this.idleSweepMs = idleSweepMs ?? 5 * 60_000;
    this.idleUnloadMs = idleUnloadMs ?? 30 * 60_000;
    // A dead app-server has nothing loaded to sweep; the next start re-arms it.
    this.client.on("exit", () => this.stopIdleSweep());
    // `configWarning` fires when the app-server loads its config, usually at
    // spawn, before any turn's listener is attached. It is logged here and,
    // like `deprecationNotice`, held for the next turn when none is listening.
    // Usage pushes merge into the snapshot a usage-limit stop reads.
    this.client.on("notification", (n: ServerNotification) => {
      if (n.method === "configWarning" && n.params.path == null) {
        console.info(`[muxi-agent:codex] config notice: ${n.params.summary}`);
      } else if (n.method === "configWarning") {
        console.warn(
          `[muxi-agent:codex] invalid config, app-server running on DEFAULTS (managed settings ` +
            `and MCP servers dropped): ${n.params.summary}`,
        );
      }
      if ((n.method === "configWarning" || n.method === "deprecationNotice") && this.turnsInFlight === 0) {
        const ev = notificationToEvent(n);
        const same = (e: AgentEvent) =>
          e.type === "error.raised" && ev?.type === "error.raised" && e.message === ev.message;
        if (ev && !this.heldNotices.some(same)) this.heldNotices.push(ev);
      }
      if (n.method === "thread/tokenUsage/updated") {
        const usage = notificationToEvent(n);
        if (usage?.type === "context.usage") this.compactions.noteUsage(usage.threadId, usage.usedTokens);
      }
      // Codex unloaded the thread itself; the next turn has to resume it.
      if (n.method === "thread/closed") this.liveThreads.delete(n.params.threadId);
      if (n.method === "account/rateLimits/updated" && isCodexBucket(n.params.rateLimits)) {
        this.rateLimits = mergeRateLimits(this.rateLimits, n.params.rateLimits);
      }
      // Codex settled a request without us (an interrupt, a server-side timeout,
      // another client). Nothing is left to answer, but our record still holds
      // the clock it paused — release it, or the thread stays paused.
      if (n.method === "serverRequest/resolved") {
        const { threadId, requestId } = n.params;
        for (const [id, entry] of this.pendingApprovals) {
          if (entry.threadId === threadId && String(entry.rawId) === String(requestId)) {
            void this.releaseApproval(id);
          }
        }
      }
    });
    this.codexBin = clientOpts.codexBin ?? "codex";
    this.turnTimeoutMs = turnTimeoutMs ?? 30 * 60_000;
  }

  /**
   * Binary, version, globally configured MCP servers (none, in the dedicated
   * home), and login.
   *
   * The login half comes from `account/read` over the app-server — the same
   * credentials a turn authenticates with, carrying the plan and email a Settings
   * row shows. `codex doctor` only ever answered "is auth configured", by fuzzy
   * string match, so it is skipped entirely when the protocol answered and kept
   * as the fallback for a codex too old to have the method.
   */
  async probe(): Promise<ProviderStatus> {
    this.prepareHome();
    const auth = await readCodexAccount({ codexBin: this.codexBin, env: this.execEnv });
    const r = await probe(this.codexBin, this.execEnv, { skipLoginCheck: auth !== null });
    return {
      id: this.id,
      found: r.found,
      binPath: r.path,
      version: r.version,
      loggedIn: auth ? auth.status === "authenticated" : r.loggedIn,
      // Neither check answered — don't let "couldn't tell" render as "signed out".
      ...(!auth && r.loginProbeFailed ? { loginUnknown: true } : {}),
      ...(auth ? { auth } : {}),
      // `codex logout` has shipped for as long as `codex login` has; the CLI is
      // the fallback whenever the app-server's `account/logout` isn't there.
      supportsLogout: r.found,
      appServerAvailable: r.appServerAvailable,
      mcpServers: r.mcpServers,
      errors: r.errors,
    };
  }

  /**
   * Start a thread: read-only, asking on request (so every MCP tool call and
   * elicitation reaches the host), with only its own MCP servers. A thread's
   * `effort` is sent on each of its turns that names none.
   */
  async startThread(input: StartThreadInput): Promise<Thread> {
    await this.ensureStarted();
    const setup: ThreadSetup = {
      mcpServers: input.mcpServers ?? {},
      webSearch: input.webSearch === true,
      subagents: input.subagents === true,
    };
    const params = {
      cwd: input.cwd,
      model: input.model,
      sandbox: "read-only",
      approvalPolicy: "on-request",
      baseInstructions: input.baseInstructions,
      developerInstructions: input.developerInstructions,
      config: threadConfig(setup, { workspace: false, subagentsAvailable: this.subagentRole != null }),
    } as ThreadStartParams;
    const res = (await this.client.threadStart(params)) as {
      thread: RawThread;
      model?: string | null;
    };
    const thread = toDomainThread(res.thread, res.model ?? input.model);
    this.setups.set(thread.id, setup);
    if (input.effort) this.efforts.set(thread.id, input.effort);
    this.markThreadLive(thread.id);
    return thread;
  }

  /** Each thread's sticky effort, for turns that name none. */
  private readonly efforts = new Map<string, string>();

  /** Record a thread as loaded into the running app-server (see {@link liveThreads}). */
  private markThreadLive(threadId: string): LiveThread {
    const live = this.liveThreads.get(threadId);
    if (live) {
      live.lastActiveAt = Date.now();
      return live;
    }
    const fresh = { lastActiveAt: Date.now(), busy: 0 };
    this.liveThreads.set(threadId, fresh);
    return fresh;
  }

  /**
   * Load `threadId` and hold it busy until the returned release runs, so the
   * idle sweep never unloads a thread mid-operation. Release is idempotent and
   * restarts the thread's idle clock.
   */
  private async holdThread(threadId: string): Promise<() => void> {
    // Counted from the start, so a retire can't stop the app-server under the resume.
    this.busyOps += 1;
    let live: LiveThread;
    try {
      await this.ensureStarted();
      live = await this.ensureThreadLive(threadId);
    } catch (err) {
      this.busyOps -= 1;
      this.retireIfIdle();
      throw err;
    }
    live.busy += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      live.busy -= 1;
      this.busyOps -= 1;
      live.lastActiveAt = Date.now();
      this.retireIfIdle();
    };
  }

  /** Run `op` with `threadId` loaded and held busy (see {@link holdThread}). */
  private async useThread<T>(threadId: string, op: () => Promise<T>): Promise<T> {
    const release = await this.holdThread(threadId);
    try {
      return await op();
    } finally {
      release();
    }
  }

  /**
   * Unload every thread idle for {@link idleUnloadMs} with `thread/unsubscribe`.
   * A thread that is busy or has a question waiting on a human stays. The entry
   * goes before the request, so a turn arriving mid-unload resumes the thread,
   * after waiting for the unload to land (see {@link ensureThreadLive}).
   */
  private sweepIdleThreads(): void {
    if (!this.started || !this.client.isRunning) return;
    const cutoff = Date.now() - this.idleUnloadMs;
    for (const [threadId, live] of this.liveThreads) {
      if (live.busy > 0 || live.lastActiveAt > cutoff) continue;
      if ([...this.pendingApprovals.values()].some((p) => p.threadId === threadId)) continue;
      void this.unloadThread(threadId, "idle");
    }
  }

  /** Unload a thread with `thread/unsubscribe`; its next use resumes it once
   *  the unload landed (see {@link ensureThreadLive}). */
  private unloadThread(threadId: string, why: string): Promise<void> {
    this.liveThreads.delete(threadId);
    const done: Promise<void> = this.client
      .request("thread/unsubscribe", { threadId })
      .then(
        () => {},
        (err: unknown) => console.warn(`[muxi-agent:codex] could not unload ${why} thread ${threadId}: ${errorMessage(err)}`),
      )
      .finally(() => {
        if (this.unloading.get(threadId) === done) this.unloading.delete(threadId);
      });
    this.unloading.set(threadId, done);
    return done;
  }

  private stopIdleSweep(): void {
    if (this.idleSweep) clearInterval(this.idleSweep);
    this.idleSweep = null;
  }

  /**
   * Stop the running app-server once no thread is busy, so the next request
   * spawns a fresh one. A Codex CLI upgraded underneath keeps serving from the
   * old binary, with the old config, until its app-server is replaced.
   */
  retireAppServer(): void {
    if (!this.client.isRunning) return;
    this.retiring = true;
    this.retireIfIdle();
  }

  private retireIfIdle(): void {
    if (!this.retiring || this.busyOps > 0) return;
    this.retiring = false;
    void this.stop();
  }

  /**
   * List the models Codex's active login/subscription exposes (`model/list`),
   * paging through the cursor. We drop only `hidden` models (the ones the
   * app-server returns but never surfaces in any picker); removed models simply
   * don't come back from `model/list` at all. Superseded-but-usable models —
   * those carrying a non-null `upgrade` pointer to a successor (e.g. gpt-5.4 →
   * gpt-5.5) — are kept on purpose, so a user can still pin an older model, and
   * flagged `superseded` so the picker can hide them by default. Normalized to the transport-agnostic {@link AgentModel}; the concrete
   * catalog is never hardcoded here. Returned in picker order, with the default
   * re-pointed at our preference (see {@link pickerModels}).
   */
  async listModels(): Promise<AgentModel[]> {
    await this.ensureStarted();
    const models: Model[] = [];
    let cursor: string | null = null;
    do {
      const res = await this.client.modelList(cursor ? { cursor } : {});
      models.push(...res.data);
      cursor = res.nextCursor;
    } while (cursor);
    const visible = models.filter((m) => !m.hidden);
    for (const m of visible) {
      const scale = effortScale(m);
      // Keyed by both handles: a turn's `model` is whichever one the picker row
      // carried (catalog id or wire slug).
      this.modelEfforts.set(m.id, scale);
      this.modelEfforts.set(m.model, scale);
    }
    return pickerModels(visible);
  }

  /**
   * Clamp a requested effort to what `model` supports (see {@link clampEffort}).
   * Passes the request through untouched when we have no catalog for the model
   * yet (`model/list` not called in this process, or a turn with no explicit
   * model) — Codex then applies its own default.
   */
  private resolveEffort(
    model: string | undefined,
    requested: string | undefined,
  ): string | undefined {
    if (!requested || !model) return requested;
    return clampEffort(this.modelEfforts.get(model), requested);
  }

  /**
   * Read the subscription's rate-limit windows straight from the app-server
   * (`account/rateLimits/read`), a typed, in-protocol call that costs no quota,
   * as the normalized {@link ProviderUsage} (see {@link codexUsage}). Returns
   * `null` when the active login can't report limits, so the caller hides the
   * indicator.
   */
  async getUsage(): Promise<ProviderUsage | null> {
    await this.ensureStarted();
    const res = (await this.client.request(
      "account/rateLimits/read",
      undefined,
    )) as GetAccountRateLimitsResponse;
    // A read is the whole picture, so it replaces the snapshot; only the
    // sparse pushes merge.
    this.rateLimits = codexBucket(res);
    return codexUsage(this.rateLimits, this.id);
  }

  /** A usage-limit error restated with the window that ran out and its reset,
   *  when the usage snapshot shows one exhausted. */
  private withUsageWindow(ev: AgentEvent): AgentEvent {
    if (ev.type !== "error.raised" || ev.code !== "usage_limit") return ev;
    const message = codexUsageLimitMessage(this.rateLimits);
    return message ? { ...ev, message } : ev;
  }

  /** Run a structured helper request without chat history, workspace tools, or
   * persistence. The model is explicit so utility work follows the source turn. */
  async runUtilityTurn(input: UtilityTurnInput): Promise<UtilityTurnResult> {
    await this.ensureStarted();
    const startedAt = Date.now();
    const params = utilityThreadParams(input);
    const response = (await this.client.threadStart(params)) as {
      thread: RawThread;
      model?: string | null;
    };
    const thread = toDomainThread(response.thread, response.model ?? input.model);
    this.markThreadLive(thread.id);

    const completed: string[] = [];
    // Codex reports the turn's token counts on `thread/tokenUsage/updated`; the
    // holder is what carries them out of the stream's callback.
    const usage: { last: TokenUsageBreakdown | null } = { last: null };
    try {
      for await (const event of this.sendTurnInternal(
        thread.id,
        { text: input.prompt, model: input.model, ...(input.effort ? { effort: input.effort } : {}) },
        {
          outputSchema: input.outputSchema as JsonValue,
          summary: "none",
          timeoutMs: input.timeoutMs,
          showsNotices: false,
          onTokenUsage: (u) => {
            usage.last = u;
          },
        },
      )) {
        if (event.type === "agent.message.completed") completed.push(event.text);
        if (event.type === "approval.requested") {
          // A utility thread has no tools; fail closed if an upstream regression
          // nevertheless asks to execute one.
          await this.resolveApproval(event.request.requestId, { action: "decline" }).catch(() => {});
        }
      }
    } finally {
      // The ephemeral thread is single-use: forget it, and unload it from the
      // app-server, so neither grows by one thread per title generation. The
      // token maps are cleared after the unsubscribe, which ends its usage reports.
      this.liveThreads.delete(thread.id);
      await this.client.request("thread/unsubscribe", { threadId: thread.id }).catch((err: unknown) => {
        console.warn(`[muxi-agent:codex] could not unsubscribe utility thread ${thread.id}: ${errorMessage(err)}`);
      });
      this.compactions.forget(thread.id);
    }
    const text = completed[completed.length - 1]?.trim() ?? "";
    let output: unknown = text;
    try {
      output = JSON.parse(text);
    } catch {
      /* structured-output failures are validated by the orchestrator */
    }
    return {
      output,
      text,
      durationMs: Date.now() - startedAt,
      ...(usage.last
        ? { inputTokens: usage.last.inputTokens, outputTokens: usage.last.outputTokens }
        : {}),
    };
  }

  /**
   * Re-point a thread at its workspace root. Codex reads a thread's tools,
   * sandbox, developer instructions and config when it LOADS the thread, so a
   * loaded thread is unloaded (`thread/unsubscribe`) and loaded again with the
   * workspace overrides (see `workspaceResumeOverrides`); a thread that isn't
   * loaded picks them up on its next load. Every workspace turn also carries
   * the root as cwd and the workspace sandbox (see {@link sendTurn}).
   */
  async configureWorkspace(threadId: string, settings: WorkspaceSettings): Promise<void> {
    if ((this.liveThreads.get(threadId)?.busy ?? 0) > 0) {
      throw new Error(`thread ${threadId} is busy; workspace mode applies once its turn ends`);
    }
    // Codex works a workspace through its shell, so a thread with the web can't have one: the
    // two together would let what the web says run commands. Refused, not silently narrowed.
    if (this.setups.get(threadId)?.webSearch) throw new Error(CODEX_WEB_AND_SHELL);
    // A failed switch leaves the thread exactly as it was.
    const prior = { settings: this.workspaceThreads.get(threadId), intro: this.workspaceIntros.get(threadId) };
    await this.ensureStarted();
    const profile = await writeWorkspaceProfile(this.client, threadId, settings);
    if (profile) this.workspaceProfiles.set(threadId, profile);
    else this.workspaceProfiles.delete(threadId);
    this.workspaceThreads.set(threadId, settings);
    if (settings.introduce) this.workspaceIntros.set(threadId, settings.instructions);
    try {
      if (!this.liveThreads.has(threadId)) return;
      this.liveThreads.delete(threadId);
      await this.client.request("thread/unsubscribe", { threadId });
      await this.threadResumeRaw(threadId);
      this.markThreadLive(threadId);
    } catch (err) {
      if (prior.settings) this.workspaceThreads.set(threadId, prior.settings);
      else this.workspaceThreads.delete(threadId);
      if (prior.intro) this.workspaceIntros.set(threadId, prior.intro);
      else this.workspaceIntros.delete(threadId);
      throw err;
    }
  }

  /**
   * Resume a thread. Codex keeps a thread's instructions, model and cwd in its
   * own rollout, but not its MCP servers or opt-in tools: those come from the
   * persisted {@link ResumeThreadState}, and are sent on every load.
   */
  async resumeThread(threadId: string, state?: ResumeThreadState): Promise<Thread> {
    if (state?.webSearch && this.workspaceThreads.has(threadId)) throw new Error(CODEX_WEB_AND_SHELL);
    if (state?.mcpServers || state?.webSearch != null || state?.subagents != null) {
      const prior = this.setups.get(threadId) ?? EMPTY_SETUP;
      this.setups.set(threadId, {
        mcpServers: state.mcpServers ?? prior.mcpServers,
        webSearch: state.webSearch ?? prior.webSearch,
        subagents: state.subagents ?? prior.subagents,
      });
    }
    if (state?.effort) this.efforts.set(threadId, state.effort);
    await this.ensureStarted();
    // A thread this process already holds must reload to pick up the setup.
    if (this.liveThreads.has(threadId) && (this.liveThreads.get(threadId)?.busy ?? 0) === 0) {
      await this.unloadThread(threadId, "resumed");
    }
    const res = await this.threadResumeRaw(threadId);
    const thread = toDomainThread(res.thread, res.model);
    this.markThreadLive(thread.id);
    return thread;
  }

  /** `thread/resume` for metadata only, with the thread's config and a
   *  workspace thread's overrides (see `resumeThreadRaw`). */
  private async threadResumeRaw(threadId: string): Promise<{ thread: RawThread; model?: string | null }> {
    const workspace = this.workspaceThreads.get(threadId);
    const overrides = workspaceResumeOverrides(workspace, this.workspaceProfiles.get(threadId));
    const config = {
      ...threadConfig(this.setups.get(threadId) ?? EMPTY_SETUP, {
        workspace: workspace != null,
        subagentsAvailable: this.subagentRole != null,
      }),
      ...(overrides.config ?? {}),
    };
    return resumeThreadRaw(this.client, threadId, { ...overrides, config });
  }

  /**
   * Drop the last `numTurns` turns from a thread. The thread must be live, so we
   * resume it on demand first. Codex truncates its own on-disk history; reverting
   * any committed side effects is the caller's job. The thread is reloaded in
   * place under the same id, so nothing for the caller to persist.
   *
   * `thread/revert` keeps the history strictly before `beforeTurnId`, so dropping
   * the last N turns means reverting to before the Nth-newest turn. It needs the
   * paginated history Codex 0.151+ gives every new thread, so this needs Codex
   * 0.151 or newer (0.156 removed the older `thread/rollback`).
   */
  async rollbackThread(threadId: string, numTurns: number): Promise<RollbackResult> {
    if (!Number.isInteger(numTurns) || numTurns < 1) {
      throw new InvalidRollbackError(`numTurns must be an integer >= 1 (got ${numTurns})`);
    }
    return this.useThread(threadId, async () => {
      const beforeTurnId = await nthNewestTurnId(this.client, threadId, numTurns);
      if (beforeTurnId === null) {
        throw new InvalidRollbackError(`thread ${threadId} has no turns to roll back`);
      }
      await this.client.request("thread/revert", { threadId, beforeTurnId });
      return {};
    });
  }

  /**
   * Fork a thread into a fresh thread carrying its history (Codex `thread/fork`).
   * The source must be live, so we resume it on demand first. The new thread id
   * is registered as live so a turn can run against it immediately.
   */
  async forkThread(
    threadId: string,
    opts?: { keepTurns?: number; totalTurns?: number },
  ): Promise<Thread> {
    const thread = await this.useThread(threadId, async () => {
      const res = (await this.client.request("thread/fork", { threadId, excludeTurns: true })) as {
        thread: RawThread;
        model?: string | null;
      };
      const fork = toDomainThread(res.thread, res.model);
      this.markThreadLive(fork.id);
      return fork;
    });
    // Point fork: the fork copies the whole rollout, so trim the tail off the
    // fresh fork down to the requested boundary (the source stays untouched).
    if (opts?.keepTurns != null && opts.totalTurns != null) {
      const drop = opts.totalTurns - opts.keepTurns;
      if (drop > 0) await this.rollbackThread(thread.id, drop);
    }
    return thread;
  }

  /**
   * Make sure `threadId` is loaded into the running app-server before a turn.
   * No-op if it was started/resumed in this process; otherwise resumes it from
   * Codex's on-disk store. This is what lets a user continue a conversation
   * after a server restart instead of hitting `-32600: thread not found`, and
   * what brings back a thread the idle sweep unloaded, once its unload landed.
   */
  private async ensureThreadLive(threadId: string): Promise<LiveThread> {
    await this.unloading.get(threadId);
    const live = this.liveThreads.get(threadId);
    if (live) return live;
    await this.threadResumeRaw(threadId);
    return this.markThreadLive(threadId);
  }

  async *sendTurn(threadId: string, input: TurnInput): AsyncIterable<AgentEvent> {
    // A per-turn endpoint would need a new app-server config each turn; refused, so a host that
    // relies on rotating it never silently gets the thread's endpoint instead.
    if (input.mcpServers) {
      throw new Error('Codex turns can\'t replace their MCP servers per turn ("mcpServers" on a turn is Claude only).');
    }
    // Auto mode is Claude Code's classifier. Codex's own auto review only judges sandbox
    // escalations, and the host never sees the calls it allows, so it is refused, not mapped.
    if (input.permissionMode === "auto") {
      throw new Error('Codex turns can\'t run in auto mode ("permissionMode": "auto" is Claude only).');
    }
    // A thread's effort is sticky: a turn that names none keeps the last one.
    if (input.effort) this.efforts.set(threadId, input.effort);
    const effort = input.effort ?? this.efforts.get(threadId);
    yield* this.sendTurnInternal(
      threadId,
      { ...input, ...(effort ? { effort } : {}) },
      {
        started: {
          provider: "codex",
          prompt: userPrompt(input),
          ...(input.model ? { model: input.model } : {}),
          ...(effort ? { effort } : {}),
          ...(input.serviceTier !== undefined ? { serviceTier: input.serviceTier } : {}),
          ...(input.trigger ? { trigger: input.trigger } : {}),
        },
      },
    );
  }

  private async *sendTurnInternal(
    threadId: string,
    input: TurnInput,
    options: CodexTurnOptions = {},
  ): AsyncIterable<AgentEvent> {
    const release = await this.holdThread(threadId);
    const showsNotices = options.showsNotices ?? true;
    const turn = new CodexTurn(
      threadId,
      {
        decorate: (ev) => this.compactions.decorate(this.withUsageWindow(ev)),
        interrupt: (turnId) => this.interrupt(threadId, turnId),
        takeHeldNotices: () => this.heldNotices.splice(0),
      },
      options,
    );

    const onNotification = (n: ServerNotification) => turn.onNotification(n);
    // Approvals this turn raised, so its teardown can release the ones the UI
    // never answered (see the `finally` below).
    const ownApprovals = new Set<string>();
    const workspaceMode = this.workspaceThreads.has(threadId);
    const onApproval = (req: ServerRequest) => {
      // Every running turn hears every request. Another chat's is that chat's
      // to answer: read here, a workspace request would look unsupported and be
      // rejected before its own turn could surface it.
      const owner = requestThreadId(req);
      const child = owner != null && owner !== threadId ? owner : null;
      if (child && !turn.subagents?.isChild(child)) return;
      const request = requestToApproval(req, {
        workspaceMode,
        fileChanges: (itemId) => turn.fileChanges.get(itemId),
      });
      if (!request) {
        void this.client
          .rejectServerRequest(req.id, {
            code: -32601,
            message: `Unsupported Codex server request: ${req.method}`,
          })
          .catch(onClientError);
        return;
      }
      // Mint a UUID rather than reusing Codex's native (per-turn,
      // collision-prone) request id — see {@link pendingApprovals}.
      const approvalId = randomUUID();
      ownApprovals.add(approvalId);
      // The question is about to wait on a human: stop the thread's clock
      // until {@link resolveApproval} answers it.
      const requestThread = request.threadId ?? threadId;
      this.pendingApprovals.set(approvalId, {
        kind: request.kind,
        method: req.method,
        rawId: req.id,
        params: req.params,
        threadId: requestThread,
        paused: this.clock.pause(requestThread),
      });
      // A subagent's request is asked in the chat that started it, naming the
      // subagent. A child that was never let run is declined unseen.
      const subagent = child ? turn.subagents?.subagentRef(child) : null;
      if (child && !subagent) return void this.resolveApproval(approvalId, { action: "decline" }).catch(() => {});
      // A workspace call the hard refusals catch is declined unseen, as the
      // Claude provider's hook does; the host sees every other one.
      const workspace = this.workspaceThreads.get(threadId);
      const refused =
        workspace && (request.kind === "command" || request.kind === "fileChange") ? workspace.refusal(request) : null;
      if (refused) {
        return void this.resolveApproval(approvalId, { action: "decline", reason: refused }).catch(() => {});
      }
      const asked = subagent ? { threadId, turnId: turn.activeTurnId ?? request.turnId, subagent } : {};
      turn.push({ type: "approval.requested", request: { ...request, requestId: approvalId, ...asked } });
    };
    const onClientError = (err: Error) => turn.onClientError(err);
    const onExit = (code: number | null) => turn.onExit(code, this.client.stderrTail);

    const lineage = this.subagentLineage.get(threadId) ?? new Set<string>();
    this.subagentLineage.set(threadId, lineage);
    turn.subagents = new CodexSubagents(
      threadId,
      (ev) => turn.push(ev),
      this.subagentsAllowed(threadId),
      (child, childTurn) => this.interrupt(child, childTurn),
      // No steer id, so the note never shows as the user's message.
      (text) =>
        turn.activeTurnId && !turn.queue.done
          ? this.client.turnSteer(
              { threadId, input: [{ type: "text", text, text_elements: [] }], expectedTurnId: turn.activeTurnId },
              STEER_TIMEOUT_MS,
            )
          : undefined,
      lineage,
      this.subagentRole?.role,
    );
    this.turnSubagents.set(threadId, turn.subagents);
    this.client.on("notification", onNotification);
    if (showsNotices) this.turnsInFlight += 1;
    this.client.on("approval", onApproval);
    this.client.on("error", onClientError);
    this.client.on("exit", onExit);

    const timeoutMs = options.timeoutMs ?? this.turnTimeoutMs;
    const timer = setTimeout(() => turn.onTimeout(timeoutMs), timeoutMs);

    try {
      const params = turnStartParams({
        threadId,
        input,
        intro: this.workspaceIntros.get(threadId),
        effort: this.resolveEffort(input.model, input.effort),
        options,
        workspace: this.workspaceThreads.get(threadId),
        profile: this.workspaceProfiles.get(threadId),
      });
      const started = (await this.client.turnStart(params)) as { turn?: { id?: string } };
      turn.activeTurnId = started.turn?.id ?? turn.activeTurnId;

      const { queue } = turn;
      for (;;) {
        for (let ev = queue.shift(); ev; ev = queue.shift()) yield ev;
        if (queue.done) {
          if (queue.failure) throw queue.failure;
          this.workspaceIntros.delete(threadId);
          return;
        }
        await queue.wait();
      }
    } finally {
      clearTimeout(timer);
      if (this.turnSubagents.get(threadId) === turn.subagents) this.turnSubagents.delete(threadId);
      this.client.removeListener("notification", onNotification);
      if (showsNotices) this.turnsInFlight -= 1;
      this.client.removeListener("approval", onApproval);
      this.client.removeListener("error", onClientError);
      this.client.removeListener("exit", onExit);
      // Release any approvals the UI never answered (a stopped or failed turn):
      // Codex holds the request open until it gets a reply, and our entry would
      // outlive the turn that could still route one. Decline them here.
      for (const id of ownApprovals) {
        if (!this.pendingApprovals.has(id)) continue;
        try {
          await this.resolveApproval(id, { action: "decline" });
        } catch (err) {
          // The app-server may already be gone; the record must go either way.
          await this.releaseApproval(id);
          console.warn(`[muxi-agent:codex] could not decline approval ${id} at turn end: ${errorMessage(err)}`);
        }
      }
      release();
    }
  }

  async resolveApproval(
    requestId: number | string,
    decision: ApprovalDecision,
  ): Promise<void> {
    const pending = this.pendingApprovals.get(String(requestId));
    if (!pending) {
      throw new PendingApprovalNotFoundError(requestId);
    }
    const wire = decisionToWireForRequest(pending.method, decision, pending.params);
    // Reply with Codex's original-typed id, not the stringified round-trip.
    await this.client.resolveApproval(pending.rawId, wire);
    // After the reply, so the tool result is already on its way when the clock
    // the question paused starts again.
    await this.releaseApproval(String(requestId));
  }

  /**
   * Forget a pending approval and restart the clock it paused. The one exit for
   * every way a request ends: answered by the UI ({@link resolveApproval}),
   * declined at turn teardown, or settled by codex itself
   * (`serverRequest/resolved`). Idempotent: the record goes before the resume
   * is awaited, so two callers racing on one request decrement once.
   */
  private async releaseApproval(id: string): Promise<void> {
    const pending = this.pendingApprovals.get(id);
    if (!pending) return;
    this.pendingApprovals.delete(id);
    if (await pending.paused) await this.clock.resume(pending.threadId);
  }

  /**
   * Codex folds a steered message into the running turn: `turn/steer` takes the
   * same `UserInput` items as `turn/start` plus `expectedTurnId`, and the
   * app-server refuses the call when that is not the active turn (or when the
   * turn is a kind it can't steer — a review or a compaction, which it reports
   * as `activeTurnNotSteerable`). The method is NOT behind the `experimentalApi`
   * capability: this client declares none and the app-server still dispatches it
   * (it answers a bogus thread id with `thread not found`, the same as
   * `turn/interrupt`, rather than rejecting the method).
   */
  readonly supportsSteer = true;
  /** A steer comes back as a `userMessage` item tagged with its
   *  `clientUserMessageId` once the model is handed it (see normalize.ts). */
  readonly reportsSteerRead = true;

  async steerTurn(threadId: string, turnId: string, text: string, steerId?: string): Promise<void> {
    await this.useThread(threadId, () =>
      this.client.turnSteer(
        {
          threadId,
          input: [{ type: "text", text, text_elements: [] }],
          expectedTurnId: turnId,
          ...(steerId ? { clientUserMessageId: steerId } : {}),
        },
        STEER_TIMEOUT_MS,
      ),
    );
  }

  async interrupt(threadId: string, turnId: string): Promise<void> {
    // If the app-server is already gone there's no turn to interrupt — the turn
    // ends on its own via the `exit` path in `sendTurn`. Writing to dead stdin
    // would throw "App-server stdin not writable"; no-op instead.
    if (!this.client.isRunning) return;
    // Interrupting the main agent leaves its children running, so each one is
    // interrupted too.
    this.turnSubagents.get(threadId)?.stopAll("interrupted");
    await this.client.request("turn/interrupt", { threadId, turnId });
  }

  async stopSubagent(threadId: string, subagentId: string): Promise<boolean> {
    return this.turnSubagents.get(threadId)?.stop(subagentId) ?? false;
  }

  /** Unload a single-use thread from the app-server, as a utility thread is
   *  (see {@link runUtilityTurn}): the token maps are cleared after the
   *  unsubscribe, which ends its usage reports. */
  async releaseThread(threadId: string): Promise<void> {
    const loaded = this.liveThreads.delete(threadId);
    if (loaded && this.client.isRunning) {
      await this.client.request("thread/unsubscribe", { threadId }).catch((err: unknown) => {
        console.warn(`[muxi-agent:codex] could not unsubscribe released thread ${threadId}: ${errorMessage(err)}`);
      });
    }
    this.compactions.forget(threadId);
    this.setups.delete(threadId);
    this.efforts.delete(threadId);
    this.workspaceThreads.delete(threadId);
    this.workspaceProfiles.delete(threadId);
    this.workspaceIntros.delete(threadId);
  }

  /** Whether a thread's turns may have subagents: it asked for them, it is not
   *  in workspace mode, and the provider has a role to run them as. */
  private subagentsAllowed(threadId: string): boolean {
    return (
      this.subagentRole != null &&
      this.setups.get(threadId)?.subagents === true &&
      !this.workspaceThreads.has(threadId)
    );
  }

  /** Write the dedicated home (see `codex/home.ts`). */
  private prepareHome(): void {
    prepareCodexHome({
      codexHome: this.codexHome,
      ...(this.userCodexHome ? { userCodexHome: this.userCodexHome } : {}),
      ...(this.subagentRole ? { subagent: this.subagentRole } : {}),
    });
  }

  /**
   * Subscribe to raw app-server stderr for diagnostics (protocol errors,
   * panics). Returns an unsubscribe function. Not part of the domain event
   * stream — intended for health checks and dev smoke tests.
   */
  onStderr(handler: (msg: string) => void): () => void {
    this.client.on("stderr", handler);
    return () => this.client.removeListener("stderr", handler);
  }

  /** Stop the underlying app-server process. */
  async stop(): Promise<void> {
    this.stopIdleSweep();
    await this.client.stop();
    this.started = false;
  }

  private async ensureStarted(): Promise<void> {
    // Reuse a live session. If the app-server died, `started` is stale but the
    // process is gone — `isRunning` catches that so the next thread/turn
    // transparently respawns it instead of throwing "stdin not writable".
    if (this.started && this.client.isRunning) return;
    // Coalesce concurrent starts onto one spawn+initialize (see `startPromise`).
    if (this.startPromise) return this.startPromise;
    this.startPromise = (async () => {
      this.started = false;
      // Fresh process: nothing is loaded in memory yet. Drop the live set so
      // sendTurn re-resumes threads lazily against the new app-server.
      this.liveThreads.clear();
      this.retiring = false;
      this.prepareHome();
      await this.client.start();
      await this.client.initialize();
      this.started = true;
      if (!this.idleSweep) {
        this.idleSweep = setInterval(() => this.sweepIdleThreads(), this.idleSweepMs);
        this.idleSweep.unref();
      }
    })();
    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }
}
