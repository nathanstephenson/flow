import type { ModelSpend } from "./events.ts";

export const SPEND_SOURCES = ["session", "workflow", "naming", "publish", "tour", "builder"] as const;
export type SpendSource = (typeof SPEND_SOURCES)[number];

export const SPEND_WINDOWS = ["day", "week", "month", "lifetime"] as const;
export type SpendWindowName = (typeof SPEND_WINDOWS)[number];

export type SpendTotal = { tokens: number; cached: number; costUSD: number };

export type SpendWindow = SpendTotal & {
  models: ModelSpend[];
  sources: (SpendTotal & { source: SpendSource })[];
  buckets: { start: string; models: ModelSpend[] }[];
};

export type SpendSummary = Record<SpendWindowName, SpendWindow>;
