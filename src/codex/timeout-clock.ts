/**
 * Codex's timeout accounting on a thread, paused while a human answers an
 * out-of-band question (`thread/increment_elicitation`; its response's
 * `paused` is "whether timeout accounting is paused"). A question can sit in
 * the UI for minutes, and none of that is the tool's or the turn's time.
 */

import type { CodexClient } from "../codex-client.ts";
import { errorMessage } from "../shared.ts";

export class TimeoutClock {
  /** The "this codex build can't pause timeout accounting" note is one line per
   *  provider: it describes the build, not the question. */
  private loggedNoPause = false;
  private readonly client: Pick<CodexClient, "request">;

  constructor(client: Pick<CodexClient, "request">) {
    this.client = client;
  }

  /**
   * Pause the clock on `threadId`. The pause MUST be balanced by
   * {@link resume} once the question is answered: a thread left paused never
   * finishes a code-mode `exec` on codex 0.155, because the clock its cell
   * waits on is stopped. Returns whether the pause took. A build without the
   * method, or one that gates it behind a capability this client lacks, still
   * forwards the question; the clock just keeps running.
   */
  async pause(threadId: string): Promise<boolean> {
    try {
      await this.client.request("thread/increment_elicitation", { threadId });
      return true;
    } catch (err) {
      if (!this.loggedNoPause) {
        this.loggedNoPause = true;
        console.info(
          `[codex] thread/increment_elicitation unavailable; questions wait on the ` +
            `running clock: ${errorMessage(err)}`,
        );
      }
      return false;
    }
  }

  /** The other half of {@link pause}. Best-effort: when it fails the
   *  app-server is usually gone, and its counter with it. */
  async resume(threadId: string): Promise<void> {
    try {
      await this.client.request("thread/decrement_elicitation", { threadId });
    } catch (err) {
      console.warn(`[codex] thread/decrement_elicitation failed on ${threadId}: ${errorMessage(err)}`);
    }
  }
}
