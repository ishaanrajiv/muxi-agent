/**
 * One turn's subagents, provider-neutral. Each provider feeds it what its own
 * subagents report (Claude's task events and child frames, Codex's child
 * threads) and it emits the whole state of a subagent on every change, as
 * `agent.subagent.updated`. It also holds the limits both providers apply.
 */

import {
  SUBAGENT_CALLS_KEPT,
  SUBAGENT_MAX_LIVE,
  SUBAGENT_MAX_PER_TURN,
  type AgentEvent,
  type AgentSubagentUpdated,
  type SubagentCall,
  type SubagentStatus,
  type ToolDenial,
} from "./types/index.ts";

type SubagentState = Omit<AgentSubagentUpdated, "type" | "threadId">;

/**
 * The one role subagents run as, passed to a provider as its `subagent`
 * option. Without it no thread gets subagents, whatever it asks for.
 */
export interface SubagentRole {
  /** The role's name, as both backends register it (Claude's agent type, the
   *  Codex `agent_type` and its `agents/<role>.toml`). Letters, digits, `-`, `_`. */
  role: string;
  /** One line on what the role does, shown to the main agent. */
  description: string;
  /** The role's instructions (its system prompt). */
  instructions: string;
  /** MCP tools a subagent may never call: a whole server, or one tool on it.
   *  Claude hides them from the subagent; on Codex a role can't narrow a
   *  thread's servers, so a host's policy refuses them by the approval's
   *  `subagent` field. */
  refusedTools?: Array<{ server: string; tool?: string }>;
}

/** Validate a role name: it lands in tool inputs and a file name. */
export function checkSubagentRole(role: SubagentRole): SubagentRole {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(role.role)) {
    throw new Error(`subagent role name must be letters, digits, - or _ (got ${JSON.stringify(role.role)})`);
  }
  return role;
}

/** Longest name a subagent keeps; the brief carries the rest. */
const NAME_MAX = 24;
/** Longest report kept on a subagent's state. */
const REPORT_MAX = 4_000;

/**
 * A subagent's display name from the short description its provider gave
 * ("Region", "check app version split"). A trailing "subagent" is dropped, so a
 * caller can append its own. Empty, it falls back to its place in the turn.
 */
export function subagentName(description: string | null | undefined, ordinal: number): string {
  const words = (description ?? "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\s+subagent$/i, "");
  if (!words) return `Subagent ${ordinal}`;
  const name = words.length > NAME_MAX ? `${words.slice(0, NAME_MAX - 1).trimEnd()}…` : words;
  return name[0]!.toUpperCase() + name.slice(1);
}

/** The Claude CLI's frame around a subagent's result: one line warning the
 *  main agent that the report carries no user authority, then the report with
 *  every line indented two spaces. */
const HAND_BACK_FRAME = /^\[Subagent hand-back\][^\n]*\n/;

/** A subagent's final message as its report: the CLI's frame and its own
 *  trailer (agent id, usage block) dropped, and long text cut. */
export function subagentReport(text: string): string {
  const unframed = HAND_BACK_FRAME.test(text) ? text.replace(HAND_BACK_FRAME, "").replace(/^ {2}/gm, "") : text;
  const cleaned = unframed
    .replace(/<usage>[\s\S]*?<\/usage>/g, "")
    .replace(/^agentId: .*$/gm, "")
    .trim();
  return cleaned.length > REPORT_MAX ? `${cleaned.slice(0, REPORT_MAX - 1)}…` : cleaned;
}

export class SubagentTracker {
  private readonly subagents = new Map<string, SubagentState>();
  private readonly stopping = new Set<string>();
  private readonly threadId: string;
  private readonly emit: (ev: AgentEvent) => void;
  /** The role every subagent runs as (see {@link SubagentRole}). */
  readonly role: string;

  constructor(threadId: string, emit: (ev: AgentEvent) => void, role = "subagent") {
    this.threadId = threadId;
    this.emit = emit;
    this.role = role;
  }

  /** Whether this turn has a subagent by that id, live or not. */
  has(subagentId: string): boolean {
    return this.subagents.has(subagentId);
  }

  name(subagentId: string): string | undefined {
    return this.subagents.get(subagentId)?.name;
  }

  /** The ids of the subagents still running. */
  liveIds(): string[] {
    return [...this.subagents.values()].filter((h) => h.status === "running").map((h) => h.subagentId);
  }

  /** Why another subagent may not start now, or null when it may. */
  refusal(): string | null {
    if (this.liveIds().length >= SUBAGENT_MAX_LIVE) {
      return `${SUBAGENT_MAX_LIVE} subagents are already running. Wait for one to report before you start another.`;
    }
    if (this.subagents.size >= SUBAGENT_MAX_PER_TURN) {
      return `This turn already started ${SUBAGENT_MAX_PER_TURN} subagents. Answer with what they found.`;
    }
    return null;
  }

  /** A subagent started. A second start for the same id changes nothing. */
  start(subagentId: string, input: { name?: string | null; brief?: string | null }): void {
    if (this.subagents.has(subagentId)) return;
    this.subagents.set(subagentId, {
      subagentId,
      name: subagentName(input.name, this.subagents.size + 1),
      brief: (input.brief ?? "").trim(),
      status: "running",
      calls: [],
      callCount: 0,
    });
    this.publish(subagentId);
  }

  /** Fill in a brief its start lacked (Codex names the child before its brief). */
  brief(subagentId: string, brief: string | null | undefined): void {
    const h = this.subagents.get(subagentId);
    const text = brief?.trim();
    if (!h || !text || h.brief) return;
    h.brief = text;
    this.publish(subagentId);
  }

  /** A subagent started an MCP tool call. */
  call(subagentId: string, callId: string, tool: string): void {
    const h = this.subagents.get(subagentId);
    if (!h || h.status !== "running" || h.calls.some((c) => c.id === callId)) return;
    h.calls = [...h.calls, { id: callId, tool, status: "running" as const }].slice(-SUBAGENT_CALLS_KEPT);
    h.callCount += 1;
    this.publish(subagentId);
  }

  /** One of a subagent's MCP tool calls finished. A failed call the host itself refused says so. */
  settleCall(subagentId: string, callId: string, ok: boolean, denial?: ToolDenial): void {
    if (!ok && denial) return this.declineCall(subagentId, callId, denial);
    const h = this.subagents.get(subagentId);
    const status: SubagentCall["status"] = ok ? "completed" : "failed";
    if (!h || h.status !== "running" || !h.calls.some((c) => c.id === callId && c.status !== status)) return;
    h.calls = h.calls.map((c) => (c.id === callId ? { ...c, status } : c));
    this.publish(subagentId);
  }

  /**
   * One of a subagent's calls was refused rather than run: it ends failed, saying who refused it.
   * This holds after the subagent finished too, since the turn's result (the CLI's record of
   * refusals) comes last. A call already refused or completed is left as it is.
   */
  declineCall(subagentId: string, callId: string, denial: ToolDenial): void {
    const h = this.subagents.get(subagentId);
    if (!h || !h.calls.some((c) => c.id === callId && !c.denial && c.status !== "completed")) return;
    h.calls = h.calls.map((c) => (c.id === callId ? { ...c, status: "failed" as const, denial } : c));
    this.publish(subagentId);
  }

  /** Someone asked this subagent to stop, so however it ends next, it ends
   *  stopped (a stopped call can come back as an error). */
  markStopping(subagentId: string): void {
    this.stopping.add(subagentId);
  }

  /** What the subagent is doing now, in its provider's words. */
  action(subagentId: string, text: string | null | undefined): void {
    const h = this.subagents.get(subagentId);
    const action = text?.trim();
    if (!h || h.status !== "running" || !action || action === h.action) return;
    h.action = action;
    this.publish(subagentId);
  }

  /**
   * A subagent ended. The first end sets its status; a later one (Claude reports
   * the end twice, as the tool's result and as a task notification) only fills
   * in a report or reason that is still missing.
   */
  finish(
    subagentId: string,
    status: Exclude<SubagentStatus, "running">,
    detail: { report?: string | null; error?: string | null } = {},
  ): void {
    const h = this.subagents.get(subagentId);
    if (!h) return;
    const report = detail.report ? subagentReport(detail.report) : "";
    const error = detail.error?.trim();
    const wasLive = h.status === "running";
    if (!wasLive && (h.report || !report) && (h.error || !error)) return;
    if (wasLive) {
      const userStopped = this.stopping.has(subagentId);
      h.status = userStopped ? "stopped" : status;
      if (userStopped) h.error = SUBAGENT_USER_STOPPED;
      delete h.action;
      // A call still open when its subagent ended will never finish.
      h.calls = h.calls.map((c) => (c.status === "running" ? { ...c, status: "failed" as const } : c));
    }
    if (report && !h.report) h.report = report;
    if (error && !h.error && h.status !== "completed") h.error = error;
    this.publish(subagentId);
  }

  /** The turn is ending: every subagent still running is stopped, so none reads
   *  as running after its turn. */
  stopLive(reason: string): void {
    for (const id of this.liveIds()) this.finish(id, "stopped", { error: reason });
  }

  private publish(subagentId: string): void {
    const h = this.subagents.get(subagentId);
    if (!h) return;
    this.emit({ type: "agent.subagent.updated", threadId: this.threadId, ...h, calls: [...h.calls] });
  }
}

/** Why a subagent the user stopped (its row's Stop, or the turn's) ended. */
export const SUBAGENT_USER_STOPPED = "You stopped this subagent.";

/** Why a subagent still running when its turn ended reads as stopped. */
export const SUBAGENT_TURN_ENDED = "The turn ended before this subagent reported.";
