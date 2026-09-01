import type { EffortLevel } from "../protocol/events.ts";

/** Ascending. Both SDKs order their own levels this way; it is what "nearest" is measured against. */
export const EFFORT_ORDER: EffortLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/**
 * The level to actually ask for, given what the human wants and what the current model serves.
 *
 * Models disagree about which levels exist — Claude's haiku offers none, pi has an `off` Claude
 * lacks — and a model switch must not fail because a setting made sense for the previous one. So
 * an unavailable level becomes the nearest available one, ties going to the lower (cheaper) side,
 * and a model with no effort control at all returns undefined.
 */
export function clampEffort(wanted: EffortLevel, available: EffortLevel[] | undefined): EffortLevel | undefined {
  if (!available || available.length === 0) return undefined;
  if (available.includes(wanted)) return wanted;

  const target = EFFORT_ORDER.indexOf(wanted);
  let best: EffortLevel | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const level of available) {
    const distance = Math.abs(EFFORT_ORDER.indexOf(level) - target);
    if (distance < bestDistance || (distance === bestDistance && best && below(level, best))) {
      best = level;
      bestDistance = distance;
    }
  }
  return best;
}

function below(left: EffortLevel, right: EffortLevel): boolean {
  return EFFORT_ORDER.indexOf(left) < EFFORT_ORDER.indexOf(right);
}
