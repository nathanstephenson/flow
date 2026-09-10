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

/**
 * `SessionStatus` plus the one state the protocol has no word for yet.
 *
 * Awaiting is what an `ask_user_question` tool call leaves behind, and that tool does not exist. The
 * dot is ready for it and nothing produces it: when the tool lands, the Session Host reports the
 * state and this map already knows how to draw it.
 */
export type DotState = SessionStatus | "awaiting";

const DOT_TEXT: Record<DotState, string> = {
  running: "text-status-active",
  idle: "text-foreground",
  awaiting: "text-status-awaiting",
  dormant: "text-foreground",
  settled: "text-muted-foreground",
  ended: "text-destructive",
};

/** Filled means a Backend Session is attached. Hollow means nothing is running (ADR 0003). */
function isAttached(status: DotState): boolean {
  return status === "running" || status === "idle" || status === "awaiting";
}

export function StatusDot({ status, className }: { status: DotState; className?: string | undefined }) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-block size-2 shrink-0 rounded-full",
        DOT_TEXT[status],
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
 * The segment travels the header and turns round rather than sliding off and reappearing at the left:
 * the old slide spent part of every cycle with the segment part-way across and then gone, which read
 * as a stall each time it restarted.
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
