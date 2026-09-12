import type { PullRequest } from "./publish.ts";

export type PullRequestRef = { repo: string; number: number; id: string };
export type PullRequestComment = {
  id: string;
  author: string;
  body: string;
  url: string;
  createdAt: string;
};
export type PullRequestReview = PullRequestComment & { state: string };
export type PullRequestThread = {
  id: string;
  path: string;
  line: number | null;
  isOutdated: boolean;
  isResolved: boolean;
  viewerCanReply: boolean;
  viewerCanResolve: boolean;
  viewerCanUnresolve: boolean;
  diffHunk: string;
  comments: PullRequestComment[];
};
export type PullRequestDetails = PullRequest & PullRequestRef & {
  body: string;
  state: "OPEN" | "MERGED" | "CLOSED";
  author: string;
  headRefName: string;
  headRepository?: string;
  baseRefName: string;
  createdAt: string;
  updatedAt: string;
  mergeable: string;
  mergeStateStatus: string;
  viewerCanComment: boolean;
  comments: PullRequestComment[];
  reviews: PullRequestReview[];
  threads: PullRequestThread[];
};
export type PullRequestCommentInput = { pr: PullRequestRef; body: string; threadId?: string };
export type PullRequestThreadInput = { pr: PullRequestRef; threadId: string; resolved: boolean };
