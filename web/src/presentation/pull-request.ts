import type { PullRequestSummary } from "../../../src/protocol/git.ts";
import type { PullRequestCheck, PullRequestCheckLog, PullRequestDetails, PullRequestThread } from "../../../src/protocol/pull-request.ts";

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
export const failedCheck = (check: PullRequestCheck): boolean => outcome(check) === "failed";
const order: Outcome[] = ["failed", "pending", "passed", "unknown"];

export function checksSummary(checks: PullRequestCheck[]): string {
  if (!checks.length) return "No checks reported.";
  const count = (value: Outcome) => checks.filter(check => outcome(check) === value).length;
  return [`${count("passed")} passed`, `${count("failed")} failed`, `${count("pending")} pending`, ...(count("unknown") ? [`${count("unknown")} unknown`] : [])].join(" · ");
}

export function matchesSummary(pr: Pick<PullRequestDetails, "number" | "updatedAt" | "state" | "isDraft" | "reviewDecision" | "threads" | "checks">, summary: PullRequestSummary | undefined): boolean {
  const outcomes = pr.checks.map(outcome);
  const checks = !outcomes.length ? "none" : outcomes.includes("failed") ? "failing" : outcomes.includes("pending") ? "pending" : "passing";
  return pr.number === summary?.number && pr.updatedAt === summary.updatedAt && pr.state === summary.state && pr.isDraft === summary.isDraft
    && pr.reviewDecision === summary.reviewDecision && pr.threads.filter(thread => !thread.isResolved).length === summary.unresolvedThreads
    && checks === summary.checks && outcomes.filter(value => value !== "pending").length === summary.checksCompleted;
}

export function orderedChecks(checks: PullRequestCheck[]): PullRequestCheck[] {
  return [...checks].sort((a, b) => order.indexOf(outcome(a)) - order.indexOf(outcome(b)));
}

export function failedRuns(checks: PullRequestCheck[]): { runId: number; names: string[] }[] {
  const runs = new Map<number, string[]>();
  for (const check of checks) {
    if (check.runId === undefined || !failedCheck(check)) continue;
    runs.set(check.runId, [...runs.get(check.runId) ?? [], check.name]);
  }
  return [...runs].map(([runId, names]) => ({ runId, names }));
}

function fenced(text: string, info: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map(run => run.length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}${info}\n${text}\n${fence}`;
}

function quoted(text: string): string {
  return text.split("\n").map(line => line ? `> ${line}` : ">").join("\n");
}

export function threadDraftBlock(thread: PullRequestThread): string {
  const lead = `Review thread on ${thread.path}${thread.line === null ? "" : ` line ${thread.line}`}:${thread.isOutdated ? "\nThis thread is outdated." : ""}`;
  return [lead, ...(thread.diffHunk ? [fenced(thread.diffHunk, "diff")] : []), ...thread.comments.map(comment => `Comment by ${comment.author}:\n${quoted(comment.body)}`)].join("\n\n");
}

export function checkDraftBlock(check: PullRequestCheck, log?: PullRequestCheckLog): string {
  const lead = `Failed check: ${check.name}${check.url ? `\nURL: ${check.url}` : ""}`;
  return log ? `${lead}\n\n${log.truncated ? "Part of the job log" : "Job log"}:\n${fenced(log.text, "text")}` : lead;
}

export function mergeUnavailable(pr: Pick<PullRequestDetails, "isDraft" | "mergeMethods">): string | undefined {
  if (pr.isDraft) return "Merge is not available for a draft. Mark the pull request ready for review first.";
  if (pr.mergeMethods.length === 0) return "Merge is not available. This repository allows no merge method for you.";
  return undefined;
}
