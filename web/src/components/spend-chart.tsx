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
  const { series, bars, max } = spendChart(window, order, measure);
  const format = (value: number) => measure === "costUSD" ? money(value) : compactTokens(value);
  const size = bars.length > 1 ? Date.parse(bars[1]!.start) - Date.parse(bars[0]!.start) : 24 * 60 * 60 * 1000;
  const labelled = [0, Math.floor((bars.length - 1) / 2), bars.length - 1];
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
          <div className="absolute inset-0 flex items-end gap-[2px]">
            {bars.map((bar) => (
              <Tooltip key={bar.start}>
                <TooltipTrigger render={<div className="flex h-full min-w-0 flex-1 flex-col-reverse gap-[2px] hover:bg-muted/60" />}>
                  {bar.segments.map((segment, index) => (
                    <div
                      key={segment.id}
                      className={index === bar.segments.length - 1 ? "rounded-t-[4px]" : undefined}
                      style={{ height: `${(segment.value / max) * 100}%`, background: segment.color }}
                    />
                  ))}
                </TooltipTrigger>
                <TooltipContent>
                  <span className="grid grid-cols-[auto_auto] gap-x-3 gap-y-0.5">
                    <span className="col-span-2 font-medium">{bucketLabel(bar.start, size)}</span>
                    <span className="text-muted-foreground">Total</span>
                    <span className="text-right tabular-nums">{format(bar.total)}</span>
                    {bar.segments.map((segment) => (
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
      </div>
      <div aria-hidden className="relative ml-12 h-4 text-xs text-muted-foreground">
        {bars.map((bar, index) => labelled.includes(index) && (
          <span
            key={bar.start}
            className="absolute whitespace-nowrap"
            style={index === 0 ? { left: 0 } : index === bars.length - 1 ? { right: 0 } : { left: "50%", transform: "translateX(-50%)" }}
          >
            {bucketLabel(bar.start, size)}
          </span>
        ))}
      </div>
    </section>
  );
}
