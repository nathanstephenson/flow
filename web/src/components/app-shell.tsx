import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { SessionStatus } from "../../../src/protocol/commands.ts";
import { canSettle } from "@client/status.ts";
import { useOpenChrome } from "@/agent-session-view.tsx";
import { useAgentSessions, useCommand } from "@/agent-sessions.tsx";
import { useHost } from "@/host.tsx";
import { usePaneLayout, usePaneLayoutDispatch } from "@/pane-layout.tsx";
import { AgentSessionSidebar } from "@/components/agent-session-sidebar.tsx";
import { KeyboardLayer, type KeyboardHandlers } from "@/components/keyboard-layer.tsx";
import { NewAgentSessionDialog } from "@/components/new-agent-session-dialog.tsx";
import { PaneLayoutSplit } from "@/components/pane-layout-split.tsx";
import { toast } from "@/components/ui/toaster.tsx";

/**
 * The frame: a rail of Agent Sessions, and one or two panes.
 *
 * It also owns the two pieces of state that are about the *app* rather than about any Agent Session
 * — whether the New Agent Session dialog is open, and where the keyboard cursor is in the rail — and
 * the auto-open rule below.
 */
export function AppShell() {
  const { config } = useHost();
  const { sessions } = useAgentSessions();
  const layout = usePaneLayout();
  const dispatch = usePaneLayoutDispatch();
  const run = useCommand();

  const [newOpen, setNewOpen] = useState(false);
  const [cursor, setCursor] = useState(0);

  const openIds = useMemo(
    () => [layout.primary, layout.secondary].filter((id): id is string => id !== undefined),
    [layout.primary, layout.secondary],
  );
  const openChrome = useOpenChrome(openIds);

  /**
   * The live status wins wherever there is one. A polled `SessionSummary.status` can be two seconds
   * stale, which is exactly long enough for the rail to contradict the pane after a Settle.
   */
  const liveStatuses = useMemo(() => {
    const statuses: Record<string, SessionStatus> = {};
    for (const [id, chrome] of Object.entries(openChrome)) statuses[id] = chrome.status;
    return statuses;
  }, [openChrome]);

  const focusedId = layout.mode === "split" && layout.focused === "secondary" ? layout.secondary : layout.primary;

  /**
   * Open the freshest Agent Session on arrival, as the old UI did — but only when the URL did not
   * already name one, and not when the candidate is Settled.
   *
   * The Session Host sorts Settled last, so `sessions[0]` is the freshest *active* Agent Session in
   * the normal case and only Settled when every one of them is. Opening a Settled Agent Session
   * unasked would put a finished transcript in front of someone who came to start work.
   */
  const autoOpened = useRef(false);
  useEffect(() => {
    if (autoOpened.current) return;
    if (layout.primary !== undefined || window.location.hash.startsWith("#/s/")) {
      autoOpened.current = true;
      return;
    }
    const candidate = sessions[0];
    if (!candidate) return;
    autoOpened.current = true;
    if (candidate.status === "settled") return;
    dispatch({ type: "focus", sessionId: candidate.id });
  }, [sessions, layout.primary, dispatch]);

  // The cursor addresses the rail as it is rendered, so it cannot point past the end of it.
  useEffect(() => {
    setCursor((current) => Math.max(0, Math.min(current, sessions.length - 1)));
  }, [sessions.length]);

  const settle = useCallback(
    (sessionId: string) => {
      void run({ type: "settle", sessionId }).then(() => {
        // States the reversal; does not offer to perform it. Undoing a Settle is a Revive, and a
        // Revive starts a Backend Session and spends money (ADR 0006, ADR 0003).
        toast.info("Settled — the next message Revives it.");
      });
    },
    [run],
  );

  /**
   * Focus lookups by data attribute rather than by threaded refs.
   *
   * Two shortcuts need to move focus into a pane, and the alternative is passing a ref through
   * PaneLayoutSplit and AgentSessionPane purely so a keystroke can land — which would also mean
   * AgentSessionPane taking a third prop it has no other use for.
   */
  const focusInPane = useCallback(
    (selector: string) => {
      const role = layout.mode === "split" ? layout.focused : "primary";
      const element = document.querySelector<HTMLElement>(`[data-pane="${role}"] ${selector}`);
      element?.focus();
    },
    [layout.mode, layout.focused],
  );

  const handlers = useMemo<KeyboardHandlers>(
    () => ({
      "new-agent-session": () => setNewOpen(true),
      "sidebar-next": () => setCursor((current) => Math.min(current + 1, sessions.length - 1)),
      "sidebar-previous": () => setCursor((current) => Math.max(current - 1, 0)),
      "focus-pane": () => {
        const candidate = sessions[cursor];
        if (candidate) dispatch({ type: "focus", sessionId: candidate.id });
        focusInPane("textarea");
      },
      search: () => focusInPane("[data-transcript-search]"),
      settle: () => {
        const status = focusedId === undefined ? undefined : liveStatuses[focusedId];
        if (focusedId !== undefined && status !== undefined && canSettle(status)) settle(focusedId);
      },
      "toggle-split": () =>
        dispatch({
          type: "toggle_split",
          candidate: sessions.find((session) => session.id !== layout.primary && session.id !== layout.secondary)?.id,
        }),
      "blur-or-abort": () => {
        // Escape with nothing typing means abort — and aborting discards the Steering Queue, so it
        // says what it dropped rather than leaving the reader to notice.
        if (focusedId === undefined) return;
        const chrome = openChrome[focusedId];
        if (!chrome || chrome.status !== "running") return;
        const dropped = chrome.queueDepth;
        void run({ type: "abort", sessionId: focusedId }).then(() => {
          toast.info(
            dropped > 0 ? `aborted · ${dropped} queued message${dropped === 1 ? "" : "s"} discarded` : "aborted",
          );
        });
      },
    }),
    [cursor, dispatch, focusInPane, focusedId, layout.primary, layout.secondary, liveStatuses, openChrome, run, sessions, settle],
  );

  return (
    <KeyboardLayer handlers={handlers} modalOpen={newOpen}>
      <div className="grid h-full min-h-0 grid-cols-[16rem_minmax(0,1fr)]">
        <AgentSessionSidebar
          sessions={sessions}
          primary={layout.primary}
          secondary={layout.secondary}
          cursorId={sessions[cursor]?.id}
          liveStatuses={liveStatuses}
          link={focusedId === undefined ? undefined : openChrome[focusedId]?.link}
          scope={config.scope}
          onFocus={(sessionId) => dispatch({ type: "focus", sessionId })}
          onSplit={(sessionId) => dispatch({ type: "open_split", sessionId })}
          onSettle={settle}
          onNew={() => setNewOpen(true)}
        />

        <PaneLayoutSplit />
      </div>

      <NewAgentSessionDialog
        open={newOpen}
        onOpenChange={setNewOpen}
        onCreated={(sessionId) => dispatch({ type: "focus", sessionId })}
      />
    </KeyboardLayer>
  );
}
