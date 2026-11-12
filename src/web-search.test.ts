import assert from "node:assert/strict";
import { test } from "node:test";

import { claudeWebSearchResult, codexWebSearchResult } from "./web-search.ts";

const hit = (title: string, url: string) => ({ title, url });

test("a web search from either backend reads as its queries, the page it opened and its pages, once each", () => {
  const cases: Array<[string, ReturnType<typeof codexWebSearchResult>, unknown]> = [
    [
      "Claude's structured result, skipping prose entries, repeats and non-web links",
      claudeWebSearchResult(
        { query: "ipl final date" },
        {
          query: "IPL 2026 final date",
          results: [
            "Here is what I found.",
            { tool_use_id: "s1", content: [hit("IPL final", "https://www.iplt20.com/final"), hit("x", "javascript:alert(1)")] },
            { tool_use_id: "s2", content: [hit("IPL final", "https://www.iplt20.com/final"), hit("", "https://espn.in/ipl")] },
            { tool_use_id: "s3", content: [hit("2026 Men%27s final", "https://en.wikipedia.org/x"), hit("100% fit", "https://a.in/")] },
          ],
        },
        "",
      ),
      {
        queries: ["IPL 2026 final date"],
        sources: [
          hit("IPL final", "https://www.iplt20.com/final"),
          hit("https://espn.in/ipl", "https://espn.in/ipl"),
          hit("2026 Men's final", "https://en.wikipedia.org/x"),
          hit("100% fit", "https://a.in/"),
        ],
      },
    ],
    [
      "Claude's text when the CLI sent no structured result",
      claudeWebSearchResult(
        { query: "solstice 2026" },
        undefined,
        'Web search results for query: "solstice 2026"\n\nLinks: [{"title":"Solstice","url":"https://example.org/solstice"}]\n\nSolstice falls on 8 November.',
      ),
      { queries: ["solstice 2026"], sources: [hit("Solstice", "https://example.org/solstice")] },
    ],
    [
      "Codex's several queries with no results",
      codexWebSearchResult({
        query: "",
        action: { type: "search", query: null, queries: ["monsoon onset kerala 2026", " "] },
        results: null,
      }),
      { queries: ["monsoon onset kerala 2026"], sources: [] },
    ],
    [
      "Codex opening one page",
      codexWebSearchResult({ query: "", action: { type: "openPage", url: "https://docs.example.com/x" }, results: null }),
      { queries: [], url: "https://docs.example.com/x", sources: [] },
    ],
    [
      "Codex finding text in one page",
      codexWebSearchResult({
        query: "",
        action: { type: "findInPage", url: "https://docs.example.com/y", pattern: "install" },
        results: null,
      }),
      { queries: [], url: "https://docs.example.com/y", sources: [] },
    ],
    [
      "Codex opening a page that isn't a web page",
      codexWebSearchResult({ query: "", action: { type: "openPage", url: "file:///etc/passwd" }, results: null }),
      { queries: [], sources: [] },
    ],
  ];
  for (const [name, actual, expected] of cases) assert.deepEqual(actual, expected, name);
});
