export type StackView = {
  trunk: string;
  currentBranch: string;
  branches: { name: string; isCurrent: boolean; isMerged: boolean; isQueued: boolean; needsRebase: boolean; pr?: { number: number; url?: string; state: string } }[];
};
export type StackCandidate = { trunk: string; branches: string[]; fingerprint: string };
export type StackStatus = { candidate?: StackCandidate; available: boolean; view?: StackView; problem?: string; conflicts: string[]; rebasing: boolean };
export type StackAction = "init" | "add" | "checkout" | "rebase" | "continue" | "abort" | "submit" | "sync";
export type StackReview = { token: string; action: "submit" | "sync"; view: StackView };
export type StackInput = { action: StackAction; branches?: string[]; fingerprint?: string; token?: string };
