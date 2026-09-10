import type { Capabilities, EffortLevel, ModelInfo } from "../protocol/events.ts";
import type { ViewState } from "./reduce.ts";

/**
 * The model and Effort pickers' data, shared rather than duplicated: both front-ends offer the same
 * two controls, so the grouping and the "which levels does this model offer" rule live here.
 *
 * DOM-free on purpose — this module is compiled by the Node program as well as the web one.
 */

export type ModelChoice = { provider: string; model: ModelInfo };

/** Models grouped by provider. Claude offers one group, pi offers dozens; the list is the same. */
export function modelChoices(capabilities: Capabilities | undefined): ModelChoice[] {
  return modelChoicesOf(capabilities?.models);
}

/**
 * The same grouping, from a bare list.
 *
 * `Capabilities` is how a model list arrives inside an Agent Session, and `GET /api/models` is how
 * it arrives before there is one (ADR 0020) — the New Agent Session view reads the second. Only
 * `.models` was ever used here, so taking the list is the whole of the generalisation, and
 * `modelChoices` keeps its signature so the TUI is untouched.
 */
export function modelChoicesOf(models: readonly ModelInfo[] | undefined): ModelChoice[] {
  if (!models) return [];
  const byProvider = new Map<string, ModelInfo[]>();
  for (const model of models) {
    const provider = model.provider ?? "other";
    byProvider.set(provider, [...(byProvider.get(provider) ?? []), model]);
  }
  return [...byProvider.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([provider, models]) => models.map((model) => ({ provider, model })));
}

/**
 * The Effort levels on offer, which belong to the model in force rather than to the session — a
 * model without an effort control returns none and the picker has nothing to show.
 */
export function effortChoices(view: ViewState): EffortLevel[] {
  const current = view.capabilities?.models.find((model) => model.id === view.model?.id);
  return (current ?? view.model)?.effortLevels ?? [];
}
