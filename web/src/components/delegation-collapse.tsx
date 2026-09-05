import { createContext, useContext } from "react";

/**
 * Which Delegations are collapsed, and how to toggle one.
 *
 * A context rather than a prop because `TranscriptEntryProps` is `{ entry, query, sessionId }` and
 * nothing else, by contract — a row cannot be handed its collapsed state without breaking the `memo`
 * that keeps a streaming tick to one re-render. Only the Delegation rows subscribe, and the value
 * changes only when someone clicks, so this costs nothing in the streaming path.
 */
export type DelegationCollapse = {
  isCollapsed: (delegationKey: string) => boolean;
  toggle: (delegationKey: string) => void;
  /** Rows this Delegation is holding, so its own row can say what collapsing hides. */
  members: (delegationKey: string) => number;
};

const NONE: DelegationCollapse = {
  isCollapsed: () => false,
  toggle: () => {},
  members: () => 0,
};

const DelegationCollapseContext = createContext<DelegationCollapse>(NONE);

export const DelegationCollapseProvider = DelegationCollapseContext.Provider;

export function useDelegationCollapse(): DelegationCollapse {
  return useContext(DelegationCollapseContext);
}
