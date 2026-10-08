import { useId } from "react";
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

export function ComposerActivity({ status }: { status: SessionStatus }) {
  const maskId = useId();
  if (status !== "running" && status !== "awaiting") return null;

  return (
    <svg className="composer-activity" data-status={status} aria-hidden>
      <defs>
        <mask id={maskId} maskUnits="userSpaceOnUse" x="-50%" y="-50%" width="200%" height="200%">
          <rect x="-50%" y="-50%" width="200%" height="200%" fill="white" />
          <rect className="composer-activity-cutout" width="100%" height="100%" fill="black" />
        </mask>
      </defs>
      <g mask={`url(#${maskId})`}>
        <rect className="composer-activity-shape composer-activity-glow" x="1" y="1" pathLength="100" />
      </g>
      <rect className="composer-activity-shape composer-activity-outline" x="1" y="1" pathLength="100" />
    </svg>
  );
}
