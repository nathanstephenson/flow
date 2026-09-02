import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";

import { canSettle } from "@client/status.ts";
import { useAgentSessionChrome } from "@/agent-session-view.tsx";
import { useAgentSessions, useCommand } from "@/agent-sessions.tsx";
import { useHost } from "@/host.tsx";
import { useRailWidth } from "@/rail-width.ts";
import { railWidthValue } from "@/presentation/rail-width.ts";
import { useRoute } from "@/route.ts";
import { AgentSessionPane } from "@/components/agent-session-pane.tsx";
import { AgentSessionNav, Kbd } from "@/components/agent-session-nav.tsx";
import { KeyboardLayer, type KeyboardHandlers } from "@/components/keyboard-layer.tsx";
import { NewAgentSessionDialog } from "@/components/new-agent-session-dialog.tsx";
import { RailResizeHandle } from "@/components/rail-resize-handle.tsx";
import { SettingsNav } from "@/components/settings-nav.tsx";
import { SettingsPage } from "@/components/settings-page.tsx";
import { Sidebar, SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar.tsx";
import { toast } from "@/components/ui/toaster.tsx";

/**
 * The frame: one rail, and whatever is beside it.
 *
 * There are two things it can be showing — an Agent Session's pane, or the Settings — and the route
 * decides which (web/src/route.ts). The rail is the same `Sidebar` either way and swaps only its
 * contents, so the two views cannot drift into looking like two designs.
 *
 * `SidebarProvider` lives here rather than inside the rail, which is what makes that possible: the
 * width comes from `--sidebar-width` on the provider, so the rail can be dragged wider and hidden
 * altogether without either the rail or the pane knowing.
 *
 * The provider is *controlled* — this owns whether the rail is open — for one reason: ⌘B has to be
 * resolved by web/src/presentation/bindings.ts like every other key. Upstream binds it with its own
 * `window` listener inside the component, which would have been a second keyboard listener this app
 * could neither document nor suppress while a dialog had the keyboard, so that listener is removed
 * (see the GOODHARNESS note in components/ui/sidebar.tsx).
 *
 * Whether the rail is open is deliberately *not* remembered across reloads, though its width is:
 * reloading into an app with no visible navigation is a bad first frame, and hiding the rail is a
 * momentary "give me the width" rather than a preference.
 *
 * It owns the route, and the two pieces of state that are about the *app* rather than about any
 * Agent Session: whether the New Agent Session dialog is open, and where the keyboard cursor is in
 * the rail. Plus the auto-open rule below.
 */
export function AppShell() {
  const { config } = useHost();
  const { sessions } = useAgentSessions();
  const { route, sessionId: focusedId, focus, openSettings, leaveSettings } = useRoute();
  const run = useCommand();

  const [newOpen, setNewOpen] = useState(false);
  const [cursor, setCursor] = useState(0);
  const [railOpen, setRailOpen] = useState(true);
  const rail = useRailWidth();

  /*
   * Which Agent Sessions are showing their Shell.
   *
   * Client state, and it has to be: whether a Shell is *running* is the host's business, but whether
   * you are looking at it is not. Closing the pane leaves the Shell alive, so asking the host "is
   * there a Shell?" would reopen the split on every visit to an Agent Session you had ever used one
   * in. Held here rather than in the pane because the pane remounts when the focus moves, and a
   * split that closed itself every time you glanced at another Agent Session would be a bug.
   */
  const [shellOpen, setShellOpen] = useState<ReadonlySet<string>>(() => new Set());
  const toggleShell = useCallback((sessionId: string) => {
    setShellOpen((current) => {
      const next = new Set(current);
      if (!next.delete(sessionId)) next.add(sessionId);
      return next;
    });
  }, []);

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
   *
   * Gated on the route rather than on `location.hash` now that a hash can name the Settings: a cold
   * load into `#/settings` must not be answered by silently navigating away from them.
   */
  const autoOpened = useRef(false);
  useEffect(() => {
    if (autoOpened.current || route.view !== "session") return;
    if (focusedId !== undefined) {
      autoOpened.current = true;
      return;
    }
    const candidate = sessions[0];
    if (!candidate) return;
    autoOpened.current = true;
    if (candidate.status === "settled") return;
    focus(candidate.id);
  }, [sessions, focusedId, focus, route.view]);

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
      shell: () => {
        // Silently ignored where the host has no pty, for the same reason the button is absent
        // there: a shortcut that reports a capability you do not have teaches nothing.
        if (focusedId !== undefined && config.shell) toggleShell(focusedId);
      },
      "toggle-rail": () => setRailOpen((open) => !open),
      // `?` now lands somewhere, which is what it was resolving to nothing for.
      "keyboard-settings": () => openSettings("keyboard"),
      "leave-settings": leaveSettings,
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
    [
      chrome,
      config.shell,
      cursor,
      focus,
      focusInPane,
      focusedId,
      leaveSettings,
      openSettings,
      run,
      sessions,
      settle,
      toggleShell,
    ],
  );

  const settings = route.view === "settings";

  return (
    <KeyboardLayer handlers={handlers} modalOpen={newOpen} view={route.view}>
      {/* min-h-0 beats upstream's min-h-svh through twMerge: this app is exactly the viewport tall
          and its scrollers are internal, so a minimum height would push them off the bottom.
          `style` is spread after upstream's own custom properties, so this is the supported way to
          override the width it otherwise hardcodes to 16rem. */}
      <SidebarProvider
        className="h-full min-h-0"
        open={railOpen}
        onOpenChange={setRailOpen}
        style={{ "--sidebar-width": railWidthValue(rail.width) } as CSSProperties}
      >
        <Sidebar
          collapsible="offcanvas"
          role="complementary"
          aria-label={settings ? "Settings" : "Agent Sessions"}
          className="border-r border-sidebar-border"
        >
          {/* Offcanvas rather than icon: these rows are two lines tall and their Settle action hides
              itself in icon mode, so a 3rem rail of bare status dots would be a worse thing to
              collapse to than the extra width the pane gains from hiding it outright. */}
          <RailResizeHandle width={rail.width} onResize={rail.set} onNudge={rail.nudge} />

          {settings ? (
            <SettingsNav
              section={route.section}
              onSelect={openSettings}
              onLeave={leaveSettings}
            />
          ) : (
            <AgentSessionNav
              sessions={sessions}
              focusedId={focusedId}
              focusedStatus={chrome?.status}
              cursorId={sessions[cursor]?.id}
              link={chrome?.link}
              scope={config.scope}
              onFocus={focus}
              onSettle={settle}
              onNew={() => setNewOpen(true)}
              onOpenSettings={openSettings}
            />
          )}
        </Sidebar>

        {/* A single-row grid rather than upstream's flex column: the pane inside is itself a grid
            sized to its row, and a flex parent would need `flex-1` threading down into it. One row
            of `minmax(0,1fr)` is what the frame's outer grid used to give it, unchanged. */}
        <SidebarInset className="grid min-h-0 grid-rows-[minmax(0,1fr)] overflow-hidden">
          {/*
           * The only way back to the rail on a narrow window. Upstream hides the whole rail below
           * `md` and offers it as a Sheet instead, which takes the resize handle with it — so
           * without this, collapsing on a small screen would be one-way. Hidden from `md` up, where
           * the handle itself is the affordance.
           */}
          <SidebarTrigger className="absolute top-2 left-2 z-30 md:hidden" />
          {settings ? (
            <SettingsPage section={route.section} />
          ) : focusedId === undefined ? (
            <NothingFocused />
          ) : (
            <AgentSessionPane
              sessionId={focusedId}
              {...(config.shell
                ? { shell: { open: shellOpen.has(focusedId), onToggle: () => toggleShell(focusedId) } }
                : {})}
            />
          )}
        </SidebarInset>
      </SidebarProvider>

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
