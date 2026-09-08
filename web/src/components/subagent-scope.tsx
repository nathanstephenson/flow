import { createContext, useContext } from "react";

/**
 * The Subagent whose own rows are being shown, when a surface shows only one.
 *
 * `TranscriptEntry` indents anything carrying a `producer`, so a reader can tell delegated work
 * from the session's own (ADR 0015). Inside one Subagent's transcript that indent says nothing —
 * every row there is delegated, to the same Subagent — and in a 380px Dock it spends real width
 * saying it.
 *
 * A context rather than a prop because `TranscriptEntryProps` is `{ entry, query, sessionId }` and
 * nothing else by contract, so that `memo` holds while text streams. The value is fixed for the
 * life of the surface, so no consumer ever re-renders because of it.
 *
 * Undefined means "showing the whole transcript", where the indent is the point.
 */
const SubagentScopeContext = createContext<string | undefined>(undefined);

export const SubagentScopeProvider = SubagentScopeContext.Provider;

export function useSubagentScope(): string | undefined {
  return useContext(SubagentScopeContext);
}
