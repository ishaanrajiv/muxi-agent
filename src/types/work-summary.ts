/**
 * Provider-neutral, user-facing summaries of agent work.
 *
 * Providers return very different reasoning-summary shapes: Codex commonly
 * emits markdown headings, while Claude can emit paragraphs of prose. This
 * module normalizes both into small summary rows so a consumer never has to
 * infer a provider from formatting. Raw reasoning is deliberately not modeled;
 * these are summaries suitable for display.
 */

import { z } from "zod";

export const WorkSummaryStep = z.object({
  /** Short, scannable row label. */
  label: z.string(),
  /** Optional visible detail. Absent means the row is not expandable. */
  detail: z.string().optional(),
});
export type WorkSummaryStep = z.infer<typeof WorkSummaryStep>;

const HTML_COMMENT = /<!--[\s\S]*?-->/g;
const HEADER = /(?:^|\n)[ \t]*\*\*([^\n]+?)(?:\*\*|$)/g;
const MAX_LABEL = 120;

function visibleText(text: string): string {
  return text.replace(HTML_COMMENT, "").trim();
}

function labelOf(text: string): { label: string; consumed: number } {
  const sentence = text.match(/^.*?[.!?](?:\s|$)/s)?.[0]?.trim();
  const candidate = sentence || text.split("\n", 1)[0].trim() || text.trim();
  // Only treat the lead sentence as a label when it's short enough to scan.
  // A long lead is never split: the whole paragraph is the label (consumed 0),
  // and the row that folds it to one line opens to it in full, so the text is
  // never lost or repeated.
  if (candidate.length <= MAX_LABEL) return { label: candidate, consumed: candidate.length };
  return { label: text.trim(), consumed: 0 };
}

/**
 * Normalize legacy/provider summary text into display-safe rows.
 *
 * - `**Header**` blocks retain their header and only expose a disclosure when
 *   the body has visible content (HTML comments do not count).
 * - Free-form prose becomes one row per paragraph, titled by its first sentence.
 * - Plain short lines become non-expandable rows.
 */
export function normalizeWorkSummary(text: string): WorkSummaryStep[] {
  const source = text.trim();
  if (!source) return [];

  const headings = Array.from(source.matchAll(HEADER));
  if (headings.length > 0 && (headings[0].index ?? -1) === 0) {
    return headings.flatMap((heading, index) => {
      const label = visibleText(heading[1]);
      if (!label) return [];
      const bodyFrom = (heading.index ?? 0) + heading[0].length;
      const bodyTo = index + 1 < headings.length ? (headings[index + 1].index ?? source.length) : source.length;
      const detail = visibleText(source.slice(bodyFrom, bodyTo));
      return [{ label, ...(detail ? { detail } : {}) }];
    });
  }

  // Strip comments BEFORE splitting: a comment spanning a blank line would
  // otherwise be cut in half, and its fragments (`<!-- …`, `… -->`) survive
  // visibleText — which only matches complete comments — as visible rows.
  return visibleText(source)
    .split(/\n\s*\n+/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .flatMap((paragraph) => {
      const { label, consumed } = labelOf(paragraph);
      if (!label) return [];
      // Split into a lead label + expandable detail only when the lead is a
      // clean short sentence. Otherwise the whole paragraph is the row (no
      // detail) and opens in full — never a clipped label plus a duplicate body.
      if (consumed === 0) return [{ label }];
      const detail = visibleText(paragraph.slice(consumed).trim());
      return [{ label, ...(detail && detail !== label ? { detail } : {}) }];
    });
}
