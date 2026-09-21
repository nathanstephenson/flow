import type { Capabilities, EffortLevel, ModelInfo } from "../protocol/events.ts";
import type { ViewState } from "./reduce.ts";

/**
 * The model and Effort pickers' data, shared rather than duplicated: both front-ends offer the same
 * two controls, so the grouping and the "which levels does this model offer" rule live here.
 *
 * DOM-free on purpose — this module is compiled by the Node program as well as the web one.
 */

export type ModelChoice = { provider: string; model: ModelInfo };

export type EffortCapability =
  | { status: "supported"; levels: EffortLevel[] }
  | { status: "none"; levels: [] }
  | { status: "unknown"; levels: []; reason: string };

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
 * Classify effort support without collapsing an absent/stale capability list into confirmed
 * no-control. Only a model found in a confirmed list can produce `none`.
 */
export function effortCapability(
  capabilities: Capabilities | undefined,
  model: ModelInfo | undefined,
): EffortCapability {
  if (!capabilities) return { status: "unknown", levels: [], reason: "Effort support is still loading." };
  if (!model) return { status: "unknown", levels: [], reason: "Select a model to confirm Effort support." };
  const current = capabilities.models.find((candidate) => candidate.id === model.id);
  if (!current) return { status: "unknown", levels: [], reason: `Effort support for ${model.label ?? model.id} is unavailable.` };
  const levels = current.effortLevels ?? [];
  return levels.length > 0 ? { status: "supported", levels: [...levels] } : { status: "none", levels: [] };
}

/** The confirmed choices shared by the web and terminal pickers. */
export function effortChoices(view: ViewState): EffortLevel[] {
  return effortCapability(view.capabilities, view.model).levels;
}

/** First-model workflow default; never manufactures an unverified `medium`. */
export function initialWorkflowEffort(model: ModelInfo): EffortLevel {
  const levels = model.effortLevels ?? [];
  if (levels.length === 0) return "off";
  return levels.includes("medium") ? "medium" : levels[0]!;
}
