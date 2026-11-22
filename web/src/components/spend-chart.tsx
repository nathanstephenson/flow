import { compactTokens, money } from "@client/context-usage.ts";
import type { SpendWindow } from "../../../src/protocol/spend.ts";
import { bucketLabel, spendChart, type SpendMeasure } from "../presentation/spend-chart.ts";
import { Tabs, TabsList, TabsTrigger } from "./ui/tabs.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip.tsx";

const Y_LABEL = "w-12";

export function SpendChart({ window, order, measure, onMeasure }: {
  window: SpendWindow;
  order: string[];
  measure: SpendMeasure;
  onMeasure: (measure: SpendMeasure) => void;
}) {
  const { series, points, max } = spendChart(window, order, measure);
  const format = (value: number) => measure === "costUSD" ? money(value) : compactTokens(value);
  const size = points.length > 1 ? Date.parse(points[1]!.start) - Date.parse(points[0]!.start) : 24 * 60 * 60 * 1000;
  const labelled = [0, Math.floor((points.length - 1) / 2), points.length - 1];
  const step = 100 / Math.max(1, points.length - 1);
  const x = (index: number) => points.length === 1 ? 50 : index * step;
  const y = (value: number) => 100 - (value / max) * 100;
  const valueOf = (point: (typeof points)[number], id: string) => point.segments.find((segment) => segment.id === id)?.value ?? 0;
  return (
    <section aria-label="Spend over time" className="grid gap-3">
      <div className="flex items-start justify-between gap-3">
        <ul aria-label="Models" className="flex min-w-0 flex-1 flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          {series.map((item) => (
            <li key={item.id} className="flex items-center gap-1.5">
              <span aria-hidden className="size-2.5 rounded-sm" style={{ background: item.color }} />
              <span className="font-mono">{item.id}</span>
            </li>
          ))}
        </ul>
        <Tabs value={measure} onValueChange={(value) => onMeasure(value as SpendMeasure)} className="shrink-0">
          <TabsList aria-label="Measure">
            <TabsTrigger value="costUSD" className="h-6 px-2 text-xs">Cost</TabsTrigger>
            <TabsTrigger value="tokens" className="h-6 px-2 text-xs">Tokens</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>
      <div className="flex">
        <div aria-hidden className={`${Y_LABEL} relative shrink-0 text-xs text-muted-foreground`}>
          {[1, 0.5, 0].map((share) => (
            <span key={share} className="absolute right-2 -translate-y-1/2 tabular-nums" style={{ top: `${(1 - share) * 100}%` }}>{format(max * share)}</span>
          ))}
        </div>
        <div className="relative h-44 flex-1">
          {[0, 0.5, 1].map((share) => (
            <div key={share} aria-hidden className="absolute inset-x-0 border-t border-border" style={{ top: `${share * 100}%` }} />
          ))}
          <svg aria-hidden className="absolute inset-0 h-full w-full overflow-visible" viewBox="0 0 100 100" preserveAspectRatio="none">
            {series.map((item) => (
              <polyline
                key={item.id}
                fill="none"
                stroke={item.color}
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
                points={points.map((point, index) => `${x(index)},${y(valueOf(point, item.id))}`).join(" ")}
              />
            ))}
          </svg>
          {points.map((point, index) => (
            <Tooltip key={point.start}>
              <TooltipTrigger
                render={<div className="group absolute inset-y-0" style={{ left: `${x(index) - step / 2}%`, width: `${step}%` }} />}
              >
                <div aria-hidden className="absolute inset-y-0 left-1/2 hidden border-l border-muted-foreground/50 group-hover:block" />
                {point.segments.map((segment) => (
                  <div
                    key={segment.id}
                    aria-hidden
                    className={`absolute left-1/2 size-2 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-background ${points.length === 1 ? "" : "hidden group-hover:block"}`}
                    style={{ top: `${y(segment.value)}%`, background: segment.color }}
                  />
                ))}
              </TooltipTrigger>
              <TooltipContent>
                <span className="grid grid-cols-[auto_auto] gap-x-3 gap-y-0.5">
                  <span className="col-span-2 font-medium">{bucketLabel(point.start, size)}</span>
                  <span className="text-muted-foreground">Total</span>
                  <span className="text-right tabular-nums">{format(point.total)}</span>
                  {point.segments.map((segment) => (
                    <span key={segment.id} className="contents">
                      <span className="flex items-center gap-1.5 font-mono text-xs">
                        <span aria-hidden className="size-2 rounded-sm" style={{ background: segment.color }} />
                        {segment.id}
                      </span>
                      <span className="text-right text-xs tabular-nums">{format(segment.value)}</span>
                    </span>
                  ))}
                </span>
              </TooltipContent>
            </Tooltip>
          ))}
        </div>
      </div>
      <div aria-hidden className="relative ml-12 h-4 text-xs text-muted-foreground">
        {points.map((point, index) => labelled.includes(index) && (
          <span
            key={point.start}
            className="absolute whitespace-nowrap"
            style={index === 0 ? { left: 0 } : index === points.length - 1 ? { right: 0 } : { left: "50%", transform: "translateX(-50%)" }}
          >
            {bucketLabel(point.start, size)}
          </span>
        ))}
      </div>
    </section>
  );
}
