/**
 * Web search on the Claude backend: the switch offers the CLI's `WebSearch`,
 * the permission bridge runs it unasked for the main agent only, and a search
 * reports as the shared `webSearch` call with its pages.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { Options, PermissionResult, query } from "@anthropic-ai/claude-agent-sdk";
import type { StartThreadInput, TurnInput, TurnStreamEvent } from "./types/index.ts";

import { ClaudeAgentProvider } from "./claude-provider.ts";

type QueryArgs = Parameters<typeof query>[0];

const result = { type: "result", subtype: "success", is_error: false, result: "", usage: { input_tokens: 1, output_tokens: 1 } };

/** A `query()` double for one turn that searches once. It records the turn's
 *  options and what the bridge decided for the main agent and for a subagent. */
function searchQuery(seen: { options?: Options; main?: PermissionResult | null }): typeof query {
  return ((args: QueryArgs) => {
    seen.options = args.options;
    async function* run() {
      const ask = (agentID?: string) =>
        args.options!.canUseTool!("WebSearch", { query: "solstice 2026" }, {
          signal: new AbortController().signal,
          toolUseID: "s1",
          suggestions: [],
          ...(agentID ? { agentID } : {}),
        } as never);
      seen.main = await ask();
      // A subagent's search goes on to the gate, which refuses a subagent
      // anything it can't class.
      void ask("t1");
      yield {
        type: "assistant",
        parent_tool_use_id: null,
        message: { content: [{ type: "tool_use", id: "s1", name: "WebSearch", input: { query: "solstice 2026" } }] },
      };
      yield {
        type: "user",
        parent_tool_use_id: null,
        message: { content: [{ type: "tool_result", tool_use_id: "s1", content: "Web search results" }] },
        tool_use_result: {
          query: "solstice 2026",
          results: [{ tool_use_id: "x", content: [{ title: "Solstice", url: "https://example.org/solstice" }] }],
        },
      };
      yield result;
    }
    return run();
  }) as unknown as typeof query;
}

test("web search on a Claude turn: offered only with the switch, runs unasked for the main agent, reports its pages", async () => {
  for (const on of [false, true]) {
    const seen: { options?: Options; main?: PermissionResult | null } = {};
    const provider = new ClaudeAgentProvider({queryFn: searchQuery(seen) });
    const thread = await provider.startThread({ cwd: "/ws", webSearch: on } as StartThreadInput);
    const events: TurnStreamEvent[] = [];
    for await (const ev of provider.sendTurn(thread.id, { text: "when is solstice" } as TurnInput)) {
      events.push(ev);
    }
    const tools = seen.options?.tools;
    assert.equal(Array.isArray(tools) && tools.includes("WebSearch") && tools.includes("WebFetch"), on, `switch ${on}`);
    if (!on) continue;

    assert.equal(seen.main?.behavior, "allow");
    const asked = events.filter((e) => e.type === "approval.requested");
    assert.equal(asked.length, 1, "only the subagent's search reaches the gate");
    assert.match(asked[0]?.type === "approval.requested" ? asked[0].request.summary : "", /WebSearch/);
    const started = events.find((e) => e.type === "tool.started");
    const completed = events.find((e) => e.type === "tool.completed");
    assert.deepEqual(
      started?.type === "tool.started" ? [started.server, started.tool, started.arguments] : null,
      ["builtin", "webSearch", { query: "solstice 2026" }],
    );
    assert.deepEqual(completed?.type === "tool.completed" ? completed.result : null, {
      queries: ["solstice 2026"],
      sources: [{ title: "Solstice", url: "https://example.org/solstice" }],
    });
  }
});
