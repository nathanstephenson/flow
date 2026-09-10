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
 * Typed on a structural shape rather than on `Chrome`, because `SessionSummary` carries the same two
 * counts and the rail is the other caller. Both satisfy this without an adapter.
 */
export type Activity = { activeSubagents: number; activeBackgroundCalls: number };

/**
 * The one sentence for both surfaces, or undefined when nothing is working.
 *
 * Undefined rather than an empty string, so a caller's question is "is there a strip" rather than
 * "is the strip's text empty" — the shape `contextUsageDetail` uses for "nothing honest to say".
 *
 * Subagents lead because theirs is the half with a destination, and the strip is read left-to-right
 * into its own chevron. Each count is floored at zero **independently**: both are maintained by
 * transitions, so one that underflows must not be able to erase the other's clause.
 */
export function activityLabel(of: Activity): string | undefined {
  const agents = Math.max(0, of.activeSubagents);
  const calls = Math.max(0, of.activeBackgroundCalls);
  const clauses = [
    agents > 0 ? `${agents} agent${agents === 1 ? "" : "s"}` : undefined,
    calls > 0 ? `${calls} background call${calls === 1 ? "" : "s"}` : undefined,
  ].filter((clause): clause is string => clause !== undefined);
  if (clauses.length === 0) return undefined;
  // One verb for both clauses: two sentences would say "running" twice about one fact.
  return `${clauses.join(" and ")} running`;
}

/**
 * Whether the strip is a link or a readout.
 *
 * A Background Call has no pane to open — the Subagents Pane exists to drill into one Subagent's
 * nested transcript, and a Background Call attributes nothing, so a row for it would link nowhere.
 * A strip reporting only Background Calls is therefore rendered inert, because a readout with no
 * destination should not pretend to be a button.
 */
export function stripOpensSubagents(of: Activity): boolean {
  return of.activeSubagents > 0;
}

/**
 * The status word plus what is working, for a reader not looking at colour or shape.
 *
 * Reuses `activityLabel` rather than phrasing it again: the rail's dot and the composer's strip are
 * two renderings of one fact, and two surfaces inventing two wordings is what drifts. The status
 * leads, because that is what the dot's own shape encodes.
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
