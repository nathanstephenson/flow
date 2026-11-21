import type { ChangesView, GitDiff, GitState } from "../../../src/protocol/git.ts";

export function gitStateLine(git: GitState): string {
  const parts = [git.upstream ? `${git.ahead} ahead, ${git.behind} behind` : "No upstream branch"];
  if (git.pr) parts.push(`PR #${git.pr.number}`, git.pr.checks === "none" ? "No checks" : `Checks ${git.pr.checks}`);
  return parts.join(" · ");
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
