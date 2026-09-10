import type { SessionLifecycle, SessionStatus } from "../protocol/commands.ts";

/**
 * The rules both front-ends need for turning a status into affordances. Shared because they are
 * assertions about the Session Host's behaviour, not about any one UI: getting them wrong means
 * offering an action the host will refuse.
 */

/**
 * The one place an Agent Session's activity is worked out.
 *
 * Called by the Session Host and by the client reducer against the same three inputs, so the rail
 * and the pane agree by construction rather than by two hand-maintained switch statements happening
 * to line up — which is the bug `retention.test.ts` exists to catch.
 *
 * A backgrounded Subagent is deliberately absent from the inputs. It is not occupancy (ADR 0016):
 * the model is idle and the Steering Queue may dispatch, so saying `running` here would be a lie
 * that also blocks steering. It travels as `SessionSummary.activeSubagents` instead.
 */
export function deriveStatus(of: {
  lifecycle: SessionLifecycle;
  turnInFlight: boolean;
  awaiting: boolean;
}): SessionStatus {
  if (of.lifecycle !== "live") return of.lifecycle;
  if (of.awaiting) return "awaiting";
  return of.turnInFlight ? "running" : "idle";
}

/**
 * Whether a turn holds this Agent Session — the question almost every caller comparing against
 * `"running"` was really asking.
 *
 * Awaiting is a turn held open on a person rather than on a model, so everything that must not
 * happen mid-turn must not happen then either. Written as a predicate because widening
 * `SessionStatus` cannot be caught by the compiler at a `=== "running"`: the comparison stays valid
 * and quietly starts returning false.
 */
export function occupied(status: SessionStatus): boolean {
  return status === "running" || status === "awaiting";
}

/** Nothing to Settle once it is Settled, and an Ended Agent Session cannot be. */
export function canSettle(status: SessionStatus): boolean {
  return status !== "settled" && status !== "ended";
}

/**
 * Dormant and Settled both take a Revive; Ended refuses one outright, and any of the derived
 * activities means the Lifecycle is `live` and a Backend Session is already attached (ADR 0003).
 */
export function canRevive(status: SessionStatus): boolean {
  return status === "dormant" || status === "settled";
}
