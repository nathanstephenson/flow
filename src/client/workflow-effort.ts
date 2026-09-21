import type { BackendModels, EffortLevel, ModelInfo } from "../protocol/events.ts";
import type { WorkflowDefinition } from "../protocol/workflows.ts";
import { initialWorkflowEffort } from "./model-choices.ts";

/**
 * Effort after choosing a workflow model. Existing configured values remain untouched when invalid;
 * only the first selection gets a confirmed default, while no-control always uses the `off`
 * sentinel.
 */
export function effortForWorkflowModelSelection(
  currentModelId: string,
  currentEffort: EffortLevel,
  nextModel: ModelInfo,
): EffortLevel {
  if ((nextModel.effortLevels?.length ?? 0) === 0) return "off";
  return currentModelId === "" ? initialWorkflowEffort(nextModel) : currentEffort;
}

/** The one allowed automatic workflow correction: confirmed no-control always stores `off`. */
export function normalizeNoControlEffort(
  definition: WorkflowDefinition | undefined,
  catalogue: BackendModels[] | undefined,
): WorkflowDefinition | undefined {
  if (!definition || !catalogue) return definition;
  const listing = catalogue.find((entry) => entry.backend === definition.backend);
  if (!listing || listing.problem) return definition;
  let changed = false;
  const steps = definition.steps.map((step) => {
    if (step.kind !== "agent") return step;
    const model = listing.models.find((candidate) => candidate.id === step.model);
    if (!model || (model.effortLevels?.length ?? 0) > 0 || step.effort === "off") return step;
    changed = true;
    return { ...step, effort: "off" as const };
  });
  return changed ? { ...definition, steps } : definition;
}
