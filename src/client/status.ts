import type { SessionLifecycle, SessionStatus, SessionSummary } from "../protocol/commands.ts";

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

/** Stable group identities shared by the host and both clients. */
export type RailGroup = "needs-input" | "unread" | "working" | "idle" | "dormant" | "filed-away";

export const RAIL_GROUPS: readonly RailGroup[] = [
  "needs-input",
  "unread",
  "working",
  "idle",
  "dormant",
  "filed-away",
];

export function railGroup(of: WorkLoad & Pick<SessionSummary, "attention">): RailGroup {
  // Terminal Lifecycle wins over stale independent-work/request indexes. Settle and End file a row
  // away; nothing belonging to a stopped Backend Session can remain answerable above that boundary.
  if (of.status === "settled" || of.status === "ended") return "filed-away";
  if (of.attention?.group === "needs-input") return "needs-input";
  if (of.attention?.group === "unread") return "unread";
  if (of.status === "running" || of.status === "awaiting" || working(of)) return "working";
  if (of.status === "idle") return "idle";
  return "dormant";
}

export function railGroupLabel(group: RailGroup): string {
  switch (group) {
    case "needs-input": return "Needs input";
    case "unread": return "Unread";
    case "working": return "Working";
    case "idle": return "Idle";
    case "dormant": return "Dormant";
    case "filed-away": return "Filed away";
  }
}

export function railGroupRank(of: WorkLoad & Pick<SessionSummary, "attention">): number {
  return RAIL_GROUPS.indexOf(railGroup(of));
}

/**
 * What both the rail's banding and its status dot are asked about: work, whoever is doing it.
 *
 * The transcript-derived counts are required. Workflow activity is optional because a live Chrome
 * snapshot deliberately knows only the Presentation Transcript, while a SessionSummary augments it
 * from the workflow scheduler.
 */
export type WorkLoad = {
  status: SessionStatus;
  activeSubagents: number;
  activeBackgroundCalls: number;
  /** Optional so live Chrome snapshots from the Presentation Transcript remain a valid workload. */
  activeWorkflows?: number;
};

/**
 * Working, but not occupancy. A backgrounded Subagent or an open Background Call leaves the status
 * `idle` (ADR 0016, ADR 0021) and must not change it — the Steering Queue really will dispatch — but
 * something *is* running, and both the rail's banding and its status dot answer "is it working?"
 * rather than "is the model holding a turn?".
 *
 * The independent-work counts are summed here and nowhere else: this is the only question that does
 * not care which kind is working.
 *
 * Only `idle` is liftable. Neither a Subagent nor a Background Call can outlive its Backend Session,
 * and a running Workflow Execution owns a live one, so a count on anything else is stale rather than
 * live work.
 */
export function working(of: WorkLoad): boolean {
  return of.status === "idle" && of.activeSubagents + of.activeBackgroundCalls + (of.activeWorkflows ?? 0) > 0;
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
