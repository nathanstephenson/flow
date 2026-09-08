import { createContext, useContext } from "react";

/**
 * How to show one Subagent's own work, for a surface that only mentions it.
 *
 * The transcript says a Subagent was started and nothing more (ADR 0015), so its card is the
 * obvious place to ask for the rest — but the card cannot know where the rest lives. The pane owns
 * the Docks and does know, so it supplies this.
 *
 * A context rather than a prop because `TranscriptEntryProps` is `{ entry, query, sessionId }` and
 * nothing else by contract, so that `memo` holds while text streams. The value is fixed for the
 * life of the pane, so no consumer re-renders because of it.
 *
 * Undefined means there is nowhere to send a reader, and the card stays inert rather than offering
 * a click that goes nowhere.
 */
export type OpenSubagent = (subagentKey: string) => void;

const SubagentOpenContext = createContext<OpenSubagent | undefined>(undefined);

export const SubagentOpenProvider = SubagentOpenContext.Provider;

export function useOpenSubagent(): OpenSubagent | undefined {
  return useContext(SubagentOpenContext);
}
