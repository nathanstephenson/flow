import type { GitState } from "../../../src/protocol/git.ts";

export function gitStateLine(git: GitState): string {
  const parts = [git.upstream ? `${git.ahead} ahead, ${git.behind} behind` : "No upstream branch"];
  if (git.pr) parts.push(`PR #${git.pr.number}`, git.pr.checks === "none" ? "No checks" : `Checks ${git.pr.checks}`);
  return parts.join(" · ");
}
