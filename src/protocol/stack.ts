export type StackPullRequest = { number: number; url?: string; title?: string; isDraft?: boolean; state: string };

/** The gh-stack view used to authorize mutating actions. */
export type StackView = {
  trunk: string;
  currentBranch: string;
  branches: { name: string; isCurrent: boolean; isMerged: boolean; isQueued: boolean; needsRebase: boolean; pr?: StackPullRequest }[];
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
export type StackAction = "init" | "add" | "checkout" | "rebase" | "continue" | "abort" | "submit" | "sync";
export type StackReview = { token: string; action: "submit" | "sync"; view: StackView };
export type StackInput = { action: StackAction; branches?: string[]; trunk?: string; token?: string };
