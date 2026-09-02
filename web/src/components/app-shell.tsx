import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { canSettle } from "@client/status.ts";
import { useAgentSessionChrome } from "@/agent-session-view.tsx";
import { useAgentSessions, useCommand } from "@/agent-sessions.tsx";
import { useFocusedAgentSession } from "@/focused-agent-session.ts";
import { useHost } from "@/host.tsx";
import { AgentSessionPane } from "@/components/agent-session-pane.tsx";
import { AgentSessionSidebar, Kbd } from "@/components/agent-session-sidebar.tsx";
import { KeyboardLayer, type KeyboardHandlers } from "@/components/keyboard-layer.tsx";
import { NewAgentSessionDialog } from "@/components/new-agent-session-dialog.tsx";
import { toast } from "@/components/ui/toaster.tsx";

/**
 * The frame: a rail of Agent Sessions, and the focused one's pane.
 *
 * It owns the focused Agent Session — one at a time, mirrored into `location.hash` — and the two
 * pieces of state that are about the *app* rather than about any Agent Session: whether the New
 * Agent Session dialog is open, and where the keyboard cursor is in the rail. Plus the auto-open
 * rule below.
 */
export function AppShell() {
  const { config } = useHost();
  const { sessions } = useAgentSessions();
  const [focusedId, focus] = useFocusedAgentSession();
  const run = useCommand();

  const [newOpen, setNewOpen] = useState(false);
  const [cursor, setCursor] = useState(0);

  /**
   * The focused Agent Session's live chrome, which the rail and the shortcuts both read.
   *
   * The live status wins wherever there is one. A polled `SessionSummary.status` can be two seconds
   * stale, which is exactly long enough for the rail to contradict the pane after a Settle.
   */
  const chrome = useAgentSessionChrome(focusedId);

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
    if (focusedId !== undefined || window.location.hash.startsWith("#/s/")) {
      autoOpened.current = true;
      return;
    }
    const candidate = sessions[0];
    if (!candidate) return;
    autoOpened.current = true;
    if (candidate.status === "settled") return;
    focus(candidate.id);
  }, [sessions, focusedId, focus]);

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
   * Two shortcuts need to move focus into the pane, and the alternative is passing a ref through
   * AgentSessionPane purely so a keystroke can land — a prop it has no other use for.
   */
  const focusInPane = useCallback((selector: string) => {
    document.querySelector<HTMLElement>(`[data-pane] ${selector}`)?.focus();
  }, []);

  const handlers = useMemo<KeyboardHandlers>(
    () => ({
      "new-agent-session": () => setNewOpen(true),
      "sidebar-next": () => setCursor((current) => Math.min(current + 1, sessions.length - 1)),
      "sidebar-previous": () => setCursor((current) => Math.max(current - 1, 0)),
      "sidebar-first": () => setCursor(0),
      "sidebar-last": () => setCursor(Math.max(sessions.length - 1, 0)),
      "focus-pane": () => {
        const candidate = sessions[cursor];
        if (candidate) focus(candidate.id);
        focusInPane("textarea");
      },
      search: () => focusInPane("[data-transcript-search]"),
      settle: () => {
        if (focusedId !== undefined && chrome !== undefined && canSettle(chrome.status)) settle(focusedId);
      },
      "blur-or-abort": () => {
        // Escape with nothing typing means abort — and aborting discards the Steering Queue, so it
        // says what it dropped rather than leaving the reader to notice.
        if (focusedId === undefined || chrome === undefined || chrome.status !== "running") return;
        const dropped = chrome.queueDepth;
        void run({ type: "abort", sessionId: focusedId }).then(() => {
          toast.info(
            dropped > 0 ? `aborted · ${dropped} queued message${dropped === 1 ? "" : "s"} discarded` : "aborted",
          );
        });
      },
    }),
    [chrome, cursor, focus, focusInPane, focusedId, run, sessions, settle],
  );

  return (
    <KeyboardLayer handlers={handlers} modalOpen={newOpen}>
      <div className="grid h-full min-h-0 grid-cols-[16rem_minmax(0,1fr)]">
        <AgentSessionSidebar
          sessions={sessions}
          focusedId={focusedId}
          focusedStatus={chrome?.status}
          cursorId={sessions[cursor]?.id}
          link={chrome?.link}
          scope={config.scope}
          onFocus={focus}
          onSettle={settle}
          onNew={() => setNewOpen(true)}
        />

        {focusedId === undefined ? <NothingFocused /> : <AgentSessionPane sessionId={focusedId} />}
      </div>

      <NewAgentSessionDialog open={newOpen} onOpenChange={setNewOpen} onCreated={focus} />
    </KeyboardLayer>
  );
}

/**
 * Nothing focused. The copy is in the ubiquitous language — "session" on its own is banned as a
 * synonym for Agent Session, and this is the string that used to break that rule most visibly.
 */
function NothingFocused() {
  return (
    <div className="flex min-h-0 items-center justify-center">
      <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
        Select an Agent Session, or press <Kbd>n</Kbd> to start one.
      </p>
    </div>
  );
}
