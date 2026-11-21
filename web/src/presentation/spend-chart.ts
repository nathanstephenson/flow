import type { SpendWindow } from "../../../src/protocol/spend.ts";

export type SpendMeasure = "costUSD" | "tokens";
export type SpendSeries = { id: string; color: string };
export type SpendBar = { start: string; total: number; segments: (SpendSeries & { value: number })[] };

export const OTHER = "Other";
const NAMED = 5;
const OTHER_COLOR = "var(--muted-foreground)";

/** `order` is the lifetime model list, so a model keeps its colour in every window. */
export function spendChart(window: SpendWindow, order: string[], measure: SpendMeasure): { series: SpendSeries[]; bars: SpendBar[]; max: number } {
  const named = order.slice(0, NAMED);
  const seriesOf = (id: string): SpendSeries => named.includes(id)
    ? { id, color: `var(--series-${named.indexOf(id) + 1})` }
    : { id: OTHER, color: OTHER_COLOR };
  const used = new Set(window.buckets.flatMap(bucket => bucket.models.filter(model => model[measure] > 0).map(model => seriesOf(model.id).id)));
  const series = [...named, OTHER].filter(id => used.has(id)).map(id => id === OTHER ? { id, color: OTHER_COLOR } : seriesOf(id));
  const bars = window.buckets.map(bucket => {
    const segments = series.map(item => ({
      ...item,
      value: bucket.models.filter(model => seriesOf(model.id).id === item.id).reduce((sum, model) => sum + model[measure], 0),
    })).filter(segment => segment.value > 0);
    return { start: bucket.start, total: segments.reduce((sum, segment) => sum + segment.value, 0), segments };
  });
  return { series, bars, max: niceCeiling(Math.max(0, ...bars.map(bar => bar.total))) };
}

export function niceCeiling(value: number): number {
  if (value <= 0) return 1;
  const power = 10 ** Math.floor(Math.log10(value));
  return ([1, 2, 2.5, 5, 10].find(step => step * power >= value) ?? 10) * power;
}

export function bucketLabel(start: string, size: number): string {
  const date = new Date(start);
  return size < 24 * 60 * 60 * 1000
    ? date.toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" })
    : date.toLocaleDateString([], { day: "numeric", month: "short", year: "2-digit" });
}
