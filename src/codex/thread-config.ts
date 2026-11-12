/**
 * A Codex thread's own config: its MCP servers and opt-in tools (web search,
 * subagents). Codex fixes a thread's config when it loads the thread and has
 * no per-turn override, and keeps none of it in the rollout, so every load (a
 * start, and every resume after an unload or a restart) carries the whole
 * config again. The managed `config.toml` holds no MCP servers at all (see
 * `home.ts`), so these are the only ones a thread sees.
 */

import type { JsonValue } from "../generated/serde_json/JsonValue.ts";
import type { McpServerConfig } from "../types/index.ts";

import { CODEX_NO_SUBAGENT_CONFIG, CODEX_SUBAGENT_CONFIG } from "./subagents.ts";

/** What a thread was started with. */
export interface ThreadSetup {
  mcpServers: Record<string, McpServerConfig>;
  webSearch: boolean;
  subagents: boolean;
}

export const EMPTY_SETUP: ThreadSetup = { mcpServers: {}, webSearch: false, subagents: false };

/**
 * One MCP server as a Codex `[mcp_servers.<name>]` table, streamable HTTP.
 *
 * - `default_tools_approval_mode = "prompt"`: Codex otherwise asks the client
 *   only for a tool that is not read-only-hinted and is destructive or
 *   open-world, and runs every other call unasked. "prompt" sends EVERY call to
 *   the host as an approval, as the Claude bridge does.
 * - `omit_tools_from = ["deferred"]`: Codex defers MCP tools behind its
 *   `tool_search` by default, and an agent that never searches concludes it has
 *   no tools. This keeps the server's tools inline.
 */
export function codexMcpServer(server: McpServerConfig): Record<string, JsonValue> {
  return {
    url: server.url,
    ...(server.headers && Object.keys(server.headers).length ? { http_headers: { ...server.headers } } : {}),
    default_tools_approval_mode: "prompt",
    omit_tools_from: ["deferred"],
  };
}

/**
 * The config a thread loads with. `workspace` threads get neither web search
 * nor subagents; `subagentsAvailable` is false when the provider has no
 * subagent role. Every opt-in is sent explicitly on or off, so a resume never
 * reuses a stale load.
 */
export function threadConfig(
  setup: ThreadSetup,
  opts: { workspace: boolean; subagentsAvailable: boolean },
): Record<string, JsonValue> {
  const webSearch = setup.webSearch && !opts.workspace;
  const subagents = setup.subagents && !opts.workspace && opts.subagentsAvailable;
  return {
    mcp_servers: Object.fromEntries(
      Object.entries(setup.mcpServers).map(([name, server]) => [name, codexMcpServer(server)]),
    ),
    web_search: webSearch ? "live" : "disabled",
    ...(subagents ? CODEX_SUBAGENT_CONFIG : CODEX_NO_SUBAGENT_CONFIG),
  };
}
