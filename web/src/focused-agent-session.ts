import { useEffect, useState } from "react";

import { formatAgentSessionHash, parseAgentSessionHash } from "@/presentation/agent-session-hash.ts";

/**
 * Which Agent Session is on screen, kept in `location.hash`.
 *
 * The URL half of this lives in web/src/presentation/agent-session-hash.ts, DOM-free and under test.
 * What is left here is the state and the two effects that read and write `location.hash` — the parts
 * that genuinely need a window.
 *
 * This is UI state and nothing else — it is not "the workspace", a word this codebase reserves as a
 * banned synonym for Scope. It is a hook rather than a provider because exactly one component needs
 * it: the app shell holds the focused id and hands it to the rail and to the pane as a prop. A
 * context would be a second way to reach one string. Transcript state emphatically does not belong
 * here either way, because a provider that re-renders twenty times a second re-renders its whole
 * subtree.
 */
export function useFocusedAgentSession(): [string | undefined, (sessionId: string) => void] {
  const [focusedId, setFocusedId] = useState<string | undefined>(() =>
    parseAgentSessionHash(window.location.hash),
  );

  // Hash in. A deep link is a link, so an external navigation has to reach the selection.
  useEffect(() => {
    const onHashChange = (): void => setFocusedId(parseAgentSessionHash(window.location.hash));
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  // Hash out. Written only when it would differ, so this cannot loop against the listener above, and
  // with replaceState so that reading through a few Agent Sessions does not fill the back button.
  useEffect(() => {
    const next = formatAgentSessionHash(focusedId);
    if (next === window.location.hash) return;
    window.history.replaceState(null, "", next === "" ? window.location.pathname + window.location.search : next);
  }, [focusedId]);

  return [focusedId, setFocusedId];
}
