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

/**
 * Which band of the rail an Agent Session belongs to, most alive first.
 *
 * The rail is banded rather than ordered by one timestamp, because a single recency key put a
 * finished Agent Session above one that was still working — and the top of a list is where a reader
 * looks for what is happening. Banding fixes that without reintroducing churn: a row moves when its
 * band changes and at no other time, so a turn can stream for an hour without touching the order.
 *
 * Ended has no band of its own. An Ended Agent Session is not reaped and stays in the list, and it
 * is as finished as a Settled one, so it sits with them at the bottom.
 */
export function railBand(of: { status: SessionStatus; activeSubagents: number }): number {
  if (of.status === "awaiting") return 0;
  if (of.status === "running") return 1;
  /*
   * Working, but not occupancy. A backgrounded Subagent leaves the status `idle` (ADR 0016) and
   * must not change it — but something is running, and a rail that sank it below an Agent Session
   * that finished yesterday would hide the very thing its owner wanted to watch.
   *
   * Only `idle` is liftable. A Subagent cannot outlive its Backend Session, so a count on anything
   * else is a stale index rather than live work, and lifting a Dormant Agent Session above a
   * working one on the strength of it would be a plain lie.
   */
  if (of.status === "idle") return of.activeSubagents > 0 ? 1 : 2;
  if (of.status === "dormant") return 3;
  return 4;
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
