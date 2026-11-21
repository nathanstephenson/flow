import type { ChangesView, GitDiff, GitState } from "../../../src/protocol/git.ts";

export function gitStateLine(git: GitState): string {
  const parts = [git.upstream ? `${git.ahead} ahead, ${git.behind} behind` : "No upstream branch"];
  if (git.pr) parts.push(`PR #${git.pr.number}`, git.pr.checks === "none" ? "No checks" : `Checks ${git.pr.checks}`);
  return parts.join(" · ");
}

export function diffNotice(diff: GitDiff): string | undefined {
  if ("binary" in diff) return "Binary file. No text diff.";
  if ("tooLarge" in diff) return "This diff is too large to show.";
  return diff.text ? undefined : "No text changes.";
}

export function noChanges(view: ChangesView): string {
  return view === "branch" ? "No changes on this branch." : "No uncommitted changes.";
}
