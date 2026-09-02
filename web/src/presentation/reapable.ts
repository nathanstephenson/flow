import type { SessionSummary } from "../../../src/protocol/commands.ts";
import { parseDuration } from "../../../src/protocol/settings.ts";

/**
 * Which Agent Sessions a retention window would reap, worked out client-side.
 *
 * The Session Host is what actually reaps, and this deliberately does not ask it: a summary already
 * carries `status` and `updatedAt`, which is the whole of what `SessionHost.reap` compares (ADR
 * 0006). So the Settings page can tell a reader what shortening the window costs *before* they save
 * it, without a second endpoint whose only job is to count.
 *
 * It has to stay in step with the reaper, which is the risk in doing it here — hence the two rules
 * restated rather than paraphrased: only Settled Agent Sessions are ever reaped, and a timestamp
 * that will not parse is left alone, because not knowing something's age is not a reason to delete
 * it.
 *
 * DOM-free and under test, like everything else in this directory.
 */
export function reapableAt(
  sessions: readonly SessionSummary[],
  window: string,
  now: number,
): SessionSummary[] {
  // "never" reaps nothing, and neither does a window this daemon would refuse — a half-typed
  // duration must not flash a scary count at the reader mid-keystroke.
  if (window === "never") return [];
  const retention = parseDuration(window);
  if (retention === undefined || retention <= 0) return [];

  return sessions.filter((session) => {
    if (session.status !== "settled") return false;
    const settledAt = Date.parse(session.updatedAt);
    if (Number.isNaN(settledAt)) return false;
    return now - settledAt >= retention;
  });
}
