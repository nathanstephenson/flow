import { useCallback, useEffect, useMemo, useState } from "react";

import {
  addTab,
  closeTab,
  defaultLayout,
  fillWithShell,
  fillWithSubagents,
  parseLayouts,
  pruneLayouts,
  reconcileLayout,
  rememberShell,
  selectSubagent,
  setActive,
  setSize,
  subagentsSide,
  toggleMinimised,
  type DockLayout,
  type DockSide,
} from "@/presentation/docks.ts";
import { killShell, listShells } from "@/shell-connection.ts";

/**
 * The Docks, per Agent Session, remembered across reloads.
 *
 * The arithmetic and the state machine are in web/src/presentation/docks.ts, DOM-free and under test;
 * what is left here is the state, the one line that touches `localStorage`, and the two things that
 * reach the Session Host — killing a Shell whose tab closed, and asking which Shells are still alive.
 *
 * Client state, not a Setting, for the reason the old Shell split was: whether a Shell is *running*
 * is the host's business, but whether you are looking at it is not (ADR 0009 puts Settings on the
 * daemon, machine-wide, and how tall you like a terminal is neither).
 *
 * Every layout is held here rather than in the Dock, because a Dock unmounts when the focus moves
 * and a Dock that closed itself on every glance at another Agent Session would be a bug — the same
 * reason the Shell split's open-set lived in the app shell.
 */
const KEY = "flow.docks";

export type DockAction =
  | { type: "toggle"; side: DockSide }
  | { type: "add-tab"; side: DockSide }
  /** Chosen from the picker. Fills the unchosen tab it was shown for, or adds one if there was none. */
  | { type: "open-shell"; side: DockSide; tabId?: string }
  /** The Shell has been opened and has an id; the tab has been waiting for it. */
  | { type: "remember-shell"; side: DockSide; tabId: string; shellId: string }
  /**
   * Show the Subagents. Chosen from the picker, or reached from the Composer's strip or a
   * transcript card — both of which have to *open* the Dock rather than toggle it, since a reader
   * clicking "2 agents running" on a Dock that happens to be open would otherwise close it.
   *
   * `side` is optional, and omitting it is the usual case: whichever Dock already has an Agents tab
   * wins, so a reader who keeps the Subagents in the bottom Dock is not handed a second copy on the
   * right. The picker passes a side because it is *in* a Dock, and that is the one being filled.
   */
  | { type: "open-subagents"; side?: DockSide; tabId?: string; subagentId?: string }
  /** Drill into one Subagent, or back to the list when `subagentId` is absent. */
  | { type: "select-subagent"; side: DockSide; tabId: string; subagentId?: string }
  | { type: "close-tab"; side: DockSide; tabId: string }
  | { type: "activate"; side: DockSide; tabId: string }
  | { type: "resize"; side: DockSide; px: number; available?: number };

export type Docks = { layout: DockLayout; dispatch: (action: DockAction) => void };

export function useDocks(sessionId: string | undefined, knownSessionIds: readonly string[]): Docks {
  const [layouts, setLayouts] = useState<Record<string, DockLayout>>(() => parseLayouts(read()));

  const update = useCallback(
    (id: string, change: (layout: DockLayout) => DockLayout) => {
      setLayouts((current) => {
        const next = { ...current, [id]: change(current[id] ?? defaultLayout()) };
        write(next);
        return next;
      });
    },
    [],
  );

  const dispatch = useCallback(
    (action: DockAction) => {
      if (sessionId === undefined) return;
      update(sessionId, (layout) => {
        // Resolved from the layout rather than named by the caller, so it runs before the shared
        // derivation below — which assumes every other action says which Dock it means.
        if (action.type === "open-subagents") {
          // Wherever the Subagents already are, else the side asked for, else the right Dock.
          const side = subagentsSide(layout) ?? action.side ?? "right";
          const target = layout[side];
          // Reuse that Dock's Agents tab: a second would show the same Subagents, and the reader
          // asked to see them rather than to have another tab.
          const existing = target.tabs.find((tab) => tab.content?.kind === "subagents");
          const filled = fillWithSubagents(
            target,
            action.tabId ?? existing?.id ?? newTabId(),
            // Drilling straight in when a reader asked for one Subagent by name, rather than
            // landing them on the list to find it again.
            ...(action.subagentId === undefined ? [] : [action.subagentId]),
          );
          return { ...layout, [side]: { ...filled, minimised: false } };
        }

        const dock = layout[action.side];
        switch (action.type) {
          case "toggle":
            return { ...layout, [action.side]: toggleMinimised(dock) };
          case "add-tab":
            return { ...layout, [action.side]: addTab(dock, newTabId()) };
          case "open-shell":
            return { ...layout, [action.side]: fillWithShell(dock, action.tabId ?? newTabId()) };
          case "select-subagent":
            return {
              ...layout,
              [action.side]: selectSubagent(dock, action.tabId, action.subagentId),
            };
          case "remember-shell":
            return { ...layout, [action.side]: rememberShell(dock, action.tabId, action.shellId) };
          case "close-tab": {
            const { dock: closed, killed } = closeTab(dock, action.tabId);
            // Closing a tab ends its Shell. A tab is the Shell's only handle now, so the alternative
            // is a pty running with nothing on screen pointing at it (ADR 0008).
            if (killed !== undefined) void killShell(killed);
            return { ...layout, [action.side]: closed };
          }
          case "activate":
            return { ...layout, [action.side]: setActive(dock, action.tabId) };
          case "resize":
            return { ...layout, [action.side]: setSize(action.side, dock, action.px, action.available) };
        }
      });
    },
    [sessionId, update],
  );

  /**
   * On arrival at an Agent Session, ask the Session Host which of its Shells still exist.
   *
   * Shells are ephemeral: a daemon restart takes every one of them, and Settling, Ending or Reaping
   * an Agent Session kills its own. So a stored layout is a claim to be checked rather than a fact,
   * and it is checked exactly once per Agent Session — a reconcile on every render would sweep away
   * the tab of a Shell that had just exited, which is the tab whose last screen someone is reading.
   */
  useEffect(() => {
    if (sessionId === undefined) return;
    let cancelled = false;
    void listShells(sessionId).then((shells) => {
      if (cancelled) return;
      const live = shells.map((shell) => shell.id);
      update(sessionId, (layout) => reconcileLayout(layout, live));
    });
    return () => {
      cancelled = true;
    };
  }, [sessionId, update]);

  /**
   * Forget the Agent Sessions that are gone. Reaping deletes one server-side without telling any
   * browser, so nothing else would ever shrink this blob.
   */
  useEffect(() => {
    setLayouts((current) => {
      const pruned = pruneLayouts(current, knownSessionIds);
      if (pruned === current) return current;
      write(pruned);
      return pruned;
    });
  }, [knownSessionIds]);

  const layout = layouts[sessionId ?? ""] ?? EMPTY;
  return useMemo(() => ({ layout, dispatch }), [layout, dispatch]);
}

/** One layout, shared by every Agent Session that has never had a Dock open. */
const EMPTY = defaultLayout();

function newTabId(): string {
  return crypto.randomUUID();
}

/**
 * Storage is a convenience here, so it is never allowed to be the thing that breaks the app: a
 * browser with storage disabled, or a full quota, has Docks for the life of the page instead.
 */
function read(): string | null {
  try {
    return window.localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

function write(layouts: Record<string, DockLayout>): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(layouts));
  } catch {
    // Nothing to do and nothing worth saying.
  }
}
