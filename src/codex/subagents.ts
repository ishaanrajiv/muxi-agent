/**
 * One Codex turn's subagents: the child threads its `spawn_agent` calls start.
 *
 * Codex streams a child's items under the child's own thread id, and links it
 * to its parent three ways depending on the CLI: `thread/started` carries
 * `parentThreadId`, the parent's `collabAgentToolCall` names the receiver of a
 * spawn, and the parent's `subAgentActivity` items name the child as it starts
 * and ends. Any one registers the child, so the mapping holds across versions.
 *
 * Codex can't refuse a spawn, so a child past the limits, or any child while
 * subagents are off, is stopped as soon as its turn starts and never shows. Nor
 * can it refuse a follow-up to a child that already reported
 * (`followup_task`), in this turn or an earlier one, so that turn is stopped
 * the same way: a subagent reports once.
 *
 * A child that ends interrupted sends its parent nothing (a completed or
 * failed one sends its final message), so a main agent in `wait_agent` would
 * wait out its timeout for it. Whenever the provider stops a child mid-turn it
 * steers the main agent with why, which also wakes the wait.
 */

import { SUBAGENT_MAX_LIVE, type AgentEvent, type SubagentRef } from "../types/index.ts";

import type { CollabAgentTool } from "../generated/v2/CollabAgentTool.ts";

import type { JsonValue } from "../generated/serde_json/JsonValue.ts";
import type { ServerNotification } from "../generated/ServerNotification.ts";
import type { Thread as RawThread } from "../generated/v2/Thread.ts";
import type { ThreadItem } from "../generated/v2/ThreadItem.ts";
import { SubagentTracker, SUBAGENT_TURN_ENDED } from "../subagents.ts";
import { errorMessage } from "../shared.ts";

/** The per-thread config a subagent thread loads with: multi-agent on,
 *  3 children besides the main agent, one level deep. */
export const CODEX_SUBAGENT_CONFIG: Record<string, JsonValue> = {
  "agents.enabled": true,
  "features.multi_agent_v2": true,
  "agents.max_concurrent_threads_per_session": SUBAGENT_MAX_LIVE,
  "agents.max_depth": 1,
};

/** The managed config's own multi-agent setting, sent explicitly when a
 *  thread that ran with subagents reloads without them: Codex reuses a thread it
 *  still holds unless the resume carries a config override. */
export const CODEX_NO_SUBAGENT_CONFIG: Record<string, JsonValue> = {
  "agents.enabled": false,
  "features.multi_agent_v2": false,
};

/** Why a subagent still running when the main agent answered reads as stopped. */
const ANSWERED_FIRST = "The main agent answered before this subagent reported.";

/** What the main agent hears when a follow-up restarts a subagent from an
 *  earlier turn. */
const EARLIER_TURN =
  "A subagent you started in an earlier turn was stopped: a subagent reports once. " +
  "Do the follow-up yourself, or start a new subagent for it.";

/** The collab tools that start another turn on a child that already exists. */
const RESTARTS: ReadonlySet<CollabAgentTool> = new Set(["followupTask", "sendInput", "sendMessage", "resumeAgent"]);

interface Child {
  /** The child's running turn, once it started. */
  turnId: string | null;
  /** Its last message, which is its report once its turn completes. */
  lastText: string;
  /** What the main agent hears when it may not run (past the limits, subagents
   *  are off, or an earlier turn started it), or null for a subagent that runs.
   *  A refused child is stopped at once and never shown. */
  refused: string | null;
  /** Its running turn was already interrupted. */
  interrupted: boolean;
  /** It was stopped before its turn started, so that turn is interrupted as
   *  soon as it starts. */
  stopPending: boolean;
}

export class CodexSubagents {
  readonly tracker: SubagentTracker;
  private readonly children = new Map<string, Child>();
  private readonly parentThreadId: string;
  /** Whether this turn may have subagents at all. */
  private readonly allowed: boolean;
  /** Interrupt a child's turn. */
  private readonly interruptChild: (threadId: string, turnId: string) => unknown;
  /** Steer the main agent's running turn. */
  private readonly steerParent: (text: string) => unknown;
  /** Every child the thread's turns started, shared by those turns. */
  private readonly lineage: Set<string>;

  /**
   * `lineage` holds every child the parent thread's turns started. This turn
   * treats the ones already in it as an earlier turn's, and adds its own, so a
   * follow-up in a later turn still reaches a turn that owns the child.
   */
  constructor(
    parentThreadId: string,
    emit: (ev: AgentEvent) => void,
    allowed: boolean,
    interruptChild: (threadId: string, turnId: string) => unknown,
    steerParent: (text: string) => unknown,
    lineage: Set<string> = new Set(),
    role?: string,
  ) {
    this.parentThreadId = parentThreadId;
    this.allowed = allowed;
    this.interruptChild = interruptChild;
    this.steerParent = steerParent;
    this.tracker = new SubagentTracker(parentThreadId, emit, role);
    this.lineage = lineage;
    for (const id of lineage) this.adoptEarlier(id);
  }

  /** Whether a thread is one of this turn's children, shown or refused. */
  isChild(threadId: string | null | undefined): boolean {
    return threadId != null && this.children.has(threadId);
  }

  /** The subagent a child thread's approval request names, or null for a child
   *  that was refused or no longer runs (its requests are declined, never
   *  shown). */
  subagentRef(threadId: string): SubagentRef | null {
    const child = this.children.get(threadId);
    const name = this.tracker.name(threadId);
    const runs = child && !child.refused && !child.stopPending && this.tracker.liveIds().includes(threadId);
    return runs && name ? { id: threadId, name } : null;
  }

  /** Feed one app-server notification; anything not about this turn's
   *  children is ignored. */
  onNotification(n: ServerNotification): void {
    if (n.method === "thread/started") {
      const t = n.params.thread;
      if (t.parentThreadId === this.parentThreadId) this.register(t.id, childName(t), null);
      return;
    }
    if (n.method === "item/started" || n.method === "item/completed") {
      const { threadId, item } = n.params;
      if (threadId === this.parentThreadId) this.onParentItem(item);
      else if (this.children.has(threadId)) this.onChildItem(threadId, item, n.method === "item/completed");
      return;
    }
    if (n.method === "turn/started" && this.children.has(n.params.threadId)) {
      this.onChildTurn(n.params.threadId, n.params.turn.id);
      return;
    }
    if (n.method === "turn/completed" && this.children.has(n.params.threadId)) {
      const id = n.params.threadId;
      const child = this.children.get(id)!;
      child.turnId = null;
      const { status, error } = n.params.turn;
      if (status === "completed") this.tracker.finish(id, "completed", { report: child.lastText });
      else if (status === "interrupted") this.tracker.finish(id, "stopped", { error: "Stopped." });
      else if (status === "failed") {
        this.tracker.finish(id, "failed", { error: error?.message || "The subagent couldn't finish." });
      }
    }
  }

  /** Stop one subagent. False when it isn't running. */
  stop(subagentId: string): boolean {
    const child = this.children.get(subagentId);
    if (!child || !this.tracker.liveIds().includes(subagentId)) return false;
    this.tracker.markStopping(subagentId);
    if (!this.interruptOnce(subagentId, child) && !child.turnId) {
      this.tracker.finish(subagentId, "stopped", { error: "Stopped." });
    }
    this.tellParent(
      `The user stopped the ${this.tracker.name(subagentId)} subagent. It won't report, so don't wait for it or ` +
        "start it again. Answer with what the other subagents found and name the gap in one line.",
    );
    return true;
  }

  /** The main agent's turn ended, or is being stopped: interrupt every child
   *  still running, since a Codex child outlives its parent's turn, and mark
   *  it stopped. */
  stopAll(reason: "answered" | "ended" | "interrupted"): void {
    for (const [id, child] of this.children) {
      if (reason === "interrupted") this.tracker.markStopping(id);
      this.interruptOnce(id, child);
    }
    if (reason !== "interrupted") this.tracker.stopLive(reason === "answered" ? ANSWERED_FIRST : SUBAGENT_TURN_ENDED);
  }

  /** A child's turn started. A refused child, one stopped before it ran, and
   *  one that already reported are interrupted at once, and the main agent is
   *  told why unless it already was. */
  private onChildTurn(threadId: string, turnId: string): void {
    const child = this.children.get(threadId)!;
    child.turnId = turnId;
    child.interrupted = false;
    if (child.stopPending) {
      child.stopPending = false;
      this.interruptOnce(threadId, child);
    } else if (child.refused) {
      if (this.interruptOnce(threadId, child)) this.tellParent(child.refused);
    } else if (!this.tracker.liveIds().includes(threadId) && this.interruptOnce(threadId, child)) {
      this.tellParent(
        `The ${this.tracker.name(threadId)} subagent was stopped: it already reported, and a subagent reports once. ` +
          "Do the follow-up yourself, or start a new subagent for it.",
      );
    }
  }

  /** Interrupt a child's running turn unless that already happened; whether
   *  this call interrupted it. A child whose turn hasn't started yet is
   *  interrupted when it does. */
  private interruptOnce(threadId: string, child: Child): boolean {
    if (!child.turnId) {
      child.stopPending = true;
      return false;
    }
    if (child.interrupted) return false;
    child.interrupted = true;
    bestEffort(() => this.interruptChild(threadId, child.turnId!), `could not stop subagent ${threadId}`);
    return true;
  }

  /** Steer the main agent, best-effort. */
  private tellParent(text: string): void {
    bestEffort(() => this.steerParent(text), `could not tell ${this.parentThreadId} about a stopped subagent`);
  }

  /** A spawn or a start registers a child. A follow-up that names a child this
   *  thread's turns never registered (they ran before a restart) reaches one an
   *  earlier turn started. */
  private onParentItem(item: ThreadItem): void {
    if (item.type === "collabAgentToolCall" && item.tool === "spawnAgent") {
      for (const id of item.receiverThreadIds) this.register(id, null, item.prompt);
    } else if (item.type === "collabAgentToolCall" && RESTARTS.has(item.tool)) {
      for (const id of item.receiverThreadIds) this.adoptEarlier(id);
    } else if (item.type === "subAgentActivity") {
      if (item.kind === "started") this.register(item.agentThreadId, lastSegment(item.agentPath), null);
      else if (item.kind === "interacted") this.adoptEarlier(item.agentThreadId);
    }
  }

  private onChildItem(threadId: string, item: ThreadItem, completed: boolean): void {
    if (item.type === "mcpToolCall") {
      if (!completed) this.tracker.call(threadId, item.id, item.tool);
      else this.tracker.settleCall(threadId, item.id, item.status === "completed");
    } else if (item.type === "agentMessage" && completed && item.text.trim()) {
      this.children.get(threadId)!.lastText = item.text;
    }
  }

  private register(threadId: string, name: string | null, brief: string | null): void {
    const known = this.children.get(threadId);
    if (known) {
      if (!known.refused) this.tracker.brief(threadId, brief);
      return;
    }
    const why = this.allowed ? this.tracker.refusal() : "Subagents are off in this thread. Do the work yourself.";
    this.children.set(threadId, newChild(why && `The subagent you just started was stopped. ${why}`));
    this.lineage.add(threadId);
    if (!why) this.tracker.start(threadId, { name, brief });
  }

  /** Know a child an earlier turn started: never shown, stopped if it runs. */
  private adoptEarlier(threadId: string): void {
    if (this.children.has(threadId)) return;
    this.children.set(threadId, newChild(EARLIER_TURN));
    this.lineage.add(threadId);
  }
}

function newChild(refused: string | null): Child {
  return { turnId: null, lastText: "", refused, interrupted: false, stopPending: false };
}

/** The name a child thread carries: the `task_name` the model gave its spawn
 *  (the last segment of its agent path), else Codex's nickname for it. */
function childName(t: RawThread): string | null {
  const source = t.source;
  if (source && typeof source === "object" && "subAgent" in source) {
    const sub = source.subAgent;
    if (sub && typeof sub === "object" && "thread_spawn" in sub) {
      const path = lastSegment(sub.thread_spawn.agent_path);
      if (path) return path;
    }
  }
  return t.agentNickname ?? t.name ?? null;
}

/** Run `call` now and log, never throw, if it fails. */
function bestEffort(call: () => unknown, failure: string): void {
  const warn = (err: unknown) => console.warn(`[codex] ${failure}: ${errorMessage(err)}`);
  try {
    void Promise.resolve(call()).catch(warn);
  } catch (err) {
    warn(err);
  }
}

function lastSegment(path: string | null | undefined): string | null {
  const seg = path?.split("/").filter(Boolean).pop();
  return seg ?? null;
}
