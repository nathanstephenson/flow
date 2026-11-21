import type { ChangesView, GitDiff, GitState, PullRequestSummary } from "../../../src/protocol/git.ts";

export type GitStep = "commit" | "push" | "pull_request";
export const stepLabels: Record<GitStep, string> = { commit: "Commit", push: "Push", pull_request: "Create pull request" };

export function gitSteps(git: GitState | undefined): GitStep[] {
  if (!git) return [];
  const steps: GitStep[] = git.changed > 0 ? ["commit"] : [];
  if (!git.branch || !git.head || git.branch === git.defaultBranch) return steps;
  if (!git.upstream || git.ahead > 0) steps.push("push");
  else if (git.pr?.state !== "OPEN") steps.push("pull_request");
  return steps;
}

export function pullStep(git: GitState | undefined): "pull" | "diverged" | undefined {
  if (!git?.branch || git.behind === 0) return undefined;
  if (git.ahead > 0) return "diverged";
  return git.changed === 0 ? "pull" : undefined;
}

export function branchLine(git: GitState): string {
  return git.branch ?? `detached at ${git.head?.slice(0, 7)}`;
}

export function gitStateLine(git: GitState): string {
  return git.upstream ? `${git.ahead} ahead, ${git.behind} behind` : "No upstream branch";
}

export function pullRequestLine(pr: PullRequestSummary): string {
  const state = pr.state === "OPEN" ? pr.isDraft ? "Draft" : "Open" : pr.state === "MERGED" ? "Merged" : "Closed";
  return `PR #${pr.number} · ${state} · ${pr.checks === "none" ? "No checks" : `Checks ${pr.checks}`}`;
}

export function diffNotice(diff: GitDiff, path: string): string {
  if (path.endsWith("/")) return "Directory. No text diff.";
  if ("binary" in diff) return "Binary file. No text diff.";
  if ("tooLarge" in diff) return "This diff is too large to show.";
  return "No text changes.";
}

export function diffHunks(text: string): string | undefined {
  const start = text.search(/^@@ /m);
  return start < 0 ? undefined : text.slice(start);
}

export function noChanges(view: ChangesView): string {
  return view === "branch" ? "No changes on this branch." : "No uncommitted changes.";
}
