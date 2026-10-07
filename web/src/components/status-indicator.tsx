import type { SessionStatus } from "../../../src/protocol/commands.ts";
import { cn } from "@/lib/utils.ts";

/** Native status hues shared by dots, rail edges and selected rail flow.
 * Background work lifts only Idle to Running's hue, never Awaiting or a stopped Lifecycle.
 * Dormant is grey because an edge cannot carry the dot's hollow/filled distinction.
 * Ended retains the native error red; Settled is a quieter muted indicator.
 */
const STATUS_COLOR: Record<SessionStatus, string> = {
  running: "var(--status-active)",
  idle: "var(--foreground)",
  awaiting: "var(--status-awaiting)",
  dormant: "var(--muted-foreground)",
  settled: "color-mix(in srgb, var(--muted-foreground) 55%, transparent)",
  ended: "var(--destructive)",
};

export function statusIndicatorColor(status: SessionStatus, working = false): string {
  return STATUS_COLOR[status === "idle" && working ? "running" : status];
}

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
      style={{ color: statusIndicatorColor(status, working) }}
      className={cn(
        "inline-block size-2 shrink-0 rounded-full",
        isAttached(status) ? "bg-current" : "border-[1.5px] border-current",
        className,
      )}
    />
  );
}

/**
 * The pane's working hairline.
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
