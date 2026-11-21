import type { PullRequestCheck } from "../../../src/protocol/pull-request.ts";

export function safePullRequestUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : undefined;
  } catch { return undefined; }
}

export function readableStatus(value: string): string {
  const text = value.toLowerCase().replaceAll("_", " ");
  return text ? text[0]!.toUpperCase() + text.slice(1) : "Unknown";
}

type Outcome = "failed" | "pending" | "passed" | "unknown";
const outcomes: Record<string, Outcome> = Object.fromEntries([
  ...["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE", "STALE"].map(status => [status, "failed"]),
  ...["PENDING", "QUEUED", "IN_PROGRESS", "WAITING", "REQUESTED", "EXPECTED"].map(status => [status, "pending"]),
  ...["SUCCESS", "NEUTRAL", "SKIPPED"].map(status => [status, "passed"]),
]);
const outcome = (check: PullRequestCheck): Outcome => outcomes[check.status.toUpperCase()] ?? "unknown";
const order: Outcome[] = ["failed", "pending", "passed", "unknown"];

export function checksSummary(checks: PullRequestCheck[]): string {
  if (!checks.length) return "No checks reported.";
  const count = (value: Outcome) => checks.filter(check => outcome(check) === value).length;
  return [`${count("passed")} passed`, `${count("failed")} failed`, `${count("pending")} pending`, ...(count("unknown") ? [`${count("unknown")} unknown`] : [])].join(" · ");
}

export function orderedChecks(checks: PullRequestCheck[]): PullRequestCheck[] {
  return [...checks].sort((a, b) => order.indexOf(outcome(a)) - order.indexOf(outcome(b)));
}

export function failedRuns(checks: PullRequestCheck[]): { runId: number; names: string[] }[] {
  const runs = new Map<number, string[]>();
  for (const check of checks) {
    if (check.runId === undefined || outcome(check) !== "failed") continue;
    runs.set(check.runId, [...runs.get(check.runId) ?? [], check.name]);
  }
  return [...runs].map(([runId, names]) => ({ runId, names }));
}
