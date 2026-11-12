/**
 * The sizes a Codex compaction leaves out. Its compaction item carries no
 * token counts, so the size before comes from the thread's last usage report
 * and the size after from usage reported since the compaction started.
 */

import type { AgentEvent } from "../types/index.ts";

export class CompactionSizes {
  /** Each thread's context size from its last token-usage report: the size a
   *  compaction starts from. */
  private readonly lastUsed = new Map<string, number>();
  /** Compactions in progress by thread. Codex reports the compacted size in a
   *  token-usage update before the compaction item completes, so `post` is
   *  whatever usage arrived after the start. */
  private readonly open = new Map<string, { pre?: number; post?: number }>();

  /** A thread's token-usage report. */
  noteUsage(threadId: string, usedTokens: number): void {
    this.lastUsed.set(threadId, usedTokens);
    const open = this.open.get(threadId);
    if (open) open.post = usedTokens;
  }

  /** A compaction event with the sizes Codex leaves out: before, from the
   *  thread's last usage at the start, and after, from usage reported since. */
  decorate(ev: AgentEvent): AgentEvent {
    if (ev.type !== "context.compaction") return ev;
    if (ev.phase === "started") {
      const pre = this.lastUsed.get(ev.threadId);
      this.open.set(ev.threadId, pre != null ? { pre } : {});
      return pre != null ? { ...ev, preTokens: pre } : ev;
    }
    const open = this.open.get(ev.threadId);
    this.open.delete(ev.threadId);
    return {
      ...ev,
      ...(open?.pre != null ? { preTokens: open.pre } : {}),
      ...(open?.post != null ? { postTokens: open.post } : {}),
    };
  }

  forget(threadId: string): void {
    this.lastUsed.delete(threadId);
    this.open.delete(threadId);
  }
}
