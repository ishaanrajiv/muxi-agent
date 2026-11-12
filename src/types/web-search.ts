/**
 * Web search, on for a thread that starts with `webSearch: true`. Both backends
 * have a native search tool: Claude's `WebSearch` and Codex's `web_search`.
 * Each provider reports a search as a `tool.started` / `tool.completed` pair on
 * the `builtin` server under one tool name, {@link WEB_SEARCH_TOOL}, with the
 * arguments and result in the shapes below, so a consumer handles both alike.
 */

import { z } from "zod";

/** The tool name a web search reports under, on the `builtin` server. */
export const WEB_SEARCH_TOOL = "webSearch";

/** One page a search returned. */
export const WebSearchSource = z.object({
  title: z.string(),
  url: z.string(),
});
export type WebSearchSource = z.infer<typeof WebSearchSource>;

/**
 * A finished search. `queries` holds what was searched, in order (Codex can send
 * several in one call). `url` is set when the call opened or searched within one
 * page rather than searching. `sources` holds the pages it returned: Claude
 * reports them, Codex mostly doesn't, and then the answer's citations are the
 * only record.
 */
export const WebSearchResult = z.object({
  queries: z.array(z.string()),
  url: z.string().optional(),
  sources: z.array(WebSearchSource),
});
export type WebSearchResult = z.infer<typeof WebSearchResult>;

/** A web search call's result, or null when the payload isn't one. */
export function webSearchResultOf(result: unknown): WebSearchResult | null {
  const parsed = WebSearchResult.safeParse(result);
  return parsed.success ? parsed.data : null;
}
