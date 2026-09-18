export type StackPullRequest = { number: number; url?: string; title?: string; state: string };

/** The gh-stack view used to authorize mutating actions. Never populate this from broad discovery. */
export type StackView = {
  trunk: string;
  currentBranch: string;
  branches: { name: string; isCurrent: boolean; isMerged: boolean; isQueued: boolean; needsRebase: boolean; pr?: StackPullRequest }[];
};

export type StackRelationshipSource = "native" | "local" | "pull-request" | "ancestry";
export type StackGraphBranch = {
  name: string;
  /** The trunk is a parent but is not itself repeated in branches. */
  parent?: string;
  relation?: StackRelationshipSource;
  isCurrent: boolean;
  availability: "local" | "remote";
  pr?: StackPullRequest;
};

/** Read-only display data. A graph is intentionally not evidence that gh-stack actions are safe. */
export type StackGraph = {
  trunk?: string;
  currentBranch: string;
  branches: StackGraphBranch[];
  explicit: boolean;
};

export type StackCandidate = { trunk: string; branches: string[]; pullRequests: { branch: string; number: number; state: string; title?: string; url?: string }[]; fingerprint: string };
export type StackStatus = {
  /** Whether the gh-stack extension is available for actions. */
  available: boolean;
  /** Strict, local, linear candidate used only by gh stack init. */
  candidate?: StackCandidate;
  /** Strict gh-stack output used only by existing managed-stack actions. */
  view?: StackView;
  /** Broad, read-only graph used for display. */
  graph?: StackGraph;
  problem?: string;
  /** Action notices do not make an otherwise empty Stack tab visible. */
  problemKind?: "action" | "discovery";
  warnings?: string[];
  conflicts: string[];
  rebasing: boolean;
};
export type StackAction = "init" | "add" | "checkout" | "rebase" | "continue" | "abort" | "submit" | "sync";
export type StackReview = { token: string; action: "submit" | "sync"; view: StackView };
export type StackInput = { action: StackAction; branches?: string[]; fingerprint?: string; token?: string };
