import { getSupportedThinkingLevels, type Api, type Model } from "@earendil-works/pi-ai";

import type { EffortLevel } from "../../protocol/events.ts";

/**
 * Pi Effort support is a property of the SDK model, not of the currently selected AgentSession.
 *
 * `AgentSession.getAvailableThinkingLevels()` delegates to this SDK function, but can only answer
 * for its selected model. Calling the same function on each authenticated registry entry is how the
 * catalogue, a live session and a workflow child all get one answer without changing selection.
 *
 * The SDK represents a non-reasoning model as accepting only `off`. Flow treats that as the
 * no-control sentinel: it is valid internally for workflows, but is not a choice to offer a human.
 */
type PiEffortModel = {
  reasoning?: boolean | undefined;
  thinkingLevelMap?: Model<Api>["thinkingLevelMap"] | undefined;
};

export function piEffortLevels(model: PiEffortModel): EffortLevel[] {
  if (!model.reasoning) return [];
  // The SDK helper reads only the two fields retained above; registry models carry the full shape.
  return getSupportedThinkingLevels(model as Model<Api>) as EffortLevel[];
}

/** Exact workflow validation, including the internal sentinel for a confirmed no-control model. */
export function piAcceptsWorkflowEffort(model: PiEffortModel, effort: EffortLevel): boolean {
  const levels = piEffortLevels(model);
  return levels.length === 0 ? effort === "off" : levels.includes(effort);
}
