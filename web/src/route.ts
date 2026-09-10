import { useCallback, useEffect, useRef, useState } from "react";

import {
  formatRoute,
  parseRoute,
  returnPoint,
  routedSessionId,
  type Route,
  type SettingsSection,
} from "@/presentation/route.ts";

/**
 * What is on screen, kept in `location.hash`.
 *
 * The URL half of this lives in web/src/presentation/route.ts, DOM-free and under test. What is left
 * here is the state and the two effects that read and write `location.hash` — the parts that
 * genuinely need a window.
 *
 * This is UI state and nothing else — it is not "the workspace", a word this codebase reserves as a
 * banned synonym for Scope. It is a hook rather than a provider because exactly one component needs
 * it: the app shell holds the route and hands the pieces to the rail and to the pane as props. A
 * context would be a second way to reach one string. Transcript state emphatically does not belong
 * here either way, because a provider that re-renders twenty times a second re-renders its whole
 * subtree.
 */
export type Navigation = {
  route: Route;
  /** The Agent Session in the pane, or undefined — including while the Settings are on screen. */
  sessionId: string | undefined;
  focus: (sessionId: string) => void;
  /**
   * Show the New Agent Session view.
   *
   * The Agent Session route naming none, which is already the clean URL — `formatRoute` gives `""`
   * for it — so this view needs no `Route` member of its own. It is the empty state, and starting one
   * is what the empty state was always for.
   */
  openNewAgentSession: () => void;
  openSettings: (section?: SettingsSection) => void;
  /**
   * Leave the Settings for whatever was on screen before them.
   *
   * Not `history.back()`: the hash is written with `replaceState` so that reading through a few
   * Agent Sessions does not fill the back button, which means there is no entry to pop.
   *
   * "Whatever", including the New Agent Session view. That view is the Agent Session route naming
   * none, so `undefined` is a real destination here and not merely the absence of one — somebody who
   * pressed `?` while halfway through typing a first message has to come back to it. Their Draft
   * survives either way, but landing them on an unrelated transcript would leave them looking for
   * words that are still there.
   */
  leaveSettings: () => void;
};

export function useRoute(): Navigation {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.hash));
  const sessionId = routedSessionId(route);

  /*
   * Where to come back to. A ref rather than state: nothing renders differently because of it, so
   * making it state would re-render the whole shell on every change of focus for no visible reason.
   *
   * Recorded whenever the Agent Session view is on screen, `undefined` included — that is the New
   * Agent Session view, which is somewhere a reader can be and therefore somewhere they can be
   * returned to. Only the Settings are skipped, because leaving them for themselves is not a move.
   */
  const lastSessionId = useRef<string | undefined>(sessionId);
  useEffect(() => {
    lastSessionId.current = returnPoint(route, lastSessionId.current);
  }, [route]);

  // Hash in. A deep link is a link, so an external navigation has to reach the selection.
  useEffect(() => {
    const onHashChange = (): void => setRoute(parseRoute(window.location.hash));
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  // Hash out. Written only when it would differ, so this cannot loop against the listener above, and
  // with replaceState so that reading through a few Agent Sessions does not fill the back button.
  useEffect(() => {
    const next = formatRoute(route);
    if (next === window.location.hash) return;
    window.history.replaceState(
      null,
      "",
      next === "" ? window.location.pathname + window.location.search : next,
    );
  }, [route]);

  const focus = useCallback((next: string) => setRoute({ view: "session", sessionId: next }), []);

  const openNewAgentSession = useCallback(
    () => setRoute({ view: "session", sessionId: undefined }),
    [],
  );

  const openSettings = useCallback(
    (section: SettingsSection = "general") => setRoute({ view: "settings", section }),
    [],
  );

  const leaveSettings = useCallback(
    () => setRoute({ view: "session", sessionId: lastSessionId.current }),
    [],
  );

  return { route, sessionId, focus, openNewAgentSession, openSettings, leaveSettings };
}
