/**
 * Workspace mode on the Codex backend: the per-thread permission profile, and
 * the overrides a workspace thread's loads and turns carry.
 */

import type { CodexClient } from "../codex-client.ts";
import type { JsonValue } from "../generated/serde_json/JsonValue.ts";
import type { SandboxPolicy } from "../generated/v2/SandboxPolicy.ts";
import type { ThreadResumeParams } from "../generated/v2/ThreadResumeParams.ts";
import type { TurnStartParams } from "../generated/v2/TurnStartParams.ts";
import type { WorkspaceSettings } from "../provider.ts";
import { codexWorkspaceProfile, WORKSPACE_SHELL_GIT_ENV } from "../workspace-sandbox.ts";
import { errorMessage } from "../shared.ts";

/**
 * Write the thread's permission profile into the managed `config.toml`, where
 * Codex picks it up without a restart. The `workspaceWrite` sandbox policy
 * limits writes and the network but not reads, so without a profile the shell
 * could read the user's credential files. A config with profiles but no
 * `default_permissions` fails every turn ("failed to load workspace
 * requirements", codex 0.163), so one batch writes both; every other thread
 * passes its own sandbox and is unaffected by the default. A Codex that can't
 * write config or doesn't know profiles keeps the legacy policy: the profile id
 * comes back null. The managed file is rewritten on every start, and a host
 * re-applies workspace mode after a restart.
 */
export async function writeWorkspaceProfile(
  client: CodexClient,
  threadId: string,
  settings: WorkspaceSettings,
): Promise<string | null> {
  const id = `muxi-agent-workspace-${threadId}`;
  try {
    await client.request("config/batchWrite", {
      edits: [
        { keyPath: "default_permissions", value: ":read-only", mergeStrategy: "replace" },
        { keyPath: `permissions.${id}`, value: codexWorkspaceProfile(settings), mergeStrategy: "replace" },
      ],
    });
    return id;
  } catch (err) {
    console.info(
      `[muxi-agent:codex] no permission profile for ${threadId}; the legacy sandbox applies: ${errorMessage(err)}`,
    );
    return null;
  }
}

/**
 * The `thread/resume` overrides for a workspace thread, or `{}` for any other.
 * The managed config turns the shell tool off and drops the sandbox prose for
 * every thread; these keys turn both back on for this thread only, and keep
 * the workspace-write sandbox off the network unless the settings open it.
 * `profile` is the thread's permission profile id, absent where the legacy
 * sandbox applies.
 */
export function workspaceResumeOverrides(
  ws: WorkspaceSettings | undefined,
  profile: string | undefined,
): Partial<ThreadResumeParams> & { config?: Record<string, JsonValue> } {
  if (!ws) return {};
  return {
    cwd: ws.root,
    ...(profile ? { permissions: profile } : { sandbox: "workspace-write" }),
    approvalPolicy: "on-request",
    developerInstructions: ws.developerInstructions,
    config: {
      "features.shell_tool": true,
      include_permissions_instructions: true,
      "sandbox_workspace_write.network_access": ws.network === true,
      "shell_environment_policy.set": { ...WORKSPACE_SHELL_GIT_ENV },
    },
  };
}

/** What a workspace turn's `turn/start` adds: the root as cwd, asking on
 *  request, and the thread's permission profile or the legacy sandbox. */
export function workspaceTurnParams(
  ws: WorkspaceSettings,
  profile: string | undefined,
): Pick<TurnStartParams, "cwd" | "approvalPolicy" | "permissions" | "sandboxPolicy"> {
  return {
    cwd: ws.root,
    approvalPolicy: "on-request",
    ...(profile ? { permissions: profile } : { sandboxPolicy: workspaceSandboxPolicy(ws) }),
  };
}

/** A workspace turn's sandbox on a Codex without permission profiles: write
 *  inside the root and the cache (Codex keeps `.git` read-only on its own), no
 *  network unless opened, and no read limit. */
export function workspaceSandboxPolicy(ws: Pick<WorkspaceSettings, "root" | "cacheDir" | "network">): SandboxPolicy {
  return {
    type: "workspaceWrite",
    writableRoots: [ws.root, ...(ws.cacheDir ? [ws.cacheDir] : [])],
    networkAccess: ws.network === true,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  };
}
