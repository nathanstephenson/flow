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
  if (!capabilities) return [];
  const byProvider = new Map<string, ModelInfo[]>();
  for (const model of capabilities.models) {
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
