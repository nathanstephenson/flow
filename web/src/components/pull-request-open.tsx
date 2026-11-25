import { createContext, useContext } from "react";

/**
 * Show a GitHub link in the Git pane when it is the pull request for the checked-out branch.
 *
 * Returns false when the link is some other page, so the caller opens it on GitHub. A context for the
 * reason `subagent-open.tsx` gives.
 */
export type OpenPullRequest = (href: string) => boolean;

const PullRequestOpenContext = createContext<OpenPullRequest | undefined>(undefined);

export const PullRequestOpenProvider = PullRequestOpenContext.Provider;

export function useOpenPullRequest(): OpenPullRequest | undefined {
  return useContext(PullRequestOpenContext);
}
