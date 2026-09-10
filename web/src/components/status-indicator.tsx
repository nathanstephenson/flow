import type { SessionStatus } from "../../../src/protocol/commands.ts";
import { cn } from "@/lib/utils.ts";

/**
 * Status, made visual.
 *
 * The rail's rows carry no status word any more, so the dot there is the entire signal and it has to
 * say more than "attached or not". Two things carry it.
 *
 * *Shape* keeps the question `canRevive` answers: the dot is **filled** while a Backend Session is
 * attached and a **hollow ring** when none is. That is the older rule and it is unchanged.
 *
 * *Hue* is spent only on the two states that are asking something of the reader: Running, which is
 * `--status-active`, and Awaiting — the reader's turn, the one state that will sit there until they
 * come back — which is `--status-awaiting`. A hue means *look at this*, so it has to leave when the
 * turn does. Idle wore Running's blue dimmed for a while and it read as "still going" from across
 * the room, which is the opposite of what a finished turn should say.
 *
 * Awaiting is produced by an open Enquiry (ADR 0016) or an open Permission Prompt (ADR 0018). It
 * sat here unreachable for two decisions before the Session Host had a word for it.
 *
 * Background Subagents wear Running's hue through `working`. They are still not occupancy (ADR 0016)
 * — the status stays Idle and steering into it works — but the dot answers "is something happening
 * here?", and that is one question with one answer. A second smaller mark elsewhere in the row said
 * the same thing in a place nothing else was a status, and read as an unexplained speck.
 *
 * So everything else is the monochrome the rest of this app is. Idle is plain `foreground` and
 * filled; Dormant the same `foreground` as a ring; Settled a muted ring; Ended keeps `--destructive`,
 * because a dead Agent Session is the one status that is a problem. Idle and Dormant sharing a
 * colour costs nothing — the fill already separates them, and it separates them on the axis that
 * matters, which is whether reviving costs anything.
 *
 * Two hues and no more. Five would be a status board; these are a monochrome list with something
 * happening in it.
 *
 * These are static class strings rather than a runtime `var()` lookup so Tailwind's scanner can see
 * every one of them — the old lookup assembled a custom-property name at runtime, which is exactly
 * the shape a scanner cannot follow.
 */

const DOT_TEXT: Record<SessionStatus, string> = {
  running: "text-status-active",
  idle: "text-foreground",
  awaiting: "text-status-awaiting",
  dormant: "text-foreground",
  settled: "text-muted-foreground",
  ended: "text-destructive",
};

/**
 * Filled means a Backend Session is attached. Hollow means nothing is running (ADR 0003).
 *
 * The three filled states are exactly the derived activities, which is the same cut the Session
 * Host draws between a Lifecycle it stores and an activity it works out.
 */
function isAttached(status: SessionStatus): boolean {
  return status === "running" || status === "idle" || status === "awaiting";
}

export function StatusDot({
  status,
  working,
  className,
}: {
  status: SessionStatus;
  working?: boolean | undefined;
  className?: string | undefined;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-block size-2 shrink-0 rounded-full",
        working ? "text-status-active" : DOT_TEXT[status],
        isAttached(status) ? "bg-current" : "border-[1.5px] border-current",
        className,
      )}
    />
  );
}

/**
 * The only animation in the app.
 *
 * "Is it working?" is the question this UI exists to answer, and a still dot answers it poorly. A
 * 2px hairline under the pane header answers it from across the room, and index.css already collapses
 * every animation to nothing under `prefers-reduced-motion` — at which point the dot's hue and shape
 * are still carrying the state.
 *
 * The segment travels the header, compresses into each wall and turns round, rather than sliding off
 * and reappearing at the left: the old slide spent part of every cycle with the segment part-way
 * across and then gone, which read as a stall each time it restarted.
 */
export function RunningHairline({ running }: { running: boolean }) {
  return (
    <div className="h-[2px] w-full overflow-hidden" aria-hidden>
      {running ? (
        <div className="animate-hairline-bounce h-full w-2/5 bg-primary" />
      ) : null}
    </div>
  );
}
