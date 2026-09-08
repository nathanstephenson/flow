import { createContext, useContext } from "react";

/**
 * Which Subagents are collapsed, and how to toggle one.
 *
 * A context rather than a prop because `TranscriptEntryProps` is `{ entry, query, sessionId }` and
 * nothing else, by contract — a row cannot be handed its collapsed state without breaking the `memo`
 * that keeps a streaming tick to one re-render. Only the Subagent rows subscribe, and the value
 * changes only when someone clicks, so this costs nothing in the streaming path.
 */
export type SubagentCollapse = {
  isCollapsed: (subagentKey: string) => boolean;
  toggle: (subagentKey: string) => void;
  /** Rows this Subagent is holding, so its own row can say what collapsing hides. */
  members: (subagentKey: string) => number;
};

const NONE: SubagentCollapse = {
  isCollapsed: () => false,
  toggle: () => {},
  members: () => 0,
};

const SubagentCollapseContext = createContext<SubagentCollapse>(NONE);

export const SubagentCollapseProvider = SubagentCollapseContext.Provider;

export function useSubagentCollapse(): SubagentCollapse {
  return useContext(SubagentCollapseContext);
}
