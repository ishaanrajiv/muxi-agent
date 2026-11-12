/**
 * The approval-detail readers a host's policy and its approval card share.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { mcpToolCallOf, toolArgsOf } from "./approval-detail.ts";

/** A tool-call confirmation: the kind tag merged into whatever `_meta` it has. */
const call = (detail: Record<string, unknown>) => ({
  detail: { ...detail, _meta: { codex_approval_kind: "mcp_tool_call", ...(detail._meta as object) } },
});
const ask = (tool: string) => `Allow the lab MCP server to run tool "${tool}"?`;

test("approval details read the same for the policy and the card", () => {
  const cases: Array<[why: string, actual: unknown, expected: unknown]> = [
    ["names the server and tool", mcpToolCallOf(call({ message: ask("notes_search") })), { server: "lab", tool: "notes_search" }],
    [
      "serverName wins over the message",
      mcpToolCallOf(call({ serverName: "lab-write", message: ask("notes_save") })),
      { server: "lab-write", tool: "notes_save" },
    ],
    [
      "toolName wins over the message",
      mcpToolCallOf(call({ serverName: "lab", toolName: "echo", message: ask("other") })),
      { server: "lab", tool: "echo" },
    ],
    [
      "Codex's _meta.tool_name names the tool",
      mcpToolCallOf(call({ serverName: "echo", message: ask("other"), _meta: { tool_name: "echo" } })),
      { server: "echo", tool: "echo" },
    ],
    [
      "a tool name needs double quotes",
      mcpToolCallOf(call({ message: "Allow the lab MCP server to run tool 'notes_search'?" })),
      { server: "lab", tool: null },
    ],
    [
      "an argument named tool is not the tool",
      mcpToolCallOf(call({ message: ask("notes_read"), _meta: { tool_params: { tool: "notes_save" } } }))?.tool,
      "notes_read",
    ],
    ["an elicitation without the kind tag is not a tool call", mcpToolCallOf({ detail: { message: ask("notes_search") } }), null],
    [
      "tool_params come before the stamped arguments",
      toolArgsOf(call({ arguments: { repo: "b" }, _meta: { tool_params: { repo: "a" } } })),
      { repo: "a" },
    ],
    [
      "arrays are not arguments, and _meta.arguments is read last",
      toolArgsOf({ detail: { arguments: ["b"], _meta: { tool_params: ["a"], arguments: { repo: "c" } } } }),
      { repo: "c" },
    ],
  ];
  for (const [why, actual, expected] of cases) assert.deepEqual(actual, expected, why);
});
