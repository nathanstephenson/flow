import type { MergeMethod } from "./pull-request.ts";

export type StackPullRequest = { number: number; url?: string; title?: string; isDraft?: boolean; state: string };

/** The gh-stack view used to authorize mutating actions. */
export type StackView = {
  trunk: string;
  currentBranch: string;
  branches: { name: string; isCurrent: boolean; isMerged: boolean; isQueued: boolean; needsRebase: boolean; pr?: StackPullRequest; ahead?: number; behind?: number }[];
};

export type StackCreate = { current: string; trunk?: string; branches: string[]; unstacked: string[] };
export type StackStatus = {
  /** Whether the gh-stack extension is available for actions. */
  available: boolean;
  view?: StackView;
  create?: StackCreate;
  notice?: string;
  conflicts: string[];
  rebasing: boolean;
};
export type StackAction = "init" | "add" | "checkout" | "rebase" | "continue" | "abort" | "submit" | "sync" | "merge";
export type StackReviewAction = "submit" | "sync" | "merge";
export type StackReview = { token: string; action: StackReviewAction; view: StackView; mergeMethods?: MergeMethod[] };
export type StackInput = { action: StackAction; branches?: string[]; trunk?: string; token?: string; method?: MergeMethod };

export function stackMergeBlock(view: StackView): string | undefined {
  const open = view.branches.filter(branch => !branch.isMerged);
  if (!open.length) return "All pull requests of this stack are merged.";
  for (const { name, pr } of open) {
    if (!pr) return `${name} has no pull request. Submit the stack first.`;
    if (pr.state !== "OPEN") return `#${pr.number} is ${pr.state.toLowerCase()}.`;
    if (pr.isDraft) return `#${pr.number} is a draft. Mark it ready for review first.`;
  }
  return undefined;
}
