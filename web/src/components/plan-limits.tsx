import type { PlanLimits, PlanLimitWindow } from "../../../src/protocol/plan-limits.ts";
import { backendLabel } from "./settings-providers.tsx";
import { useWorkflowResource } from "./workflow-api.ts";

const SHORT = 6;
const LONG = 3;

export function PlanLimitsRow() {
  const { data } = useWorkflowResource<PlanLimits[]>("/api/plan-limits", 60_000);
  if (!data?.length) return null;
  return (
    <section aria-label="Plan limits" className="flex gap-10 overflow-x-auto">
      {data.map((limits) => <PlanLimitsCard key={`${limits.backend} ${limits.provider}`} limits={limits} />)}
    </section>
  );
}

function PlanLimitsCard({ limits }: { limits: PlanLimits }) {
  const color = limits.provider === "Codex" ? "var(--series-1)" : "var(--provider-anthropic)";
  return (
    <div className="flex shrink-0 items-center gap-4">
      <svg aria-hidden viewBox="0 0 48 48" className="size-20 -rotate-90">
        <Ring radius={21} width={LONG} color={color} utilization={limits.long.utilization} />
        <Ring radius={14} width={SHORT} color={color} utilization={limits.short.utilization} />
      </svg>
      <div className="grid gap-1 text-xs">
        <span className="text-sm font-medium">{backendLabel(limits.backend)}{limits.provider && ` · ${limits.provider}`}</span>
        <dl className="grid grid-cols-[auto_auto_auto] items-center gap-x-3 gap-y-0.5">
          <KeyRow window={limits.short} color={color} width={SHORT} />
          <KeyRow window={limits.long} color={color} width={LONG} />
          {limits.others.map((window) => <KeyRow key={window.label} window={window} />)}
        </dl>
      </div>
    </div>
  );
}

function Ring({ radius, width, color, utilization }: { radius: number; width: number; color: string; utilization: number }) {
  return (
    <>
      <circle cx={24} cy={24} r={radius} fill="none" stroke="var(--muted)" strokeWidth={width} />
      <circle cx={24} cy={24} r={radius} fill="none" stroke={color} strokeWidth={width} pathLength={100}
        strokeDasharray={`${Math.min(100, Math.max(0, utilization))} 100`} />
    </>
  );
}

function KeyRow({ window, color, width }: { window: PlanLimitWindow; color?: string; width?: number }) {
  return (
    <>
      <dt className="flex items-center gap-1.5 text-muted-foreground">
        <span aria-hidden className="w-3 rounded-full" style={{ height: (width ?? 0) * 2 / 3, background: color }} />
        {window.label}
      </dt>
      <dd className="text-right tabular-nums">{Math.round(window.utilization)}%</dd>
      <dd className="text-muted-foreground">
        {window.resetsAt && `resets ${new Date(window.resetsAt).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" })}`}
      </dd>
    </>
  );
}
