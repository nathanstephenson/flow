import { createContext, useContext, useEffect, useReducer, type Dispatch, type ReactNode } from "react";

import {
  formatPaneLayoutHash,
  parsePaneLayoutHash,
  samePaneLayout,
  type PaneLayoutMode,
  type PaneLayoutState,
  type PaneRole,
} from "@/presentation/pane-layout-hash.ts";

/**
 * Which Agent Sessions are on screen, and where.
 *
 * The URL half of this lives in web/src/presentation/pane-layout-hash.ts, DOM-free and under test.
 * What is left here is the reducer, the context and the two effects that read and write
 * `location.hash` — the parts that genuinely need a window.
 *
 * This is UI state and nothing else — it is not "the workspace", a word this codebase reserves as a
 * banned synonym for Scope. It lives in a reducer in context because it changes rarely and is needed
 * by the sidebar, both pane headers and the keyboard layer at once; transcript state emphatically
 * does not belong here, because a provider that re-renders twenty times a second re-renders its
 * whole subtree.
 *
 * The mode is an open union. Two-up is what replaced the N-pane grid, and the honest reason the grid
 * is not coming back as-is is that browsers cap concurrent connections per origin, so six open panes
 * meant six long-lived event streams starving the command endpoint. Typing it this way means a
 * future "grid" is an addition rather than a rewrite.
 */
export type { PaneLayoutMode, PaneLayoutState, PaneRole };

export type PaneLayoutAction =
  | { type: "focus"; sessionId: string }
  | { type: "open_split"; sessionId: string }
  | { type: "close"; role: PaneRole }
  /**
   * Two-up on and off from one gesture. The candidate is supplied by the caller because this reducer
   * has no idea what Agent Sessions exist — and opening a split with nothing to put in the second
   * pane is not a state worth having.
   */
  | { type: "toggle_split"; candidate: string | undefined }
  | { type: "focus_pane"; role: PaneRole }
  | { type: "hydrate"; state: PaneLayoutState };

/**
 * The one invariant: an Agent Session may not occupy both panes. Two views of one Presentation
 * Transcript is not a comparison, it is a bug that looks like a feature.
 */
export function paneLayoutReducer(state: PaneLayoutState, action: PaneLayoutAction): PaneLayoutState {
  switch (action.type) {
    case "focus": {
      if (state.mode === "split" && state.focused === "secondary" && state.primary !== action.sessionId) {
        return { ...state, secondary: action.sessionId };
      }
      // Focusing what is already in the other pane collapses rather than duplicates.
      const secondary = state.secondary === action.sessionId ? undefined : state.secondary;
      return {
        mode: secondary === undefined ? "single" : state.mode,
        primary: action.sessionId,
        secondary,
        focused: "primary",
      };
    }

    case "open_split": {
      if (state.primary === undefined) return { ...state, mode: "single", primary: action.sessionId, focused: "primary" };
      if (state.primary === action.sessionId) return state;
      return { mode: "split", primary: state.primary, secondary: action.sessionId, focused: "secondary" };
    }

    case "toggle_split": {
      if (state.mode === "split") {
        return { mode: "single", primary: state.primary, secondary: undefined, focused: "primary" };
      }
      if (state.primary === undefined || action.candidate === undefined || action.candidate === state.primary) {
        return state;
      }
      return { mode: "split", primary: state.primary, secondary: action.candidate, focused: "secondary" };
    }

    case "close":
      return action.role === "secondary"
        ? { mode: "single", primary: state.primary, secondary: undefined, focused: "primary" }
        : { mode: "single", primary: state.secondary, secondary: undefined, focused: "primary" };

    case "focus_pane":
      return state.focused === action.role ? state : { ...state, focused: action.role };

    case "hydrate":
      return samePaneLayout(state, action.state) ? state : action.state;
  }
}

const PaneLayoutContext = createContext<PaneLayoutState | undefined>(undefined);
const PaneLayoutDispatchContext = createContext<Dispatch<PaneLayoutAction> | undefined>(undefined);

export function usePaneLayout(): PaneLayoutState {
  const state = useContext(PaneLayoutContext);
  if (!state) throw new Error("usePaneLayout outside PaneLayoutProvider");
  return state;
}

export function usePaneLayoutDispatch(): Dispatch<PaneLayoutAction> {
  const dispatch = useContext(PaneLayoutDispatchContext);
  if (!dispatch) throw new Error("usePaneLayoutDispatch outside PaneLayoutProvider");
  return dispatch;
}

export function PaneLayoutProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(paneLayoutReducer, undefined, () =>
    parsePaneLayoutHash(window.location.hash),
  );

  // Hash in. A deep link is a link, so an external navigation has to reach the layout.
  useEffect(() => {
    const onHashChange = (): void =>
      dispatch({ type: "hydrate", state: parsePaneLayoutHash(window.location.hash) });
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  // Hash out. Written only when it would differ, so this cannot loop against the listener above, and
  // with replaceState so that opening a split does not fill the back button with layout history.
  useEffect(() => {
    const next = formatPaneLayoutHash(state);
    if (next === window.location.hash || (next === "" && window.location.hash === "")) return;
    window.history.replaceState(null, "", next === "" ? window.location.pathname + window.location.search : next);
  }, [state]);

  return (
    <PaneLayoutContext.Provider value={state}>
      <PaneLayoutDispatchContext.Provider value={dispatch}>{children}</PaneLayoutDispatchContext.Provider>
    </PaneLayoutContext.Provider>
  );
}
