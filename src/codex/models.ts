/**
 * The Codex model catalog: `model/list` rows as picker entries, in picker
 * order, and the effort scale each model offers.
 */

import type { AgentModel } from "../types/index.ts";

import type { Model } from "../generated/v2/Model.ts";
import {
  exactly,
  family,
  markSupersededByTier,
  orderByVersionThenTier,
  withPreferredDefault,
} from "../model-defaults.ts";
import { epochToIso } from "../shared.ts";

/**
 * OpenAI's codenames, strongest first. Used only to order the picker inside one
 * version, where the version number itself says nothing (5.6-Sol vs 5.6-Luna).
 * A codename not listed here sorts below the listed ones, so an unrecognized
 * model still shows up rather than jumping the queue.
 */
const CODENAME_TIERS = ["astra", "sol", "terra", "luna"] as const;

/** The effort scale one model offers, from its `model/list` row. */
export interface EffortScale {
  efforts: string[];
  defaultEffort: string | null;
}

export function effortScale(m: Model): EffortScale {
  return {
    efforts: m.supportedReasoningEfforts.map((o) => o.reasoningEffort),
    defaultEffort: m.defaultReasoningEffort ?? null,
  };
}

/**
 * Clamp a requested effort to what a model supports: an effort outside the
 * catalog's scale falls back to that model's own default, and a model with no
 * scale at all gets none. Passes the request through untouched when there is
 * no catalog for the model yet (`scale` undefined), and Codex then applies its
 * own default.
 */
export function clampEffort(scale: EffortScale | undefined, requested: string): string | undefined {
  if (!scale) return requested;
  if (scale.efforts.includes(requested)) return requested;
  if (scale.efforts.length === 0) return undefined;
  return scale.defaultEffort ?? undefined;
}

/**
 * The visible catalog in picker order — newest version first, then by codename
 * tier — because `model/list` itself comes back unsorted (5.6-Sol, 5.6-Terra,
 * 5.6-Luna, 6-Astra, 5.5).
 *
 * The app-server's own `isDefault` flag is re-pointed at our preference — the
 * newest Luna model, else the newest Terra, else GPT-5.5 — matched by family
 * name so a point release (5.6-Luna → 5.7-Luna) is adopted with no code
 * change. Terra stays as the rung below Luna for a CLI whose catalog does not
 * offer Luna yet. None of them offered (an older/limited login) leaves
 * Codex's own flag alone.
 */
export function pickerModels(visible: Model[]): AgentModel[] {
  return orderByVersionThenTier(
    withPreferredDefault(markSupersededByTier(visible.map(toDomainModel), CODENAME_TIERS), [
      family("luna"),
      family("terra"),
      exactly("gpt-5.5"),
    ]),
    CODENAME_TIERS,
  );
}

/** Codex's own catalog names models like "GPT-5.6-Sol" — swap the codename's
 * leading hyphen for a space ("GPT-5.6 Sol") to match normal title casing. */
function formatCodexDisplayName(name: string): string {
  return name.replace(/^(GPT-\d+(?:\.\d+)?)-(\S+)/, "$1 $2");
}

function toDomainModel(m: Model): AgentModel {
  const retiresAt = epochToIso(m.upgradeInfo?.retirementAt ?? null);
  return {
    id: m.id,
    slug: m.model,
    displayName: formatCodexDisplayName(m.displayName),
    description: m.description,
    reasoningEfforts: m.supportedReasoningEfforts.map((o) => ({
      effort: o.reasoningEffort,
      description: o.description,
    })),
    defaultEffort: m.defaultReasoningEffort,
    serviceTiers: (m.serviceTiers ?? []).map((tier) => ({
      id: tier.id,
      name: tier.name,
      description: tier.description,
    })),
    isDefault: m.isDefault,
    ...(m.upgrade ? { superseded: true } : {}),
    ...(retiresAt ? { retiresAt } : {}),
    vendor: "OpenAI",
  };
}
