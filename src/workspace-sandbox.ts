/**
 * What a workspace thread's sandboxed shell may not read or write, shared by
 * both backends: Claude's sandbox takes it as `filesystem.denyRead` /
 * `denyWrite`, Codex's as the entries of the thread's permission profile.
 */

import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative } from "node:path";

import type { WorkspaceSettings } from "./provider.ts";

/** Credential and agent folders under the user's home. Claude's holds its
 *  transcripts and, where there is no keychain, its login. */
const CREDENTIAL_HOME_PATHS = [
  ".ssh",
  ".aws",
  ".azure",
  ".kube",
  ".docker",
  ".gnupg",
  ".config/gh",
  ".config/gcloud",
  ".netrc",
  ".codex",
  ".claude",
];

/** Env files denied in the workspace, at the root and in every subfolder (a
 *  monorepo keeps them beside each package). */
const ENV_FILE_GLOBS = [".env", ".env.*", "**/.env", "**/.env.*"];

export type WorkspaceSandboxPaths = Pick<WorkspaceSettings, "root" | "protectedPaths" | "cacheDir">;

/** The paths a workspace thread's sandboxed shell may not read. */
export function workspaceDenyReadPaths(
  ws: WorkspaceSandboxPaths,
  home = homedir(),
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const keep = [ws.root, ...(ws.cacheDir ? [ws.cacheDir] : [])];
  return [
    ...CREDENTIAL_HOME_PATHS.map((p) => join(home, p)),
    ...(env.CLAUDE_CONFIG_DIR ? [env.CLAUDE_CONFIG_DIR] : []),
    ...(env.CODEX_HOME ? [env.CODEX_HOME] : []),
    ...ENV_FILE_GLOBS.map((g) => join(ws.root, g)),
    ...(ws.protectedPaths ?? []).flatMap((dir) => protectedDenyPaths(dir, keep)),
  ];
}

/**
 * One protected folder, as deny entries. A folder that holds none of `keep` is
 * denied whole. One that holds the workspace (or the cache) is denied entry by
 * entry, except the path down to it, so the workspace stays reachable and no
 * allow has to win over a deny in either sandbox.
 */
function protectedDenyPaths(dir: string, keep: string[]): string[] {
  if (!keep.some((path) => isWithin(path, dir))) return [dir];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names.flatMap((name) => {
    const entry = join(dir, name);
    if (keep.some((path) => path === entry)) return [];
    if (keep.some((path) => isWithin(path, entry))) return protectedDenyPaths(entry, keep);
    return [entry];
  });
}

/** Env for a workspace shell: its git asks no credential helper (the user's
 *  keychain login would hand the agent a token) and runs no hooks. */
export const WORKSPACE_SHELL_GIT_ENV: Readonly<Record<string, string>> = {
  GIT_CONFIG_COUNT: "2",
  GIT_CONFIG_KEY_0: "credential.helper",
  GIT_CONFIG_VALUE_0: "",
  GIT_CONFIG_KEY_1: "core.hooksPath",
  GIT_CONFIG_VALUE_1: "/dev/null",
};

/** What a workspace shell may read but not write: the root's `.git` (a folder,
 *  or a worktree's pointer file), so the agent can't rewrite history or hooks. */
export function workspaceReadOnlyPaths(ws: Pick<WorkspaceSettings, "root">): string[] {
  return [join(ws.root, ".git")];
}

function isWithin(path: string, dir: string): boolean {
  const rel = relative(dir, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * A Codex permission profile for one workspace thread, as `config.toml` holds it
 * under `[permissions.<id>]`: Codex's workspace profile (no network), writes in
 * the root and the cache except the root's `.git`, and the deny list. A narrower
 * entry beats a broader write, so the root's own env files stay unreadable.
 */
export function codexWorkspaceProfile(
  ws: WorkspaceSandboxPaths,
  home = homedir(),
  env: NodeJS.ProcessEnv = process.env,
): { extends: string; filesystem: Record<string, "write" | "read" | "deny"> } {
  const filesystem: Record<string, "write" | "read" | "deny"> = { [ws.root]: "write" };
  if (ws.cacheDir) filesystem[ws.cacheDir] = "write";
  for (const path of workspaceReadOnlyPaths(ws)) filesystem[path] = "read";
  for (const path of workspaceDenyReadPaths(ws, home, env)) filesystem[path] = "deny";
  return { extends: ":workspace", filesystem };
}
