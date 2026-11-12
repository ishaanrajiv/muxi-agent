/**
 * The Claude model catalog: the CLI's session-switcher list normalized into
 * picker rows, the default model, and the effort levels each model takes.
 */

import type { AgentModel } from "../types/index.ts";
import type { EffortLevel, ModelInfo } from "@anthropic-ai/claude-agent-sdk";

import { family, withPreferredDefault } from "../model-defaults.ts";

/** Fallback model for threads that never picked one (pre-catalog or resumed cold).
 *  A bare family alias on purpose: the CLI resolves it to whatever the current
 *  Sonnet is, so this never pins a version the way `claude-sonnet-5` would, and it
 *  matches the picker's own row id (so provider routing and effort clamping — both
 *  keyed on catalog ids — find it). Once the catalog is fetched, the flagged
 *  default row supersedes it; see `ClaudeCodeAgentProvider.defaultModel`. */
export const FALLBACK_MODEL = "sonnet";

/** The SDK's full effort vocabulary — used to sanity-check a requested effort
 *  when the catalog hasn't been fetched yet (the CLI silently downgrades an
 *  unsupported level for the selected model, so passing through is safe). */
const KNOWN_EFFORTS: ReadonlySet<string> = new Set(["low", "medium", "high", "xhigh", "max"]);

/** Group label for the picker — all Claude models sit under one vendor section. */
const VENDOR = "Anthropic";

/**
 * The picker rows for a normalized catalog. The newest Sonnet is this
 * backend's default: a Claude thread that arrives without a pick runs there. It
 * does NOT steal the app's initial selection — the orchestrator lists Codex
 * first, so the aggregate catalog's first flagged row is still Codex's (see
 * `pickDefaultModel`); opting into Claude stays explicit.
 */
export function catalogModels(normalized: NormalizedModel[]): AgentModel[] {
  return withPreferredDefault(
    normalized.map((m) => ({
      id: m.id,
      slug: m.id,
      displayName: m.displayName,
      description: m.description,
      // Technical level names straight from the CLI — no invented labels.
      reasoningEfforts: m.efforts.map((effort) => ({ effort })),
      defaultEffort: preferredEffort(m.efforts),
      isDefault: false,
      ...(m.superseded ? { superseded: true } : {}),
      vendor: VENDOR,
    })),
    [family("sonnet")],
  );
}

/**
 * Clamp a requested effort to what a model supports (`supported`, from the
 * cached catalog). With the catalog cached, an unsupported request falls back
 * to the model's preferred level (or none, for an effort-less model). Before
 * the catalog is fetched, any known SDK level passes through, and the CLI
 * silently downgrades per model.
 */
export function clampEffort(
  supported: string[] | undefined,
  requested: string | undefined,
): EffortLevel | undefined {
  if (supported) {
    if (requested && supported.includes(requested)) return requested as EffortLevel;
    if (supported.length === 0) return undefined;
    return preferredEffort(supported) as EffortLevel;
  }
  if (requested && KNOWN_EFFORTS.has(requested)) return requested as EffortLevel;
  return "medium";
}

/**
 * Default effort for a model's supported levels: "medium" (or a "med…" spelling)
 * when offered, else the first level the CLI lists, else "medium" as a blind
 * fallback for an unknown catalog shape.
 */
function preferredEffort(levels: string[]): string {
  return levels.find((l) => l === "medium" || l.startsWith("med")) ?? levels[0] ?? "medium";
}

/** One normalized catalog entry (intermediate, pre-AgentModel). */
export interface NormalizedModel {
  id: string;
  displayName: string;
  description: string;
  efforts: string[];
  /** A newer version of the same family is in the catalog. */
  superseded: boolean;
}

/** "claude-opus-4-8[1m]" → "Opus 4.8"; "claude-haiku-4-5-20251001" → "Haiku 4.5";
 *  "claude-opus-4-20250514" → "Opus 4". Reads the family + version off a
 *  canonical wire id; a date suffix is never a minor version. Empty when nothing
 *  parses. */
function familyFromResolved(resolved: string): string {
  const m = resolved
    .replace(/\[1m\]$/i, "")
    .replace(/^claude-/i, "")
    .match(/^([a-z]+)-(\d+)(?:-(\d{1,2})(?=-|$))?/i);
  if (!m) return "";
  const name = m[1].charAt(0).toUpperCase() + m[1].slice(1);
  return m[3] ? `${name} ${m[2]}.${m[3]}` : `${name} ${m[2]}`;
}

/** Picker display order for the Anthropic families (strongest first). A model
 *  whose family isn't listed — a newly shipped one we haven't ranked — sorts to the
 *  top rather than the bottom, so a new option is surfaced, never buried. */
const FAMILY_ORDER = ["fable", "opus", "sonnet", "haiku"];

/** "Opus 5.5" → { family: "opus", version: [5, 5] }. Null for a name that isn't
 *  "<Family> <version>", which is never marked superseded. */
function familyVersion(displayName: string): { family: string; version: number[] } | null {
  const m = /^([a-z]+)\s+(\d+(?:\.\d+)*)$/i.exec(displayName.trim());
  return m ? { family: m[1].toLowerCase(), version: m[2].split(".").map(Number) } : null;
}

function compareVersionParts(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function familyRank(displayName: string): number {
  const first = displayName.split(/\s+/)[0]?.toLowerCase() ?? "";
  const i = FAMILY_ORDER.indexOf(first);
  return i === -1 ? -1 : i; // unknown (-1) sorts ahead of the ranked families
}

/**
 * Normalize the CLI's session-switcher catalog into clean, concrete picker
 * entries. The raw list is switcher-shaped, not picker-shaped — e.g.
 * `default` ("Default (recommended)"), `opus[1m]` ("Opus (1M context)"),
 * `claude-fable-5[1m]`. We:
 *  - collapse `[1m]` long-context variants to their base model id — the
 *    context flavor isn't a different model, and the base alias is accepted
 *    (verified live: `opus` → claude-opus-4-8);
 *  - dedupe by the concrete model each row **resolves to** (`resolvedModel`,
 *    minus `[1m]`) rather than its surface alias. The recommended model is
 *    listed twice — once as `default` and once explicitly (e.g. `opus[1m]`) —
 *    so keying on the resolved target collapses that pair to one row. Concrete
 *    aliases are ordered ahead of `default` so first-wins keeps the named row
 *    (its "Opus 4.8 · Best for…" description) and drops the `default` indirection
 *    whose description is a sentence ("Use the default model (currently …)"),
 *    not a picker label;
 *  - build display names as "<Family> <version>" from the resolved wire id (e.g.
 *    "Opus 4.8"), which reads the same whatever copy the CLI ships. Without one,
 *    fall back to a "<Family> <version> · …" description lead (older CLIs), then
 *    to the CLI displayName minus any parenthetical. Never the description alone:
 *    newer CLIs make it a bare sentence ("Best for everyday, complex tasks").
 *    No "Claude" prefix — the picker groups these under the Anthropic vendor
 *    header, so repeating it is redundant noise.
 * A `default` row that resolves to a model listed nowhere else is still kept,
 * named from its resolved id, so no model ever silently disappears.
 * A row is `superseded` when the catalog also lists a newer version of its family
 * (Opus 4.8 next to Opus 5.5). The CLI names no successors itself, so the catalog
 * is the only source. Finally the surviving rows are ordered for the picker by
 * {@link FAMILY_ORDER} (Fable → Opus → Sonnet → Haiku), with any unranked family
 * floated to the top.
 */
export function normalizeCatalog(infos: ModelInfo[]): NormalizedModel[] {
  const resolvedKey = (info: ModelInfo) =>
    (info.resolvedModel ?? "").replace(/\[1m\]$/i, "").trim();
  // Concrete aliases before `default` so first-wins dedup prefers the named row
  // (stable sort keeps the CLI's order otherwise).
  const ordered = [...infos].sort(
    (a, b) => (a.value === "default" ? 1 : 0) - (b.value === "default" ? 1 : 0),
  );
  const out: NormalizedModel[] = [];
  const seen = new Set<string>();
  for (const info of ordered) {
    const resolved = resolvedKey(info);
    // "Opus 4.8 with 1M context · Best for…" → "Opus 4.8". Only a description
    // with a `·` has a lead; the `default` row's is a sentence either way.
    const description = info.description ?? "";
    const lead =
      info.value !== "default" && description.includes("·")
        ? description.split("·")[0]!.replace(/\s+with\s+1M\s+context/i, "").trim()
        : "";
    const family = familyFromResolved(resolved) || lead;
    // Prefer the resolved concrete id when the surface alias is the `default`
    // indirection; otherwise the base alias (`opus`, `sonnet`, …) is what we send.
    const id =
      info.value === "default" && resolved
        ? resolved
        : info.value.replace(/\[1m\]$/i, "");
    const key = resolved || id;
    if (seen.has(key)) continue;
    seen.add(key);
    const displayName = (
      family
        ? family
        : info.displayName.replace(/\s*\([^)]*\)\s*$/, "").trim() || info.value
    ).replace(/^claude\s+/i, "");
    out.push({
      id,
      displayName,
      description: info.description ?? "",
      efforts: info.supportedEffortLevels ?? [],
      superseded: false,
    });
  }
  const newest = new Map<string, number[]>();
  for (const m of out) {
    const fv = familyVersion(m.displayName);
    const best = fv && newest.get(fv.family);
    if (fv && (!best || compareVersionParts(fv.version, best) > 0)) newest.set(fv.family, fv.version);
  }
  for (const m of out) {
    const fv = familyVersion(m.displayName);
    m.superseded = !!fv && compareVersionParts(fv.version, newest.get(fv.family)!) < 0;
  }
  // Order for the picker; ties (and unranked families) keep their pre-sort order.
  return out
    .map((m, i) => ({ m, i }))
    .sort((a, b) => familyRank(a.m.displayName) - familyRank(b.m.displayName) || a.i - b.i)
    .map(({ m }) => m);
}
