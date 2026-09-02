import type { SessionStatus } from "../../../src/protocol/commands.ts";
import { Badge } from "@/components/ui/badge.tsx";
import { cn } from "@/lib/utils.ts";

/**
 * Status, made visual without spending colour on it.
 *
 * The `rhea` style is monochrome by design — `--chart-1` through `--chart-5` are all zero-chroma
 * greys — so the five states this domain has cannot be five hues. They were, and five
 * indistinguishable dots is worse than none, because it implies a distinction the reader cannot see.
 *
 * So *shape* carries the one thing a glance most needs: the dot is **filled** while a Backend
 * Session is attached (running, idle) and a **hollow ring** when none is (Dormant, Settled, Ended).
 * That is the same question `canRevive` answers, made visual. The remaining separation is textual —
 * the status word is rendered next to every dot in this app — plus two uses of contrast:
 * `muted-foreground` for the two quiet terminal-ish states, and `--destructive`, rhea's only
 * coloured token, for Ended alone. The other two claims on `--destructive` are an `error`-level
 * notice and a failed tool call; Settled is neither, so it does not get it.
 *
 * These are static class strings rather than a runtime `var()` lookup so Tailwind's scanner can see
 * every one of them — the old lookup assembled a custom-property name at runtime, which is exactly
 * the shape a scanner cannot follow.
 */
const DOT_TEXT: Record<SessionStatus, string> = {
  running: "text-foreground",
  idle: "text-foreground",
  dormant: "text-muted-foreground",
  settled: "text-muted-foreground",
  ended: "text-destructive",
};

/** Filled means a Backend Session is attached. Hollow means nothing is running (ADR 0003). */
function isAttached(status: SessionStatus): boolean {
  return status === "running" || status === "idle";
}

export function StatusDot({ status, className }: { status: SessionStatus; className?: string | undefined }) {
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
 * The dot and the word together, because the word is what actually distinguishes running from idle
 * now. Settled stays de-emphasised rather than coloured, as before.
 */
export function StatusBadge({ status }: { status: SessionStatus }) {
  return (
    <Badge
      variant={status === "ended" ? "destructive" : "secondary"}
      className={cn(status === "settled" && "text-muted-foreground opacity-70")}
    >
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
 * every animation to nothing under `prefers-reduced-motion` — at which point the filled dot and the
 * status word are still carrying the state.
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
