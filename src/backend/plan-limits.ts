import type { PlanLimitWindow, PlanLimitWindows } from "../protocol/plan-limits.ts";

type AnthropicWindow = { utilization: number | null; resets_at: string | null } | null | undefined;

export type AnthropicUsage = {
  five_hour?: AnthropicWindow;
  seven_day?: AnthropicWindow;
  seven_day_opus?: AnthropicWindow;
  seven_day_sonnet?: AnthropicWindow;
  model_scoped?: ({ display_name: string } & NonNullable<AnthropicWindow>)[];
} | null | undefined;

export function anthropicPlanLimits(usage: AnthropicUsage): PlanLimitWindows | undefined {
  const short = anthropicWindow("5-hour", usage?.five_hour);
  const long = anthropicWindow("7-day", usage?.seven_day);
  if (!short || !long) return undefined;
  const others = [
    anthropicWindow("Opus", usage?.seven_day_opus),
    anthropicWindow("Sonnet", usage?.seven_day_sonnet),
    ...(usage?.model_scoped ?? []).map((scoped) => anthropicWindow(scoped.display_name, scoped)),
  ].filter((window) => window !== undefined);
  return { short, long, others };
}

function anthropicWindow(label: string, window: AnthropicWindow): PlanLimitWindow | undefined {
  if (window?.utilization == null) return undefined;
  return { label, utilization: window.utilization, ...(window.resets_at ? { resetsAt: window.resets_at } : {}) };
}
