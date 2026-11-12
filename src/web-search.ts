/**
 * Web search calls from both backends in one shape (see `types/web-search.ts`):
 * Codex's `webSearch` thread items and Claude's `WebSearch` tool results become
 * `{ queries, url?, sources }`.
 */

import type { WebSearchResult, WebSearchSource } from "./types/index.ts";

import type { WebSearchItem } from "./generated/WebSearchItem.ts";

/** Claude's built-in search tool, as the CLI names it. */
export const CLAUDE_WEB_SEARCH = "WebSearch";
/** Claude's built-in page reader, given alongside search. */
export const CLAUDE_WEB_FETCH = "WebFetch";
/** The web tools a Claude thread with `webSearch` gets. Both only read the
 *  web, so they run unasked, as Codex's search does. */
export const CLAUDE_WEB_TOOLS: readonly string[] = [CLAUDE_WEB_SEARCH, CLAUDE_WEB_FETCH];

/** The fields of a Codex `webSearch` item this module reads. */
export type CodexWebSearchItem = Pick<WebSearchItem, "query" | "action" | "results">;

/** Whether a URL is a web page: the only pages the chat links to. */
const isWebUrl = (url: unknown): url is string => typeof url === "string" && /^https?:\/\//i.test(url);

const nonEmpty = (values: Array<string | null | undefined>): string[] =>
  values.map((v) => v?.trim() ?? "").filter((v) => v.length > 0);

/** The `{ title, url }` pages in a list of hits, once each, skipping anything
 *  that isn't a web page. */
function sourcesIn(hits: unknown): WebSearchSource[] {
  if (!Array.isArray(hits)) return [];
  const out: WebSearchSource[] = [];
  for (const hit of hits) {
    if (!hit || typeof hit !== "object") continue;
    const { url, title } = hit as { url?: unknown; title?: unknown };
    if (!isWebUrl(url) || out.some((s) => s.url === url)) continue;
    out.push({ url, title: typeof title === "string" && title.trim() ? decoded(title.trim()) : url });
  }
  return out;
}

/** A title some sites send percent-encoded (`Men%27s`), as it reads. */
function decoded(title: string): string {
  if (!/%[0-9a-f]{2}/i.test(title)) return title;
  try {
    return decodeURIComponent(title);
  } catch {
    return title;
  }
}

/** What a Codex search was for, before it has run: its query when Codex
 *  already knows it. */
export function codexWebSearchArgs(item: Pick<CodexWebSearchItem, "query">): { query?: string } {
  const query = item.query.trim();
  return query ? { query } : {};
}

/** A finished Codex search. Codex mostly sends no results; the answer's
 *  citations then name the pages. A page it opened keeps its URL only when
 *  that is a web page, the same rule its results get. */
export function codexWebSearchResult(item: CodexWebSearchItem): WebSearchResult {
  const action = item.action;
  const queries =
    action?.type === "search" ? nonEmpty(action.queries?.length ? action.queries : [action.query ?? item.query]) : [];
  const opened = action?.type === "openPage" || action?.type === "findInPage" ? action.url : null;
  const url = isWebUrl(opened) ? opened : null;
  return {
    queries: queries.length ? queries : nonEmpty([item.query]),
    ...(url ? { url } : {}),
    sources: sourcesIn(item.results),
  };
}

/**
 * A finished Claude search, from the CLI's structured `tool_use_result`
 * (`{ query, results: [{ content: [{ title, url }] } | string] }`), else from
 * the `Links: [...]` line of the text the model read.
 */
export function claudeWebSearchResult(input: unknown, toolUseResult: unknown, text: string): WebSearchResult {
  const asked = input && typeof input === "object" ? (input as { query?: unknown }).query : undefined;
  const structured = toolUseResult && typeof toolUseResult === "object" ? (toolUseResult as Record<string, unknown>) : null;
  const query = typeof structured?.query === "string" ? structured.query : typeof asked === "string" ? asked : "";
  let sources: WebSearchSource[] = [];
  if (Array.isArray(structured?.results)) {
    sources = sourcesIn(
      structured.results.flatMap((r) => (r && typeof r === "object" ? ((r as { content?: unknown }).content ?? []) : [])),
    );
  } else {
    const links = /^Links: (\[.*\])$/m.exec(text)?.[1];
    if (links) {
      try {
        sources = sourcesIn(JSON.parse(links));
      } catch {
        sources = [];
      }
    }
  }
  return { queries: nonEmpty([query]), sources };
}
