/**
 * Whether a cold thread's SDK session can be resumed.
 *
 * A CLI killed early in a thread's first turn (a restart, an OOM) may never write the session, or
 * may leave a file with no conversation in it (only a `file-history-snapshot`). Resuming either
 * fails every turn after ("No conversation found"), and starting afresh under the same id fails
 * while the file is there ("already in use"). So:
 *
 * - `absent`: no session file anywhere under the config dir's `projects/`: start afresh;
 * - `empty`: a file with no messages in it: delete it, then start afresh (nothing to lose);
 * - `saved`: anything else, and any doubt: resume, as before.
 */

import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { loadSdk } from "./sdk.ts";

export type SessionState = "absent" | "empty" | "saved";

/** The CLI's config dir, as the CLI resolves it. */
const configDir = () => process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");

export async function sessionState(id: string): Promise<SessionState> {
  try {
    const root = join(configDir(), "projects");
    let dirs: string[];
    try {
      dirs = await readdir(root);
    } catch (e) {
      // No projects folder at all: the CLI never saved any session here.
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return "absent";
      throw e;
    }
    if (!dirs.some((d) => existsSync(join(root, d, `${id}.jsonl`)))) return "absent";
    const { getSessionMessages } = await loadSdk();
    const msgs = await getSessionMessages(id, { includeSystemMessages: true });
    return msgs.length === 0 ? "empty" : "saved";
  } catch {
    return "saved";
  }
}

/** Remove an `empty` session's file so its id can be created afresh. False if it couldn't be. */
export async function clearEmptySession(id: string): Promise<boolean> {
  try {
    const { deleteSession } = await loadSdk();
    await deleteSession(id);
    return (await sessionState(id)) === "absent";
  } catch {
    return false;
  }
}
