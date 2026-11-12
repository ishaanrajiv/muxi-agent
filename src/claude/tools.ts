/**
 * The tools a Claude chat turn is given and how their names read: the thread's
 * own MCP servers, the built-in plan tools and tool search, and the result
 * shape tool calls report.
 */

import type { McpServerConfig as SdkMcpServerConfig } from "@anthropic-ai/claude-agent-sdk";

import type { McpServerConfig } from "../types/index.ts";
import { withoutImageBlocks } from "../normalize.ts";

/** The CLI's tool search. It loads MCP tools a server defers (a tool listed
 *  with `_meta` `anthropic/alwaysLoad: false`) and reads nothing but the tool
 *  list, so it runs unasked and draws no tool row. */
export const TOOL_SEARCH = "ToolSearch";
/** The tool the CLI adds when a turn asks for structured output (`outputFormat`):
 *  it only delivers the turn's answer, so it is never gated. */
export const STRUCTURED_OUTPUT = "StructuredOutput";

/** Appended to a thread's system prompt when it has MCP servers. Instructions
 *  tend to name a tool bare, and the CLI rejects a bare name as unknown. */
export const CLAUDE_TOOL_NAME_NOTE =
  "Tool names: a tool from an MCP server is registered as `mcp__<server>__<tool>`. " +
  "Where these instructions name a tool bare, call it by that full name. " +
  "Don't mention tool naming in your answer.";

/** Claude's question for the person (on a thread started with `askUser`). The
 *  host answers it through the approval round trip (`claude/permissions.ts`). */
export const ASK_USER = "AskUserQuestion";

/** The native task tools, Claude's counterpart of Codex's `update_plan`.
 *  Insertion order is the order handed to the SDK's `tools` option. */
const PLAN_TOOL_NAMES = ["TaskCreate", "TaskUpdate", "TaskList", "TaskGet"] as const;
export const PLAN_TOOLS: ReadonlySet<string> = new Set(PLAN_TOOL_NAMES);

/** Every built-in the Claude agent is given. */
export const BUILTIN_TOOL_NAMES = [...PLAN_TOOL_NAMES, TOOL_SEARCH];

/**
 * A thread's MCP servers as the SDK takes them. `alwaysLoad` is CRITICAL: a
 * model whose tools are all deferred behind tool search (the CLI's default)
 * concludes it has none and fabricates the calls as text. A server can still
 * opt single tools back out (`_meta` `anthropic/alwaysLoad: false`), and
 * {@link TOOL_SEARCH} loads them.
 */
export function turnMcpServers(servers: Record<string, McpServerConfig> | undefined): Record<string, SdkMcpServerConfig> {
  return Object.fromEntries(
    Object.entries(servers ?? {}).map(([name, server]) => [
      name,
      {
        type: "http" as const,
        url: server.url,
        ...(server.headers && Object.keys(server.headers).length ? { headers: server.headers } : {}),
        alwaysLoad: true,
      },
    ]),
  );
}

/** Parse an SDK tool name into {server, tool}. MCP tools are `mcp__<server>__<tool>`. */
export function parseToolName(name: string): { server: string; tool: string } {
  if (name.startsWith("mcp__")) {
    const rest = name.slice("mcp__".length);
    const sep = rest.indexOf("__");
    if (sep >= 0) return { server: rest.slice(0, sep), tool: rest.slice(sep + 2) };
  }
  return { server: "builtin", tool: name };
}

/**
 * Normalize an SDK tool_result `content` into the Codex content-block shape
 * `[{type:"text", text}]`. The SDK delivers MCP results either as a content-block
 * array or, for a tool that returns a plain string through a structured-output
 * wrapper, as a serialized `{"result":"<json>"}`: that is unwrapped so readers
 * see the tool's own text at `content[0].text`, as on the Codex path.
 */
export function toContentBlocks(raw: unknown): Array<{ type: "text"; text: string }> {
  if (Array.isArray(raw)) {
    return withoutImageBlocks(raw).map((b) =>
      b && typeof b === "object" && typeof (b as { text?: unknown }).text === "string"
        ? { type: "text", text: (b as { text: string }).text }
        : { type: "text", text: typeof b === "string" ? b : JSON.stringify(b) },
    );
  }
  let text = typeof raw === "string" ? raw : JSON.stringify(raw ?? "");
  try {
    const parsed = JSON.parse(text) as { result?: unknown };
    if (parsed && typeof parsed === "object" && typeof parsed.result === "string") {
      text = parsed.result;
    }
  } catch {
    /* not JSON: leave the text as-is */
  }
  return [{ type: "text", text }];
}
