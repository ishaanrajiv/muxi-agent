/**
 * Which model a backend hands out when nobody picked one.
 *
 * Both backends list their catalogs live (Codex `model/list`, Claude
 * `supportedModels()`), so the *policy* — "the newest Sonnet", "Luna, else Terra,
 * else GPT-5.5" — has to be expressed as a match against whatever the catalog
 * happens to offer today, never as a pinned model id. A family matcher that
 * hits several rows resolves to the highest version, so a new point release is
 * adopted the moment the CLI ships it.
 */

import type { AgentModel } from "./types/index.ts";

/** Effort every default lands on when the model offers it, so a turn that
 *  names no effort and a caller showing the model's default agree. */
const PREFERRED_EFFORT = "medium";

/** Every string a family/version matcher may look at, lowercased. */
function haystack(m: AgentModel): string {
  return `${m.id} ${m.slug} ${m.displayName}`.toLowerCase();
}

/** The first dotted version on the first name that carries one, display name
 *  first: "GPT-6.1 Sol" → [6, 1]; "claude-sonnet-5" → [5]. One name only, since
 *  joining all three repeats the digits and ranks "6 6 6" above "6.1 6.1".
 *  Empty when nothing numeric appears. */
function versionKey(m: AgentModel): number[] {
  for (const name of [m.displayName, m.id, m.slug]) {
    const v = name.match(/\d+(?:\.\d+)*/);
    if (v) return v[0].split(".").map(Number);
  }
  return [];
}

/** Component-wise version compare; a missing component counts as 0. */
function compareVersions(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** Matches any model whose names mention `family` as a whole word — "sonnet",
 *  "luna". Deliberately name-based: it survives a version bump. */
export function family(name: string): (m: AgentModel) => boolean {
  const re = new RegExp(`(^|[^a-z])${name.toLowerCase()}([^a-z]|$)`);
  return (m) => re.test(haystack(m));
}

/** Matches one exact catalog id/slug — the last-resort rung of a preference
 *  list (e.g. `gpt-5.5` when no Luna or Terra model is offered). */
export function exactly(id: string): (m: AgentModel) => boolean {
  const want = id.toLowerCase();
  return (m) => m.id.toLowerCase() === want || m.slug.toLowerCase() === want;
}

/**
 * Re-flag `models` so exactly one row carries `isDefault`, chosen by walking
 * `preferences` in order: the first matcher with any hits wins, and among its
 * hits the highest version does (catalog order breaks a tie). The winner's
 * `defaultEffort` is pinned to "medium" when it supports that level.
 *
 * No matcher hits → the list is returned untouched, so a backend that already
 * flags its own default (Codex) keeps it rather than losing one entirely.
 */
export function withPreferredDefault(
  models: AgentModel[],
  preferences: ReadonlyArray<(m: AgentModel) => boolean>,
): AgentModel[] {
  let winner: AgentModel | undefined;
  for (const matches of preferences) {
    const hits = models.filter(matches);
    if (hits.length === 0) continue;
    winner = hits.reduce((best, m) =>
      compareVersions(versionKey(m), versionKey(best)) > 0 ? m : best,
    );
    break;
  }
  if (!winner) return models;
  return models.map((m) =>
    m === winner
      ? {
          ...m,
          isDefault: true,
          ...(m.reasoningEfforts.some((e) => e.effort === PREFERRED_EFFORT)
            ? { defaultEffort: PREFERRED_EFFORT }
            : {}),
        }
      : { ...m, isDefault: false },
  );
}

/**
 * Catalog order for a picker: newest first, codename-ranked.
 *
 * A backend lists its models in an order of its own — Codex's `model/list`
 * returns 5.6-Sol, 5.6-Terra, 5.6-Luna, 6-Astra, 5.5 — which reads as unsorted
 * in a menu. Rank by version descending, then by the tier a codename names, so
 * the strongest current model is always the top row. Codenames outside `tiers`
 * (and models carrying none) sort last within their version and keep catalog
 * order among themselves, so a codename the CLI ships tomorrow still appears.
 */
export function orderByVersionThenTier(
  models: AgentModel[],
  tiers: readonly string[],
): AgentModel[] {
  const rank = (m: AgentModel): number => {
    const i = tiers.findIndex((t) => family(t)(m));
    return i === -1 ? tiers.length : i;
  };
  return models
    .map((m, i) => ({ m, i }))
    .sort(
      (a, b) =>
        compareVersions(versionKey(b.m), versionKey(a.m)) ||
        rank(a.m) - rank(b.m) ||
        a.i - b.i,
    )
    .map((e) => e.m);
}

/**
 * Flag a model `superseded` when the catalog also lists a newer version of its
 * codename tier (GPT-5.6 Luna next to GPT-6 Luna), so the picker can fold it
 * under Older models. A model already flagged stays flagged, and one that names
 * no tier is left to the backend's own successor pointer.
 */
export function markSupersededByTier(
  models: AgentModel[],
  tiers: readonly string[],
): AgentModel[] {
  const newest = new Map<string, number[]>();
  for (const tier of tiers) {
    for (const m of models.filter(family(tier))) {
      const best = newest.get(tier);
      if (!best || compareVersions(versionKey(m), best) > 0) newest.set(tier, versionKey(m));
    }
  }
  return models.map((m) => {
    if (m.superseded) return m;
    const tier = tiers.find((t) => family(t)(m));
    const best = tier ? newest.get(tier) : undefined;
    return best && compareVersions(versionKey(m), best) < 0 ? { ...m, superseded: true } : m;
  });
}
