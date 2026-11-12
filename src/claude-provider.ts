/**
 * ClaudeAgentProvider: an {@link AgentProvider} backed by Claude Code through
 * the `@anthropic-ai/claude-agent-sdk` `query()` API. It sits behind the same
 * transport-agnostic seam as {@link CodexAgentProvider}, so a host drives both
 * with the same types.
 *
 * Models: the catalog comes from the CLI itself (`Query.supportedModels()`),
 * never hardcoded, each model with its own effort levels. Per-turn
 * `model`/`effort` overrides are honored and sticky for the thread, as on
 * Codex. Forking is native (SDK `forkSession`, point-aware via
 * `upToMessageId`), and rollback rides on the same call: the transcript is
 * append-only, so a rollback forks at the boundary and the thread points at the
 * fork from then on (its {@link ThreadState.sessionAlias}). Every chat turn's
 * prompt is a streaming-input {@link PromptChannel}, open until the turn's last
 * result, whose opening message carries the turn id as its client uuid; images
 * ride as base64 blocks after the text. A mid-turn message folds in through the
 * same channel ({@link ClaudeAgentProvider.steerTurn}).
 *
 * Streaming: chat turns run with `includePartialMessages`, so the SDK's raw
 * content-block deltas become `agent.message.delta` / `agent.reasoning.delta`
 * exactly as Codex emits them. The assembled assistant message still follows
 * and stays the authoritative `*.completed` text. Utility turns stay unstreamed.
 *
 * Isolation: the agent sees ONLY the thread's own MCP servers and none of the
 * machine's personal Claude config. The SDK otherwise inherits the local
 * environment, so every session runs with:
 *   - `settingSources: []`  → no ~/.claude or project settings, no CLAUDE.md
 *   - `settings: { autoMemoryEnabled: false }` → no auto-memory. It is on by
 *     default whatever `settingSources` says, and keys on the cwd's git root
 *   - `strictMcpConfig: true` → only the thread's `mcpServers`; ignore
 *     ~/.claude.json, plugins, agent frontmatter
 *   - `skills: []`, `plugins: []` → no skills or plugins loaded
 *   - `tools: [TaskCreate, TaskUpdate, TaskList, TaskGet, ToolSearch]` → every
 *     other built-in (Bash/Read/Edit/WebFetch/…) is disabled unless the thread
 *     asks for it (web search, subagents, workspace mode). The task tools are
 *     Claude's native plan, the counterpart of Codex's `update_plan`; they touch
 *     nothing outside the transcript, so they run unasked. They are incremental
 *     (create/update one task by id), so the provider keeps a per-thread
 *     accumulator and mirrors out the COMPLETE plan as `agent.plan.updated`
 *     after every change. `ToolSearch` only loads deferred MCP tools.
 *   - a custom `systemPrompt`  → the thread's own instructions, NOT the coding
 *     agent preset
 *
 * Stopping: a Stop and the turn timeout take the same graceful path: the CLI's
 * own `interrupt()` first, the abort only as a fallback. A Stop also states
 * itself on the turn as the non-fatal `interrupted` warning Codex emits.
 *
 * Transient trouble: the SDK's `api_retry` frames and model-refusal notices
 * become non-fatal warnings, and a turn that produced nothing but warnings
 * closes on the last of them restated as its failure (Codex's rule).
 *
 * Approvals: Codex pushes approvals as out-of-band JSON-RPC requests; Claude
 * asks through the `canUseTool` callback. Both become the same
 * `approval.requested` event and {@link ClaudeAgentProvider.resolveApproval}
 * round trip, with an MCP call's `detail` shaped like Codex's `mcp_tool_call`
 * confirmation so `mcpToolCallOf` reads both.
 */

import { randomUUID } from "node:crypto";

import type {
  AgentEvent,
  AgentModel,
  ApprovalDecision,
  ProviderStatus,
  ProviderUsage,
  StartThreadInput,
  Thread,
  ToolDenial,
  ToolInputDelta,
  TurnInput,
  TurnStreamEvent,
} from "./types/index.ts";
import type { EffortLevel, query, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

import type {
  AgentProvider,
  ApprovalRequestId,
  HistoryCut,
  ResumeThreadState,
  RollbackResult,
  UtilityTurnInput,
  ToolGuard,
  UtilityTurnResult,
  WorkspaceSettings,
} from "./provider.ts";
import { composeSystemPrompt, InvalidRollbackError } from "./provider.ts";
import { PendingApprovalNotFoundError, TurnOutput, TurnQueue, userPrompt } from "./shared.ts";
import { checkSubagentRole, SUBAGENT_TURN_ENDED, SubagentTracker, type SubagentRole } from "./subagents.ts";
import { probeClaude } from "./claude/auth.ts";
import { catalogModels, clampEffort, FALLBACK_MODEL, normalizeCatalog } from "./claude/catalog.ts";
import { chatTurnOptions, pumpTurn, type ThreadState } from "./claude/chat-turn.ts";
import type { TurnScope } from "./claude/events.ts";
import { subagentHooks, stopTurnSubagent, turnSubagents, type TurnSubagents } from "./claude/subagents.ts";
import { claudeResultOutcome } from "./claude/failures.ts";
import {
  elicitation,
  toolPermission,
  workspaceHooks,
  type ApprovalBridge,
  type PendingApproval,
} from "./claude/permissions.ts";
import { guardHooks, mergeHooks } from "./claude/hooks.ts";
import { PLAN_RESYNC_HINT, planHooks } from "./claude/plan.ts";
import {
  executableOption,
  ISOLATED_SETTINGS,
  loadSdk,
  SANDBOX_OFF,
  sdkExecutablePath,
  withIdleSession,
} from "./claude/sdk.ts";
import { turnMcpServers } from "./claude/tools.ts";
import { mcpSecrets, Redactor } from "./claude/redact.ts";
import { cutUuid, keptPrompts, readTranscript } from "./claude/transcript.ts";
import { clearEmptySession, sessionState, type SessionState } from "./claude/session-check.ts";
import {
  buildClaudeUserMessage,
  closeTurnInput,
  INTERRUPT_GRACE_MS,
  INTERRUPT_MESSAGE,
  isTerminalEvent,
  type LiveTurn,
  PromptChannel,
  stopTurn,
} from "./claude/turn.ts";
import { scrapeClaudeUsage, structuredClaudeUsage } from "./claude/usage.ts";

export interface ClaudeAgentProviderOptions {
  /** Working directory for a thread resumed without one. Defaults to the
   *  process cwd. */
  defaultCwd?: string;
  /** Per-turn timeout in ms before `sendTurn` fails (default 30 minutes). */
  turnTimeoutMs?: number;
  /** How long a turn may sit on a rejected rate limit with nothing else from
   *  the CLI before it ends as a usage-limit stop (default 20 seconds). */
  rateLimitParkMs?: number;
  /** Absolute path to a `claude` executable; defaults to the SDK's bundled CLI,
   *  else `claude` on PATH. */
  pathToClaudeCodeExecutable?: string;
  /** Test seam: replaces the SDK's `query()` so tests can capture the exact
   *  options sent and script the response without spawning a CLI. */
  queryFn?: typeof query;
  /** Test seam: the state of a cold thread's session ({@link sessionState} by default) and the
   *  clearing of an empty one. See claude/session-check.ts. */
  sessionCheck?: { state: (sessionId: string) => Promise<SessionState>; clear: (sessionId: string) => Promise<boolean> };
  /** Whether a message sent while a turn runs folds into it
   *  ({@link ClaudeAgentProvider.steerTurn}). On by default. */
  steer?: boolean;
  /** The subagent role. Without it no thread gets subagents, whatever it asks. */
  subagent?: SubagentRole;
  /** Tools whose input streams as transient `tool.input.delta` events while
   *  the model writes it (by the tool's name on its MCP server). Default none. */
  streamedInputTools?: Iterable<string>;
  /** The host's hard refusals for every tool call ({@link ToolGuard}). */
  guard?: ToolGuard;
}

export class ClaudeAgentProvider implements AgentProvider {
  readonly id = "claude" as const;

  private readonly defaultCwd: string;
  private readonly turnTimeoutMs: number;
  private readonly rateLimitParkMs: number;
  private readonly subagentRole: SubagentRole | undefined;
  private readonly streamedInputTools: ReadonlySet<string>;
  private readonly guard: ToolGuard | undefined;
  /** An explicit `claude` path from the caller, if any. Everything else is
   *  resolved per-call by `resolveClaudeExecutable`. */
  private readonly configuredPath: string | undefined;

  private readonly threads = new Map<string, ThreadState>();
  /** Catalog cache (`supportedModels()` spawns a CLI process: fetch once). */
  private modelCache: AgentModel[] | null = null;
  /** model id → its supported effort levels, filled alongside the catalog. */
  private readonly effortLevels = new Map<string, string[]>();
  /** The catalog row flagged default, once the catalog is fetched. */
  private defaultModelId: string | null = null;
  /** Live turns keyed by threadId, so {@link interrupt} can stop one gracefully
   *  (the CLI's own `interrupt()`) and say so on the turn. */
  private readonly liveTurns = new Map<string, LiveTurn>();
  /** Parked approvals keyed by a random UUID (the resolve handle). A UUID, not
   *  a counter, so ids from both providers can share one approvals table. */
  private readonly pending = new Map<string, PendingApproval>();

  private readonly queryFn: typeof query | undefined;
  private readonly sessionCheck: { state: (sessionId: string) => Promise<SessionState>; clear: (sessionId: string) => Promise<boolean> };

  /**
   * Whether a message sent mid-turn folds into the running turn. Every chat
   * turn's prompt is a {@link PromptChannel} held open until the turn's last
   * result; when this is on, {@link steerTurn} pushes onto it, and the CLI takes
   * the message between tool rounds and lists its uuid on that turn's result.
   */
  readonly supportsSteer: boolean;
  /** A steering turn runs with `--replay-user-messages`, whose echo of a
   *  steer is its read receipt. */
  readonly reportsSteerRead: boolean;

  constructor(opts: ClaudeAgentProviderOptions = {}) {
    this.defaultCwd = opts.defaultCwd ?? process.cwd();
    this.turnTimeoutMs = opts.turnTimeoutMs ?? 30 * 60_000;
    this.rateLimitParkMs = opts.rateLimitParkMs ?? 20_000;
    this.subagentRole = opts.subagent ? checkSubagentRole(opts.subagent) : undefined;
    this.streamedInputTools = new Set(opts.streamedInputTools ?? []);
    this.guard = opts.guard;
    this.configuredPath = opts.pathToClaudeCodeExecutable;
    this.queryFn = opts.queryFn;
    this.sessionCheck = opts.sessionCheck ?? { state: sessionState, clear: clearEmptySession };
    this.supportsSteer = opts.steer ?? true;
    this.reportsSteerRead = this.supportsSteer;
  }

  /** The executable to hand the SDK (see {@link sdkExecutablePath}). */
  private get executablePath(): string | undefined {
    return sdkExecutablePath(this.configuredPath);
  }

  /** Binary, version, login and sign-out support (see {@link probeClaude}). */
  probe(): Promise<ProviderStatus> {
    return probeClaude({ id: this.id, configuredPath: this.configuredPath, queryFn: this.queryFn });
  }

  /**
   * The CLI's live model catalog (`Query.supportedModels()`), normalized to
   * {@link AgentModel} — never hardcoded, so it tracks whatever the user's
   * login/subscription offers. `supportedModels()` only exists on a live query,
   * so we boot a streaming-input session that never sends a message, ask it,
   * and abort — no turn runs. Cached for the process lifetime; a failed fetch
   * isn't cached, so the next call retries.
   */
  async listModels(): Promise<AgentModel[]> {
    if (this.modelCache) return this.modelCache;
    const infos = await withIdleSession(this.queryFn, this.executablePath, (q) => q.supportedModels());
    const normalized = normalizeCatalog(infos);
    for (const m of normalized) {
      this.effortLevels.set(m.id, m.efforts);
    }
    this.modelCache = catalogModels(normalized);
    this.defaultModelId = this.modelCache.find((m) => m.isDefault)?.id ?? null;
    return this.modelCache;
  }

  /** Model for a thread with no selection: the flagged catalog default once we've
   *  fetched the catalog, else the evergreen {@link FALLBACK_MODEL} alias. */
  private get defaultModel(): string {
    return this.defaultModelId ?? FALLBACK_MODEL;
  }

  /**
   * Subscription usage, structured first: the SDK's experimental usage control
   * call returns the data behind `/usage` as fields (plan label, per-window
   * utilization, ISO reset instants) instead of the prose the CLI prints. It is
   * flagged unstable upstream, so the `/usage` scrape ({@link scrapeClaudeUsage})
   * stays as the fallback for a call that throws (older CLI, renamed method) or
   * answers with nothing usable (`rate_limits_available: false`, e.g. API-key
   * billing).
   */
  async getUsage(): Promise<ProviderUsage | null> {
    try {
      const res = await withIdleSession(this.queryFn, this.executablePath, async (q) => {
        const read = (
          q as unknown as {
            usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET?: () => Promise<unknown>;
          }
        ).usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET;
        return typeof read === "function" ? await read.call(q) : null;
      });
      const usage = structuredClaudeUsage(res, this.id);
      if (usage) return usage;
    } catch {
      /* fall through to the `/usage` scrape */
    }
    return scrapeClaudeUsage(this.configuredPath, this.id);
  }

  /** Structured one-shot helper with no Claude Code tools, MCP, settings, or
   * persisted session. Uses the exact model selected by the source chat turn. */
  async runUtilityTurn(input: UtilityTurnInput): Promise<UtilityTurnResult> {
    const controller = new AbortController();
    const startedAt = Date.now();
    const effort = this.resolveEffort(input.model, input.effort);
    const q = (this.queryFn ?? (await loadSdk()).query)({
      prompt: input.prompt,
      options: {
        model: input.model,
        ...(effort ? { effort } : {}),
        thinking: { type: "disabled" },
        systemPrompt: input.systemInstructions,
        cwd: input.cwd,
        abortController: controller,
        settingSources: [],
        settings: ISOLATED_SETTINGS,
        strictMcpConfig: true,
        skills: [],
        tools: [],
        mcpServers: {},
        persistSession: false,
        maxTurns: 1,
        permissionMode: "dontAsk",
        sandbox: SANDBOX_OFF,
        outputFormat: { type: "json_schema", schema: input.outputSchema },
        ...executableOption(this.executablePath),
      },
    });
    const timer = setTimeout(() => controller.abort(), input.timeoutMs);
    let output: unknown;
    let text = "";
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;
    try {
      for await (const msg of q) {
        if (msg.type === "assistant") {
          for (const block of msg.message?.content ?? []) {
            if (block.type === "text") text = block.text;
          }
        }
        if (msg.type === "result") {
          const outcome = claudeResultOutcome(msg);
          if (outcome.kind === "failed") {
            throw new Error(`Claude utility turn failed: ${outcome.message}`);
          }
          // `subtype` narrows the message for `structured_output` below.
          if (outcome.kind === "interrupted" || msg.subtype !== "success") {
            throw new Error("Claude utility turn was interrupted");
          }
          output = msg.structured_output;
          text = msg.result || text;
          inputTokens =
            msg.usage.input_tokens +
            (msg.usage.cache_read_input_tokens ?? 0) +
            (msg.usage.cache_creation_input_tokens ?? 0);
          outputTokens = msg.usage.output_tokens;
        }
      }
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
    // A success without `structured_output` is a failure (Agent SDK structured
    // outputs guide): the reply text never stands in for the schema.
    if (output === undefined) throw new Error("Claude utility turn returned no structured output");
    return {
      output,
      text,
      durationMs: Date.now() - startedAt,
      ...(inputTokens !== undefined ? { inputTokens } : {}),
      ...(outputTokens !== undefined ? { outputTokens } : {}),
    };
  }

  async startThread(input: StartThreadInput): Promise<Thread> {
    const threadId = randomUUID();
    const systemPrompt = composeSystemPrompt(
      input.baseInstructions,
      input.developerInstructions,
    );
    this.threads.set(threadId, {
      cwd: input.cwd,
      systemPrompt,
      fresh: true,
      plan: new Map(),
      planAliases: new Map(),
      ...(input.model ? { model: input.model } : {}),
      ...(input.effort ? { effort: input.effort } : {}),
      ...(input.mcpServers ? { mcpServers: input.mcpServers } : {}),
      ...(input.webSearch ? { webSearch: true } : {}),
      ...(input.subagents ? { subagents: true } : {}),
      ...(input.askUser ? { askUser: true } : {}),
    });
    return this.threadOf(threadId);
  }

  private threadOf(threadId: string): Thread {
    const state = this.threads.get(threadId);
    return {
      id: threadId,
      cwd: state?.cwd ?? this.defaultCwd,
      status: "idle",
      model: state?.model ?? this.defaultModel,
      provider: this.id,
    };
  }

  /**
   * Resume a thread, rehydrating the state the SDK doesn't keep for us: the
   * session the thread points at (an edit forks it), its steering, and its cwd.
   * Anything the caller can't supply keeps the state we already hold (a thread
   * still live in this process) or the provider default.
   */
  async resumeThread(threadId: string, persisted?: ResumeThreadState): Promise<Thread> {
    const state = this.ensureThreadState(threadId);
    if (persisted?.providerSessionId) state.sessionAlias = persisted.providerSessionId;
    if (persisted?.systemPrompt) state.systemPrompt = persisted.systemPrompt;
    if (persisted?.effort) state.effort = persisted.effort;
    if (persisted?.cwd) state.cwd = persisted.cwd;
    if (persisted?.model) state.model = persisted.model;
    if (persisted?.mcpServers) state.mcpServers = persisted.mcpServers;
    if (persisted?.webSearch != null) state.webSearch = persisted.webSearch;
    if (persisted?.subagents != null) state.subagents = persisted.subagents;
    if (persisted?.askUser != null) state.askUser = persisted.askUser;
    return this.threadOf(threadId);
  }

  /**
   * Switch a thread into workspace mode. Its next turns run with the root as
   * cwd, the file tools and a sandboxed Bash (`workspaceSandbox`), every
   * native call routed to the host as an approval. A `--resume` of a session
   * from a new cwd keeps its history.
   *
   * Steering: the system prompt is snapshotted into the session transcript, so
   * a new prompt reaches the model only when the CLI renders it afresh (a new
   * session or a compaction). The new prompt is adopted for that, and on the
   * switch itself the workspace steering also rides once on the next turn's
   * message, which reaches the model at once and stays in the transcript.
   */
  async configureWorkspace(threadId: string, settings: WorkspaceSettings): Promise<void> {
    const state = this.ensureThreadState(threadId);
    state.cwd = settings.root;
    state.systemPrompt = settings.systemPrompt;
    state.workspace = {
      root: settings.root,
      refusal: settings.refusal,
      ...(settings.protectedPaths ? { protectedPaths: settings.protectedPaths } : {}),
      ...(settings.cacheDir ? { cacheDir: settings.cacheDir } : {}),
      ...(settings.network ? { network: true } : {}),
      ...(settings.shell === false ? { shell: false } : {}),
      ...(settings.introduce
        ? { pendingContext: settings.instructions }
        : state.workspace?.pendingContext
          ? { pendingContext: state.workspace.pendingContext }
          : {}),
    };
  }

  /**
   * Roll back the last `numTurns` turns (edit/rewind). Claude's transcript is
   * append-only, so we fork it at the boundary instead: the fork carries every
   * kept turn and nothing after, and becomes the session this thread points at
   * (its {@link ThreadState.sessionAlias}) — the external thread id is unchanged.
   * The new session id is returned so the caller persists it; without that a
   * restart would `resume` the pre-edit transcript. The boundary is located by
   * prompt ({@link keptPrompts}), since a steered turn can hold more than one.
   *
   * Rolling back every turn leaves nothing to fork: the thread resets to fresh on
   * a brand-new session id, which the next turn creates from scratch.
   */
  async rollbackThread(
    threadId: string,
    numTurns: number,
    opts?: Pick<HistoryCut, "steersPerTurn">,
  ): Promise<RollbackResult> {
    if (!Number.isInteger(numTurns) || numTurns < 1) {
      throw new InvalidRollbackError(
        `numTurns must be an integer >= 1 (got ${numTurns})`,
      );
    }
    const state = this.ensureThreadState(threadId);
    const sessionId = this.sdkSessionId(threadId);
    // A fresh thread has no session yet, so whatever the log says, nothing is kept.
    const transcript = state.fresh ? null : await readTranscript(sessionId);
    const keep = transcript ? keptPrompts(transcript, { dropTurns: numTurns }, opts?.steersPerTurn) : 0;
    if (!transcript || keep <= 0) {
      state.sessionAlias = randomUUID();
      state.fresh = true;
      state.plan = new Map();
      state.planResync = false;
      return { providerSessionId: state.sessionAlias };
    }
    const upToMessageId = cutUuid(transcript, keep);
    const { forkSession } = await loadSdk();
    const { sessionId: forked } = await forkSession(
      sessionId,
      upToMessageId ? { upToMessageId } : {},
    );
    state.sessionAlias = forked;
    state.fresh = false;
    return { providerSessionId: forked };
  }

  /**
   * Fork a thread into a fresh, independent branch. We fork the session file
   * directly via the SDK's native `forkSession` — which remaps UUIDs and
   * preserves the parent chain. `keepTurns` branches from a point: we read the
   * transcript and slice at the last chain entry of the last kept turn (see
   * {@link cutUuid} and {@link keptPrompts}) — Claude's append-only transcript
   * needs no rollback, the slice happens at fork time. Omitting `keepTurns` (or keeping every turn)
   * forks the whole conversation. The branch's id IS its new session id, so it
   * needs no alias of its own. A branch that keeps no turn, or one of a thread
   * that never ran, has no transcript to carry: it gets a session of its own,
   * created by its first turn.
   */
  async forkThread(threadId: string, opts?: HistoryCut): Promise<Thread> {
    const src = this.threads.get(threadId);
    const empty = src?.fresh === true || opts?.keepTurns === 0;
    const sessionId = empty ? randomUUID() : await this.forkTranscript(threadId, opts);
    // Register the fork's state so its first turn resumes the copied session (or
    // creates the empty branch's), mirroring the source's cwd/model/effort/prompt.
    const cwd = src?.cwd ?? this.defaultCwd;
    this.threads.set(sessionId, {
      cwd,
      systemPrompt: src?.systemPrompt,
      fresh: empty,
      // A copied session inherits the source's plan: the CLI copies the task store
      // with the session, so starting empty would strand ids the agent still
      // updates. An empty branch has no task store to match.
      plan: empty ? new Map() : new Map(src?.plan ?? []),
      planAliases: empty ? new Map() : new Map(src?.planAliases ?? []),
      ...(src?.model ? { model: src.model } : {}),
      ...(src?.effort ? { effort: src.effort } : {}),
      ...(src?.mcpServers ? { mcpServers: src.mcpServers } : {}),
      ...(src?.webSearch ? { webSearch: true } : {}),
      ...(src?.subagents ? { subagents: true } : {}),
      ...(src?.askUser ? { askUser: true } : {}),
    });
    return { id: sessionId, cwd, status: "idle", model: src?.model ?? this.defaultModel, provider: this.id };
  }

  /** Copy a thread's session into a new one, sliced at `opts.keepTurns`. */
  private async forkTranscript(threadId: string, opts?: HistoryCut): Promise<string> {
    const source = this.sdkSessionId(threadId);
    let upToMessageId: string | undefined;
    if (opts?.keepTurns != null) {
      const transcript = await readTranscript(source);
      upToMessageId = cutUuid(
        transcript,
        keptPrompts(transcript, { keepTurns: opts.keepTurns }, opts.steersPerTurn),
      );
    }
    const { forkSession } = await loadSdk();
    const { sessionId } = await forkSession(source, upToMessageId ? { upToMessageId } : {});
    return sessionId;
  }

  async *sendTurn(threadId: string, input: TurnInput): AsyncIterable<TurnStreamEvent> {
    const state = this.ensureThreadState(threadId);
    // A cold thread resumes its saved session, unless the CLI never saved one: killed early in the
    // thread's first turn, it left no file, or a file with no conversation in it. Resuming that
    // fails every turn after, so it starts afresh under the same id (clearing the empty file
    // first). Checked once; any doubt resumes, as before. See claude/session-check.ts.
    if (state.unverified) {
      state.unverified = false;
      if (!state.fresh) {
        const id = this.sdkSessionId(threadId);
        const found = await this.sessionCheck.state(id);
        if (found === "absent" || (found === "empty" && (await this.sessionCheck.clear(id)))) state.fresh = true;
      }
    }
    // A fully settled plan belongs to the turn(s) that ran it. Snapshots are
    // whole-map and a consumer attributes each one to the CURRENT turn, so
    // carrying finished items forward would report the previous turn's agenda
    // (and count) as this turn's the moment any plan tool is touched. An UNFINISHED
    // plan does carry over — the next turn continues it.
    if (state.plan.size > 0 && [...state.plan.values()].every((p) => p.status === "completed")) {
      state.plan = new Map();
    }
    const turnId = randomUUID();
    // The workspace steering this turn carries. A turn already running when
    // workspace mode switched on carries none, so its completion must not
    // consume it.
    const workspaceContext = state.workspace?.pendingContext;

    // ── event plumbing: a background SDK loop fills this queue; we yield from it.
    const turn = new TurnQueue<TurnStreamEvent>();
    // The turn already has its terminal event (`turn.completed`, or a fatal
    // `error.raised`). The SDK re-throws a failed turn's own sentence out of the
    // iterator AFTER yielding the `result` that carried it, so without this the
    // one failure lands twice: once as this stream's error event, once as the
    // orchestrator's catch-all — which the client folds into a second, promptless
    // turn bubble.
    let settled = false;
    // What the turn produced settles the retries-exhausted case exactly as Codex
    // does: the CLI warned its way through a retry storm and then closed the
    // turn with nothing in it, which is not a success. A user Stop is not a
    // failure to promote (the turn ended because the reader said so), so
    // `interrupted` warnings never become the stated failure.
    const output = new TurnOutput((warning) => warning.code !== "interrupted");
    let subagents: TurnSubagents | null = null;
    // This turn's MCP servers: the override replaces the thread's whole, for this turn only.
    const servers = input.mcpServers ?? state.mcpServers;
    // Their credentials stay out of the log, error events and thrown errors. The thread's are
    // masked too: a CLI line may still quote the endpoint an override replaced.
    const redactor = new Redactor([...mcpSecrets(servers), ...mcpSecrets(state.mcpServers)]);
    const push = (raw: AgentEvent) => {
      const ev = redactor.event(raw);
      // One terminal per turn: a second one (an aborted result landing after the
      // stream already closed the turn, say) would open a stray turn bubble.
      if (settled && isTerminalEvent(ev)) {
        console.warn(`[muxi-agent:claude] turn ${turnId} already settled; dropping ${ev.type}`);
        return;
      }
      // No subagent outlives its turn, so none reads as running after it.
      if (isTerminalEvent(ev)) subagents?.tracker.stopLive(SUBAGENT_TURN_ENDED);
      output.note(ev);
      // Retries exhausted (or a refusal) and nothing to show for it: state the
      // cause once instead of closing on an unexplained empty success.
      const out = ev.type === "turn.completed" ? (output.promoted() ?? ev) : ev;
      if (isTerminalEvent(out)) settled = true;
      // The workspace steering reached the model once this turn completed.
      if (out.type === "turn.completed" && workspaceContext && state.workspace?.pendingContext === workspaceContext) {
        delete state.workspace.pendingContext;
      }
      turn.push(out);
    };
    const pushInput = (ev: ToolInputDelta) => {
      if (settled) return;
      turn.push(ev);
    };
    // The turn's subagents: only on a thread that asked for them, outside
    // workspace mode, and only when the provider has a subagent role.
    const subagentRole = state.subagents && !state.workspace ? this.subagentRole : undefined;
    if (subagentRole) subagents = turnSubagents(new SubagentTracker(threadId, push, subagentRole.role));

    const controller = new AbortController();

    // Per-turn overrides win, then the thread's sticky selection, then defaults.
    // The selection sticks for later override-less turns (Codex behaves the same).
    if (input.model) state.model = input.model;
    if (input.effort) state.effort = input.effort;
    const model = state.model ?? this.defaultModel;
    const effort = this.resolveEffort(model, state.effort);
    // A cold-resumed thread lost the in-memory plan accumulator; ask for one
    // `TaskList` so the plan snapshots resume from the CLI's own task store. The
    // ask rides on this turn's user message because the system prompt is recorded
    // for the whole conversation and would drop it (see `chatTurnOptions`).
    const promptText = [state.planResync ? PLAN_RESYNC_HINT : "", workspaceContext ?? "", input.text]
      .filter(Boolean)
      .join("\n\n");
    state.planResync = false;

    // The refusals the host's side made, by tool_use_id: the guard and the host's canUseTool. The
    // CLI's own (the classifier, a rule, the mode) are read in mapMessage.
    const denials = new Map<string, ToolDenial>();
    const bridge: ApprovalBridge = { pending: this.pending, threadId, turnId, push, denials, ...(this.guard ? { guard: this.guard } : {}) };
    const options = chatTurnOptions({
      state,
      model,
      effort,
      // The SDK session behind this thread (an edit forks it, so it is not always
      // the thread id). A fresh thread names its new session; later turns resume it.
      sessionId: this.sdkSessionId(threadId),
      controller,
      executablePath: this.executablePath,
      supportsSteer: this.supportsSteer,
      mcpServers: turnMcpServers(servers),
      redactor,
      canUseTool: async (toolName, toolInput, opts) => {
        const result = await toolPermission(bridge, this.threads.get(threadId)?.workspace, toolName, toolInput, opts.toolUseID, {
          ...(opts.agentID != null ? { agentId: opts.agentID } : {}),
          subagents,
        });
        if (result.behavior === "deny" && !denials.has(opts.toolUseID)) denials.set(opts.toolUseID, { by: "host", reason: result.message });
        return result;
      },
      onElicitation: (request) => elicitation(bridge, request),
      // The guard first; each event's hooks from every part, concatenated (a deny wins).
      hooks: mergeHooks(
        guardHooks(threadId, this.guard, denials),
        planHooks(threadId, () => this.ensureThreadState(threadId), () => settled, push),
        state.workspace ? workspaceHooks(() => this.threads.get(threadId)?.workspace) : null,
        subagents ? subagentHooks(() => subagents?.tracker ?? null) : null,
      ),
      ...(subagentRole ? { subagents: subagentRole } : {}),
      // A thread started with web search keeps it in workspace mode: the web tools read no
      // files, and the workspace hook passes them to `canUseTool` like any thread's.
      ...(state.webSearch ? { webSearch: true } : {}),
      ...(state.askUser ? { askUser: true } : {}),
      ...(input.outputSchema ? { outputSchema: input.outputSchema } : {}),
      ...(input.permissionMode ? { permissionMode: input.permissionMode } : {}),
    });

    // The opening prompt carries the turn id as its client uuid, which the CLI
    // echoes on the result that answers it. The channel stays open until the
    // turn's last result whether or not steering is on: once the SDK's input
    // ends it closes the CLI's stdin at the first result, and the control call
    // behind the context read on that result (`getContextUsage`) then fails.
    const prompt = new PromptChannel();
    prompt.push(buildClaudeUserMessage(promptText, input.images, turnId, input.documents));
    const q = (this.queryFn ?? (await loadSdk()).query)({ prompt, options });
    const live: LiveTurn = {
      turnId,
      redact: (t) => redactor.text(t),
      q,
      controller,
      emit: push,
      isSettled: () => settled,
      input: prompt,
      accepting: this.supportsSteer,
      pushed: new Set(),
      steerIds: new Map(),
      subagents,
    };
    this.liveTurns.set(threadId, live);

    const timer = setTimeout(() => {
      turn.failure = new Error(`Turn timed out after ${this.turnTimeoutMs}ms`);
      // Aborting tears down OUR stream; the CLI's own `interrupt()` is what stops
      // the turn's in-flight work (tool calls, a model request) cleanly. Ask for
      // that first, then abort either way — a CLI too old or too wedged to answer
      // must still be torn down, and neither leg may replace the timeout error.
      closeTurnInput(live);
      void stopTurn(q, controller, `turn ${turnId}`, undefined, (t) => redactor.text(t));
      turn.end();
    }, this.turnTimeoutMs);

    const scope: TurnScope = {
      threadId,
      turnId,
      // tool_use id → {server, tool, startedAt} so `tool.completed` can name the
      // call and report its wall-clock duration (call issued → result back, the
      // same span Codex's native durationMs covers).
      toolNames: new Map(),
      push,
      pushInput,
      inputBlocks: new Map(),
      streamedInputTools: this.streamedInputTools,
      mcpServers: Object.keys(servers ?? {}),
      assistantError: null,
      rateLimitWarned: new Set(),
      usageLimitMessage: null,
      parkTimer: null,
      stop: () => {
        closeTurnInput(live);
        void stopTurn(q, controller, `turn ${turnId}`, undefined, (t) => redactor.text(t));
      },
      compacting: false,
      live,
      supportsSteer: this.supportsSteer,
      rateLimitParkMs: this.rateLimitParkMs,
      plan: () => this.ensureThreadState(threadId),
      denials,
      advisories: new Map(),
      calls: new Map(),
    };

    push({
      type: "turn.started",
      threadId,
      turnId,
      provider: "claude",
      prompt: userPrompt(input),
      model,
      ...(effort ? { effort } : {}),
      ...(input.trigger ? { trigger: input.trigger } : {}),
    });

    void pumpTurn({ q, state, scope, model, controller, turn, output, isSettled: () => settled, redactor });

    try {
      for (;;) {
        for (let ev = turn.shift(); ev; ev = turn.shift()) yield ev;
        if (turn.done) {
          // Never throw on top of a terminal event we already emitted — that one
          // failure would be recorded twice (see `settled`). The timeout is the
          // only writer that can set `failure` after the fact.
          if (turn.failure && !settled) throw redactor.error(turn.failure);
          return;
        }
        await turn.wait();
      }
    } finally {
      clearTimeout(timer);
      closeTurnInput(live);
      // A consumer that stops iterating early (e.g. a persistence failure
      // downstream) must not leave the CLI turn running detached: the controller is
      // about to be dropped, so `interrupt()` could never reach it again.
      if (!turn.done) controller.abort();
      // Only ever retire OUR registration: a queued next turn on this thread may
      // already have replaced it.
      if (this.liveTurns.get(threadId)?.turnId === turnId) this.liveTurns.delete(threadId);
      // Release any approvals the host never answered (e.g. an interrupted turn) so
      // the SDK callbacks unblock instead of hanging forever.
      for (const [id, p] of this.pending) {
        if (p.turnId === turnId) {
          this.pending.delete(id);
          p.settle({ action: "decline" });
        }
      }
    }
  }

  async resolveApproval(
    requestId: ApprovalRequestId,
    decision: ApprovalDecision,
  ): Promise<void> {
    const p = this.pending.get(String(requestId));
    if (!p) throw new PendingApprovalNotFoundError(requestId);
    this.pending.delete(String(requestId));
    p.settle(decision);
  }

  /**
   * Fold `text` into the running turn `turnId` (see {@link supportsSteer}). The
   * message goes onto the turn's open prompt with a fresh client uuid; the CLI
   * takes it at its next tool round, or, when the model is already writing its
   * answer, as one more result inside the same turn, which stays open until
   * a result has echoed every uuid it was sent. `priority` stays unset: that
   * folds between tool rounds, while `now` aborts the round in flight.
   *
   * Rejects, delivering nothing, unless `turnId` is this thread's running turn,
   * the turn has no terminal event, and its input is taking messages. Never
   * waits on the CLI.
   */
  async steerTurn(threadId: string, turnId: string, text: string, steerId?: string): Promise<void> {
    const live = this.liveTurns.get(threadId);
    if (!live || live.turnId !== turnId) {
      throw new Error(`turn ${turnId} is not the running turn on thread ${threadId}`);
    }
    if (live.isSettled()) throw new Error(`turn ${turnId} has already ended`);
    if (!live.accepting) throw new Error(`turn ${turnId} is not taking messages`);
    const uuid = randomUUID();
    live.pushed.add(uuid);
    if (steerId) live.steerIds.set(uuid, steerId);
    live.input.push({
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
      uuid,
    } as SDKUserMessage);
  }

  /**
   * Stop the thread's running turn. The graceful leg comes first, the CLI's own
   * `interrupt()` (the same path the turn timeout uses), so in-flight work (a
   * model request, a tool call) unwinds and the session's state settles instead of
   * being cut mid-write; the abort is the fallback for a CLI too old or too wedged
   * to answer within {@link INTERRUPT_GRACE_MS}, and the only leg available when
   * no turn is registered here.
   *
   * The turn also gets a sentence: Codex reports a stopped turn as a non-fatal
   * `interrupted` warning, so this emits the same event before stopping. Non-fatal
   * on purpose: the stream still closes with `turn.completed`, which is what
   * flips the thread back to idle.
   */
  async interrupt(threadId: string, _turnId: string): Promise<void> {
    const live = this.liveTurns.get(threadId);
    if (!live) return;
    // The CLI's interrupt ends the subagents with the turn; they end stopped.
    for (const id of live.subagents?.tracker.liveIds() ?? []) live.subagents?.tracker.markStopping(id);
    closeTurnInput(live);
    if (live.isSettled()) {
      // The turn closed while the Stop was in flight; there is nothing left to
      // interrupt, and a warning here would land after its terminal event.
      live.controller.abort();
      return;
    }
    live.emit({
      type: "error.raised",
      threadId,
      turnId: live.turnId,
      code: "interrupted",
      fatal: false,
      message: INTERRUPT_MESSAGE,
    });
    await stopTurn(live.q, live.controller, `turn ${live.turnId}`, INTERRUPT_GRACE_MS, live.redact);
  }

  stopSubagent(threadId: string, subagentId: string): Promise<boolean> {
    return stopTurnSubagent(this.liveTurns.get(threadId), subagentId);
  }

  async releaseThread(threadId: string): Promise<void> {
    this.threads.delete(threadId);
  }

  // ── internals ──────────────────────────────────────────────────────────────

  /** Clamp a requested effort to what `model` supports (see {@link clampEffort}). */
  private resolveEffort(model: string, requested: string | undefined): EffortLevel | undefined {
    return clampEffort(this.effortLevels.get(model), requested);
  }

  private ensureThreadState(threadId: string): ThreadState {
    let state = this.threads.get(threadId);
    if (!state) {
      // Cold thread (process restarted): resume the on-disk SDK session. The
      // steering is NOT guessed here: {@link resumeThread} rehydrates it from
      // the state the host persisted for this thread, so a cold thread can
      // never inherit another thread's system prompt, effort, cwd or servers.
      state = {
        cwd: this.defaultCwd,
        systemPrompt: undefined,
        fresh: false,
        unverified: true,
        plan: new Map(),
        planAliases: new Map(),
        planResync: true,
      };
      this.threads.set(threadId, state);
    }
    return state;
  }

  /** The SDK session id behind a thread: its {@link ThreadState.sessionAlias}
   *  once an edit forked the transcript, else the thread id itself (bound as the
   *  session id on the thread's first turn). Every `query`/`forkSession`/
   *  `getSessionMessages` call goes through here. */
  private sdkSessionId(threadId: string): string {
    return this.threads.get(threadId)?.sessionAlias ?? threadId;
  }
}
