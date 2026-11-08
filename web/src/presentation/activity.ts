import type { Entry } from "../../../src/client/reduce.ts";
import { relativeTime } from "../../../src/client/relative-time.ts";

/**
 * What is running in an Agent Session that its status does not say.
 *
 * Its own module rather than a corner of `composer-hint.ts`, which scopes itself to "what the
 * composer says about the message you are about to send". None of this is about the next message —
 * it is about work already in flight — and the rail needs the same sentence for its accessible text,
 * so a rail importing from the composer's module would be a lie about why the words exist.
 *
 * Typed on a structural shape rather than on `Chrome`, because the rail's `SessionSummary` adds
 * Workflow Execution activity to the two transcript-derived counts. Chrome remains a valid caller
 * without pretending workflows are part of the Presentation Transcript.
 */
export type Activity = {
  activeSubagents: number;
  activeBackgroundCalls: number;
  /** Present on rail summaries; Chrome snapshots intentionally remain transcript-only. */
  activeWorkflows?: number;
};

/**
 * The one sentence for what is working, or undefined when nothing is.
 *
 * Undefined rather than an empty string, so a caller's question is "is anything working" rather than
 * "is the text empty" — the shape `contextUsageDetail` uses for "nothing honest to say".
 *
 * Subagents lead. Each count is floored at zero **independently**: they are maintained by
 * transitions, so one that underflows must not be able to erase another clause.
 */
export function activityLabel(of: Activity): string | undefined {
  const agents = Math.max(0, of.activeSubagents);
  const calls = Math.max(0, of.activeBackgroundCalls);
  const workflows = Math.max(0, of.activeWorkflows ?? 0);
  const clauses = [
    agents > 0 ? `${agents} agent${agents === 1 ? "" : "s"}` : undefined,
    calls > 0 ? `${calls} background call${calls === 1 ? "" : "s"}` : undefined,
    workflows > 0 ? `${workflows} workflow${workflows === 1 ? "" : "s"}` : undefined,
  ].filter((clause): clause is string => clause !== undefined);
  if (clauses.length === 0) return undefined;
  // One verb for every clause: several sentences would repeat "running" about one fact.
  const joined = clauses.length < 3
    ? clauses.join(" and ")
    : `${clauses.slice(0, -1).join(", ")} and ${clauses.at(-1)}`;
  return `${joined} running`;
}

/**
 * The status word plus what is working, for a reader not looking at colour or shape.
 *
 * Reuses `activityLabel` rather than phrasing it again, so the wording lives in one place. The
 * status leads, because that is what the rail dot's own shape encodes.
 */
export function activityStatusText(of: Activity & { status: string }): string {
  const label = activityLabel(of);
  return label === undefined ? of.status : `${of.status}, ${label}`;
}

/**
 * When a Background Call started, or what became of it and when.
 *
 * Its own function rather than a widened `timing` from `subagent-list.ts`: that module is about
 * ordering a list, which Background Calls do not have, and a terminal Call is labelled by what
 * happened to it for the reason stated there — a row that said "completed" for an aborted Call
 * would hide the outcome worth noticing.
 */
export function backgroundTiming(
  entry: Extract<Entry, { kind: "background_call" }>,
  now: number,
): { label: string; at: string } {
  switch (entry.status) {
    case "running":
      return { label: "started", at: relativeTime(entry.startedAt, now) };
    case "complete":
      return { label: "finished", at: relativeTime(entry.endedAt ?? entry.startedAt, now) };
    case "aborted":
      return { label: "stopped", at: relativeTime(entry.endedAt ?? entry.startedAt, now) };
    case "error":
      return { label: "failed", at: relativeTime(entry.endedAt ?? entry.startedAt, now) };
  }
}
