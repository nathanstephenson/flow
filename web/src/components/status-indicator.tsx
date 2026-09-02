import type { SessionStatus } from "../../../src/protocol/commands.ts";
import { statusTone } from "@client/status.ts";
import { Badge } from "@/components/ui/badge.tsx";
import { toneColor } from "@/lib/tone.ts";
import { cn } from "@/lib/utils.ts";

/**
 * Status, made visual rather than merely coloured.
 *
 * Colour alone is not a design and it is not accessible either, so each state differs in *shape*
 * too: running is filled, Dormant is a hollow ring — "nothing is running" ought to look like an
 * absence rather than like a faint presence — and Ended is outlined and desaturated, which keeps a
 * filled error hue in reserve for an actual error notice or a failed tool call.
 */
export function StatusDot({ status, className }: { status: SessionStatus; className?: string | undefined }) {
  const color = toneColor(statusTone(status));
  const hollow = status === "dormant" || status === "ended";
  return (
    <span
      aria-hidden
      className={cn("inline-block size-2 shrink-0 rounded-full", className)}
      style={hollow ? { border: `1.5px solid ${color}` } : { backgroundColor: color }}
    />
  );
}

export function StatusBadge({ status }: { status: SessionStatus }) {
  return (
    <Badge tone={statusTone(status)}>
      <StatusDot status={status} />
      {status}
    </Badge>
  );
}

/**
 * The only animation in the app.
 *
 * "Is it working?" is the question this UI exists to answer, and a still dot answers it poorly. A
 * 2px hairline under the pane header answers it from across the room, and index.css already collapses
 * every animation to nothing under `prefers-reduced-motion` — at which point the filled dot is still
 * carrying the state.
 */
export function RunningHairline({ running }: { running: boolean }) {
  return (
    <div className="h-[2px] w-full overflow-hidden" aria-hidden>
      {running ? (
        <div className="animate-in slide-in-from-left-full repeat-infinite ease-linear h-full w-2/5 duration-1000 bg-primary" />
      ) : null}
    </div>
  );
}
