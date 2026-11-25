export type PlanLimitWindow = { label: string; utilization: number; resetsAt?: string };

export type PlanLimitWindows = { provider?: string; short: PlanLimitWindow; long: PlanLimitWindow; others: PlanLimitWindow[] };

export type PlanLimits = PlanLimitWindows & { backend: string };
