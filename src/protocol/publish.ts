import type { Branch } from "./git.ts";

export type GitFile = { path: string; status: string };
export type PullRequest = {
  number: number;
  url: string;
  title: string;
  isDraft: boolean;
  reviewDecision: string;
  statusCheckRollup: { name?: string; context?: string; status?: string; conclusion?: string; state?: string }[];
};
export type GitStatus = {
  repository: boolean;
  branch?: Branch;
  files: GitFile[];
  pr?: PullRequest;
  problem?: string;
};
export type PublishText = { commitMessage: string; title: string; body: string };
export type PublishReview = PublishText & {
  token: string;
  files: GitFile[];
  branch: string;
  defaultBranch: string;
  committedFiles: GitFile[];
  commits: string[];
  pr?: PullRequest;
  warning?: string;
};
export type PublishInput = PublishText & { token: string; branch?: string; ready?: boolean };
export type PublishResult = { branch?: string; committed?: string; pushed: boolean; url?: string; error?: string };
