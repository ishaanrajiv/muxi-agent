/**
 * Workspace mode on the Claude backend: the state a workspace thread carries,
 * the sandbox and env its shell runs under, and the shape a native tool call
 * takes as an approval for the host to decide.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import type { ApprovalKind } from "../types/index.ts";
import type { Options } from "@anthropic-ai/claude-agent-sdk";

import type { WorkspaceSettings } from "../provider.ts";
import {
  WORKSPACE_SHELL_GIT_ENV,
  workspaceDenyReadPaths,
  workspaceReadOnlyPaths,
  type WorkspaceSandboxPaths,
} from "../workspace-sandbox.ts";

/** The file tools a workspace thread gets on top of the built-in tools, and
 *  the shell unless the settings turn it off. Every call routes through
 *  `canUseTool` to the host. */
export const WORKSPACE_FILE_TOOLS = ["Read", "Write", "Edit", "Glob", "Grep"] as const;
export const WORKSPACE_SHELL_TOOL = "Bash";
const WORKSPACE_EDIT_TOOLS: ReadonlySet<string> = new Set(["Edit", "Write", "NotebookEdit"]);

/** The native tools a workspace thread is given. */
export function workspaceToolNames(ws: Pick<WorkspaceState, "shell">): string[] {
  return [...WORKSPACE_FILE_TOOLS, ...(ws.shell === false ? [] : [WORKSPACE_SHELL_TOOL])];
}

/** A workspace thread's state (see `ClaudeAgentProvider.configureWorkspace`). */
export interface WorkspaceState
  extends Pick<WorkspaceSettings, "root" | "protectedPaths" | "cacheDir" | "network" | "shell" | "refusal"> {
  /** The workspace steering, sent once on the next turn's message, then
   *  cleared when that turn completes. The system prompt is snapshotted for the
   *  session, so a prompt change would not reach the model before the next
   *  compaction. */
  pendingContext?: string;
}

/** This machine, by every name a request can give it. */
const LOOPBACK_HOSTS = ["localhost", "*.localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0"];

/**
 * The SDK sandbox for a workspace thread's Bash. On, and a hard requirement: no
 * unsandboxed fallback and no `dangerouslyDisableSandbox` escape. Bash is not
 * auto-allowed, so a command reaches the host as an approval. Writes stay in
 * the root and the cache (the root's `.git` is read-only), the network is off
 * unless the settings open it (and then this machine's own servers stay
 * blocked), and credential paths are unreadable.
 */
export function workspaceSandbox(
  ws: WorkspaceSandboxPaths & Pick<WorkspaceSettings, "network">,
  home = homedir(),
): NonNullable<Options["sandbox"]> {
  return {
    enabled: true,
    failIfUnavailable: true,
    autoAllowBashIfSandboxed: false,
    allowUnsandboxedCommands: false,
    network: ws.network
      ? { allowedDomains: ["*"], deniedDomains: LOOPBACK_HOSTS }
      : { allowedDomains: [], deniedDomains: ["*"] },
    filesystem: {
      allowWrite: [ws.root, ...(ws.cacheDir ? [ws.cacheDir] : [])],
      denyWrite: workspaceReadOnlyPaths(ws),
      denyRead: workspaceDenyReadPaths(ws, home),
    },
  };
}

/** The env names a workspace thread's CLI keeps from the host's env. Its shell
 *  inherits that env, so the host's own secrets and `SSH_AUTH_SOCK` stay out.
 *  The CLI's own login and config (`ANTHROPIC_*`, `CLAUDE_*`) stay in, since the
 *  CLI needs them. */
const WORKSPACE_ENV_NAMES: ReadonlySet<string> = new Set([
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "TERM", "COLORTERM", "LANG", "TZ",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "no_proxy", "all_proxy",
  "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE",
  "JAVA_HOME", "GOPATH", "GOROOT", "CARGO_HOME", "RUSTUP_HOME", "PYENV_ROOT", "NVM_DIR",
]);
const WORKSPACE_ENV_PREFIXES = ["LC_", "ANTHROPIC_", "CLAUDE_"];

/** The env a workspace thread's CLI runs with: the allowlisted names from
 *  `base`, and, with a cache folder, the package manager caches pointed into it. */
export function workspaceEnv(
  cacheDir: string | undefined,
  base: NodeJS.ProcessEnv = process.env,
): Record<string, string | undefined> {
  const kept = Object.entries(base).filter(
    ([name]) => WORKSPACE_ENV_NAMES.has(name) || WORKSPACE_ENV_PREFIXES.some((prefix) => name.startsWith(prefix)),
  );
  return {
    ...Object.fromEntries(kept),
    ...(cacheDir
      ? {
          XDG_CACHE_HOME: cacheDir,
          UV_CACHE_DIR: join(cacheDir, "uv"),
          UV_PYTHON_INSTALL_DIR: join(cacheDir, "uv-python"),
          PIP_CACHE_DIR: join(cacheDir, "pip"),
          npm_config_cache: join(cacheDir, "npm"),
          PNPM_HOME: join(cacheDir, "pnpm"),
          npm_config_store_dir: join(cacheDir, "pnpm-store"),
        }
      : {}),
    ...WORKSPACE_SHELL_GIT_ENV,
  };
}

/** The path a read tool targets: Read's file, Glob's and Grep's folder (the
 *  working folder when the call names none). */
export function readToolPath(tool: string, input: Record<string, unknown>, cwd: string): string {
  const raw = tool === "Read" ? input.file_path : input.path;
  return typeof raw === "string" && raw ? raw : cwd;
}

/** A native tool call as the approval the host decides: `command` for Bash and
 *  reads, `fileChange` for edits. `_meta.native_tool` names the tool. */
export function nativeToolApproval(
  tool: string,
  input: Record<string, unknown>,
  ws: Pick<WorkspaceState, "root">,
  fileExists: (path: string) => boolean = existsSync,
): { kind: ApprovalKind; summary: string; detail: Record<string, unknown> } {
  const cwd = ws.root;
  if (tool === "Bash") {
    const command = typeof input.command === "string" ? input.command : "";
    return {
      kind: "command",
      summary: `Run ${command}`,
      detail: {
        command,
        cwd,
        ...(typeof input.description === "string" && input.description ? { reason: input.description } : {}),
        _meta: { native_tool: "Bash" },
      },
    };
  }
  if (WORKSPACE_EDIT_TOOLS.has(tool)) {
    const raw = tool === "NotebookEdit" ? input.notebook_path : input.file_path;
    const path = typeof raw === "string" ? raw : "";
    const abs = path && !isAbsolute(path) ? resolve(cwd, path) : path;
    const kind = tool === "Write" && abs && !fileExists(abs) ? "add" : "update";
    return {
      kind: "fileChange",
      summary: `Edit ${path}`,
      detail: { changes: path ? [{ path: abs, kind }] : [], _meta: { native_tool: tool } },
    };
  }
  const path = readToolPath(tool, input, cwd);
  const abs = isAbsolute(path) ? path : resolve(cwd, path);
  return {
    kind: "command",
    summary: `${tool} ${path}`,
    detail: {
      command: `${tool} ${path}`,
      cwd,
      // A Glob pattern can reach outside its path (`/etc/**`, `../**`), so the host sees it too.
      _meta: { native_tool: tool, path: abs, ...(tool === "Glob" && typeof input.pattern === "string" ? { pattern: input.pattern } : {}) },
    },
  };
}
