import { McpConnectionStatus } from "./mcp-status.tsx";
import { MessageSquare, Plus, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";

import { sessionLabel } from "@client/session-label.ts";
import { toolSummary } from "@client/tool-summary.ts";
import { useAgentSession, useChrome } from "@/agent-session-view.tsx";
import { useAgentSessions } from "@/agent-sessions.tsx";
import { useSessionActions } from "@/composer-actions.ts";
import type { Docks } from "@/docks.ts";
import { useIsMobile } from "@/lib/use-mobile.ts";
import {
  historyWithMobileView,
  MOBILE_TRANSCRIPT,
  mobileViewFromHistory,
  sameMobileView,
  validMobileView,
  type MobileDetail,
  type MobileView,
} from "@/presentation/mobile-navigation.ts";
import { tabLabel, type DockSide } from "@/presentation/docks.ts";
import type { DraftStash } from "@/drafts.ts";
import type { AgentSessionView, Chrome } from "@/store/contract.ts";
import { AgentSessionPaneHeader } from "@/components/agent-session-pane-header.tsx";
import { Composer } from "@/components/composer.tsx";
import { Dock } from "@/components/dock.tsx";
import { TranscriptSearchField } from "@/components/transcript-search-field.tsx";
import { SubagentOpenProvider } from "@/components/subagent-open.tsx";
import { TranscriptView } from "@/components/transcript-view.tsx";
import { Button } from "@/components/ui/button.tsx";
import { cn } from "@/lib/utils.ts";

/**
 * The focused Agent Session, on screen.
 *
 * **The prop is `{ sessionId }`.** The pane acquires its own view and reads its own snapshots;
 * passing a `ViewState` down from a parent would put the whole subtree behind one re-render per
 * streamed frame and defeat the three-way split entirely.
 *
 * The grid is `auto auto 1fr` with `min-height: 0` on both the pane and the transcript — the classic
 * grid overflow trap, and the reason the transcript can scroll at all. The Composer is not a row: it
 * floats against the section and pads the transcript clear of itself by reporting its own height as
 * `--composer-inset`.
 *
 * The Docks divide what is left, under a header that spans the lot. They belong to this Agent
 * Session rather than to the app, which is what lets their toggles live in this header rather than in
 * an app-level bar the app does not have — and what puts them inside the pane and not beside it.
 */
export type AgentSessionPaneProps = {
  sessionId: string;
  /** Absent where the host cannot open a Shell: no content kind exists, so no Dock is offered. */
  docks: Docks;
  /** Whether this host can open a Shell at all; the Docks exist either way. */
  shells: boolean;
  /**
   * Whether the transcript search field is on screen. Owned by the app shell because ⌘F is resolved
   * there with every other key, and the pane remounts per Agent Session.
   */
  searchOpen: boolean;
  onCloseSearch: () => void;
  /**
   * Where the Composer's unsent message lives between mounts. Owned by the app shell for the reason
   * the Docks are: this pane remounts whenever the focus moves, and a Draft must not.
   */
  drafts: DraftStash;
};

export function AgentSessionPane({ sessionId, docks, shells, searchOpen, onCloseSearch, drafts }: AgentSessionPaneProps) {
  const view = useAgentSession(sessionId);

  // One frame at most: the acquire happens in a layout effect, so this does not reach the screen.
  if (!view) return <div className="min-h-0" />;
  return (
    <AttachedPane
      key={sessionId}
      view={view}
      sessionId={sessionId}
      searchOpen={searchOpen}
      onCloseSearch={onCloseSearch}
      docks={docks}
      shells={shells}
      drafts={drafts}
    />
  );
}

/**
 * The précis of the call awaiting authorisation, or undefined when nothing is.
 *
 * `toolSummary` is the same function both front-ends print a tool row with, so what a human is asked
 * to allow reads the same as the row above it — which is the point of not inventing a second
 * description. Undefined where there was nothing worth saying, so the panel shows the name alone
 * rather than a padded blank.
 */
function authorisingSummary(view: AgentSessionView, chrome: Chrome): string | undefined {
  const callId = chrome.authorising?.callId;
  if (callId === undefined) return undefined;
  const call = view.getEntry(`tool:${callId}`);
  return call?.kind === "tool" ? toolSummary(call.input) : undefined;
}

function AttachedPane({
  view,
  sessionId,
  docks,
  shells,
  searchOpen,
  onCloseSearch,
  drafts,
}: { view: AgentSessionView } & AgentSessionPaneProps) {
  const chrome = useChrome(view);
  const { sessions } = useAgentSessions();
  // The verbs this composer's controls stand for. Built here rather than inside the Composer, which
  // no longer knows there is a session behind it — see web/src/composer-actions.ts.
  const actions = useSessionActions(sessionId);
  const [query, setQuery] = useState("");
  const mobile = useIsMobile();
  const [mobileView, setMobileView] = useState<MobileView>(() =>
    validMobileView(mobileViewFromHistory(window.history.state, sessionId), docks.layout),
  );
  const mobileViewRef = useRef(mobileView);
  mobileViewRef.current = mobileView;
  const rememberedDetails = useRef<Record<string, MobileDetail | undefined>>({});
  const handledReveal = useRef(0);

  useEffect(() => {
    if (!mobile || window.visualViewport === null) return;
    const viewport = window.visualViewport;
    const update = (): void => {
      document.documentElement.style.setProperty("--mobile-viewport-height", `${viewport.height}px`);
    };
    update();
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);
    return () => {
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
      document.documentElement.style.removeProperty("--mobile-viewport-height");
    };
  }, [mobile]);

  const writeMobileView = useCallback((next: MobileView, replace = false) => {
    if (sameMobileView(mobileViewRef.current, next) && !replace) return;
    mobileViewRef.current = next;
    setMobileView(next);
    if (!mobile) return;
    const state = historyWithMobileView(window.history.state, sessionId, next);
    window.history[replace ? "replaceState" : "pushState"](state, "", window.location.href);
  }, [mobile, sessionId]);

  useEffect(() => {
    const onPopState = (event: PopStateEvent): void => {
      setMobileView(validMobileView(mobileViewFromHistory(event.state, sessionId), docks.layout));
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [docks.layout, sessionId]);

  const shownMobileView = validMobileView(mobileView, docks.layout);
  useEffect(() => {
    if (!sameMobileView(shownMobileView, mobileView)) setMobileView(shownMobileView);
  }, [mobileView, shownMobileView]);

  useEffect(() => {
    if (shownMobileView.kind !== "dock") return;
    const key = `${shownMobileView.side}:${shownMobileView.tabId}`;
    rememberedDetails.current[key] = shownMobileView.detail;
    const dock = docks.layout[shownMobileView.side];
    if (dock.activeId !== shownMobileView.tabId) {
      docks.dispatch({ type: "activate", side: shownMobileView.side, tabId: shownMobileView.tabId });
    }
    const tab = dock.tabs.find((candidate) => candidate.id === shownMobileView.tabId);
    if (tab?.content?.kind !== "subagents") return;
    const selected = shownMobileView.detail?.kind === "subagent" ? shownMobileView.detail.id : undefined;
    // A base history entry means "show the list", not "erase the persisted selection". In
    // particular, it is the entry restored on remount and when crossing the mobile breakpoint.
    if (selected !== undefined && tab.content.subagentId !== selected) {
      docks.dispatch({
        type: "select-subagent",
        side: shownMobileView.side,
        tabId: shownMobileView.tabId,
        subagentId: selected,
      });
    }
  }, [docks, shownMobileView]);

  // Existing transcript actions open Dock content. On mobile they must also reveal it; a direct
  // Subagent link gets a list entry beneath its detail so browser Back visits both levels.
  useEffect(() => {
    const reveal = docks.reveal;
    if (!reveal || reveal.sessionId !== sessionId || reveal.nonce === handledReveal.current) return;
    handledReveal.current = reveal.nonce;
    docks.acknowledgeReveal(reveal.nonce);
    if (!mobile) return;
    for (const side of ["right", "bottom"] as const) {
      const tab = docks.layout[side].tabs.find((candidate) => candidate.content?.kind === reveal.kind);
      if (!tab) continue;
      const base: MobileView = { kind: "dock", side, tabId: tab.id };
      if (tab.content?.kind === "subagents" && tab.content.subagentId) {
        writeMobileView(base);
        writeMobileView({ ...base, detail: { kind: "subagent", id: tab.content.subagentId } });
      } else {
        writeMobileView(base);
      }
      break;
    }
  }, [docks.layout, docks.reveal, mobile, sessionId, writeMobileView]);

  const selectMobileTab = useCallback((side: DockSide, tabId: string) => {
    docks.dispatch({ type: "activate", side, tabId });
    const key = `${side}:${tabId}`;
    const tab = docks.layout[side].tabs.find((candidate) => candidate.id === tabId);
    const persisted = tab?.content?.kind === "subagents" && tab.content.subagentId
      ? { kind: "subagent" as const, id: tab.content.subagentId }
      : undefined;
    const detail = rememberedDetails.current[key] ?? persisted;
    const base: MobileView = { kind: "dock", side, tabId };
    // Never put a detail immediately after another tab: Back from it must return to this tab's list.
    if (detail) {
      writeMobileView(base);
      writeMobileView({ ...base, detail });
    } else {
      writeMobileView(base);
    }
  }, [docks, writeMobileView]);

  const navigateDetail = useCallback((detail: MobileDetail) => {
    if (shownMobileView.kind !== "dock") return;
    rememberedDetails.current[`${shownMobileView.side}:${shownMobileView.tabId}`] = detail;
    writeMobileView({ ...shownMobileView, detail });
  }, [shownMobileView, writeMobileView]);

  const backFromDetail = useCallback(() => {
    if (shownMobileView.kind !== "dock") return;
    rememberedDetails.current[`${shownMobileView.side}:${shownMobileView.tabId}`] = undefined;
    if (shownMobileView.detail) window.history.back();
    else writeMobileView({ kind: "dock", side: shownMobileView.side, tabId: shownMobileView.tabId }, true);
  }, [shownMobileView, writeMobileView]);

  const summary = sessions.find((candidate) => candidate.id === sessionId);
  const title = summary ? sessionLabel(summary) : sessionId;

  const conversation = (
    <section
      // The one pane, found by attribute: it is how a global shortcut moves focus into the Composer
      // or the transcript search without a ref threaded down from the app shell.
      data-pane=""
      // `relative` and one row fewer than there are children: the Composer floats over the transcript
      // rather than sitting under it, positioned against this section. It stays *inside* `[data-pane]`
      // because that is how app-shell.tsx finds the textarea to focus. The search field's row is in
      // the template only while the field is — otherwise the transcript would inherit an `auto` row
      // and stop being the thing that scrolls.
      className={cn(
        "relative grid min-h-0 min-w-0 bg-background",
        searchOpen ? "grid-rows-[auto_minmax(0,1fr)]" : "grid-rows-[minmax(0,1fr)]",
      )}
      // Nothing here dims a Settled Agent Session. They are de-emphasised in the rail and at full
      // contrast once focused in the pane, because reading one is exactly what focusing it means
      // (ADR 0006).
      aria-label={`Agent Session ${title}`}
    >
      {searchOpen ? (
        <TranscriptSearchField
          query={query}
          onQueryChange={setQuery}
          onClose={() => {
            setQuery("");
            onCloseSearch();
          }}
        />
      ) : null}

      {/*
        * The transcript only mentions that a Subagent ran; the Docks are where its work lives, and
        * this pane is the thing that knows both. Same destination as the Composer's strip — an
        * existing Agents tab in either Dock, else a new one on the right — but carrying which
        * Subagent was asked for, so a click lands on that one rather than the list.
        */}
      <SubagentOpenProvider
        value={(subagentKey) => docks.dispatch({ type: "open-subagents", subagentId: subagentKey })}
      >
        <TranscriptView view={view} query={query} />
      </SubagentOpenProvider>

      <Composer
        id={sessionId}
        chrome={chrome}
        actions={actions}
        drafts={drafts}
        /*
         * What an open Permission Prompt is actually asking about, read here rather than in the
         * Composer.
         *
         * The Composer is handed `chrome` and nothing else, deliberately (store/contract.ts) — and
         * the prompt itself carries only the tool's name, because the call's arguments are already in
         * the transcript under the same id and the protocol will not carry them twice. This pane is
         * the one object that holds both, which is the argument it already makes for the Subagents.
         *
         * Read during render rather than in an effect: `authorising` changes identity when a prompt
         * opens, which publishes the chrome and re-renders this, and the tool row is in the
         * transcript before the prompt is raised.
         */
        authorisingSummary={authorisingSummary(view, chrome)}
        // No side named: whichever Dock already shows the Subagents wins, so a reader who keeps
        // them in the bottom Dock is not handed a second copy on the right. Opened rather than
        // toggled, or a click on "2 agents running" would close the thing it asked to see.
        onShowSubagents={() => docks.dispatch({ type: "open-subagents" })}
      />
    </section>
  );

  const bottom = docks.layout.bottom;
  const right = docks.layout.right;
  const bottomOpen = !bottom.minimised;
  const rightOpen = !right.minimised;
  const selectedDock = shownMobileView.kind === "dock" ? shownMobileView : undefined;

  return (
    <div className={cn("grid min-h-0 min-w-0", mobile ? "mobile-view-height grid-cols-[minmax(0,1fr)] grid-rows-[auto_auto_minmax(0,1fr)]" : "grid-rows-[auto_minmax(0,1fr)]")}>
      <div>
        <AgentSessionPaneHeader sessionId={sessionId} title={title} chrome={chrome} docks={mobile ? undefined : docks} />
        <McpConnectionStatus sessionId={sessionId} />
      </div>

      {mobile ? (
        <MobileViewSelector
          layout={docks.layout}
          selected={shownMobileView}
          shells={shells}
          onTranscript={() => writeMobileView(MOBILE_TRANSCRIPT)}
          onSelect={selectMobileTab}
          onNew={() => {
            const tabId = crypto.randomUUID();
            docks.dispatch({ type: "add-tab", side: "right", tabId });
            writeMobileView({ kind: "dock", side: "right", tabId });
          }}
          onClose={(side, tabId) => {
            if (shownMobileView.kind === "dock" && shownMobileView.side === side && shownMobileView.tabId === tabId) {
              writeMobileView(MOBILE_TRANSCRIPT, true);
            }
            delete rememberedDetails.current[`${side}:${tabId}`];
            docks.dispatch({ type: "close-tab", side, tabId });
          }}
        />
      ) : null}

      <div
        data-dock-frame=""
        className="grid min-h-0 min-w-0 overflow-hidden"
        style={{
          "--dock-bottom": `${bottom.size}px`,
          "--dock-right": `${right.size}px`,
          gridTemplateColumns: mobile || !rightOpen ? "minmax(0,1fr)" : "minmax(0,1fr) var(--dock-right)",
          gridTemplateRows: mobile
            ? "minmax(0,1fr)"
            : bottomOpen
              ? "minmax(0,1fr) var(--dock-bottom)"
              : "minmax(0,1fr) 0px",
        } as CSSProperties}
      >
        <div className={cn("col-start-1 row-start-1 grid min-h-0 min-w-0 grid-rows-[minmax(0,1fr)] overflow-hidden", mobile && shownMobileView.kind !== "transcript" && "hidden")}>
          {conversation}
        </div>

        <Dock
          side="bottom"
          dock={bottom}
          sessionId={sessionId}
          shells={shells}
          dispatch={docks.dispatch}
          mobile={mobile}
          visible={mobile ? selectedDock?.side === "bottom" : bottomOpen}
          mobileNavigation={mobile && selectedDock?.side === "bottom" ? {
            tabId: selectedDock.tabId,
            detail: selectedDock.detail,
            onDetail: navigateDetail,
            onBackDetail: backFromDetail,
          } : undefined}
        />
        <Dock
          side="right"
          dock={right}
          sessionId={sessionId}
          shells={shells}
          dispatch={docks.dispatch}
          mobile={mobile}
          visible={mobile ? selectedDock?.side === "right" : rightOpen}
          mobileNavigation={mobile && selectedDock?.side === "right" ? {
            tabId: selectedDock.tabId,
            detail: selectedDock.detail,
            onDetail: navigateDetail,
            onBackDetail: backFromDetail,
          } : undefined}
        />
      </div>
    </div>
  );
}

function MobileViewSelector({
  layout,
  selected,
  shells,
  onTranscript,
  onSelect,
  onNew,
  onClose,
}: {
  layout: Docks["layout"];
  selected: MobileView;
  shells: boolean;
  onTranscript: () => void;
  onSelect: (side: DockSide, tabId: string) => void;
  onNew: () => void;
  onClose: (side: DockSide, tabId: string) => void;
}) {
  return (
    <div className="flex min-w-0 items-center gap-1 border-b bg-card px-1.5 py-1" aria-label="Agent Session views">
      <div role="tablist" aria-label="Agent Session content" className="flex min-w-0 flex-1 gap-1 overflow-x-auto">
        <button
          type="button"
          role="tab"
          aria-selected={selected.kind === "transcript"}
          onClick={onTranscript}
          className={cn(
            "flex min-h-10 shrink-0 items-center gap-1.5 rounded-xl px-3 text-xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring",
            selected.kind === "transcript" ? "bg-muted text-foreground" : "text-muted-foreground",
          )}
        >
          <MessageSquare className="size-4" aria-hidden />
          Transcript
        </button>
        {(["bottom", "right"] as const).flatMap((side) =>
          layout[side].tabs.map((tab) => {
            const active = selected.kind === "dock" && selected.side === side && selected.tabId === tab.id;
            const label = tabLabel(layout[side], tab.id);
            return (
              <div
                key={`${side}:${tab.id}`}
                className={cn(
                  "flex min-h-10 shrink-0 items-center rounded-xl pr-0.5 pl-3 text-xs",
                  active ? "bg-muted text-foreground" : "text-muted-foreground",
                )}
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={active}
                  className="max-w-36 truncate py-2 font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={() => onSelect(side, tab.id)}
                  title={`${label} · ${side} Dock`}
                >
                  {label}
                </button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="rounded-xl"
                  onClick={() => onClose(side, tab.id)}
                  title={tab.content?.kind === "shell" ? "Close this tab — ends its Shell" : "Close this tab"}
                  aria-label={`Close ${label}${tab.content?.kind === "shell" ? " — ends its Shell" : ""}`}
                >
                  <X aria-hidden />
                </Button>
              </div>
            );
          }),
        )}
      </div>
      <Button
        variant="ghost"
        size="icon-lg"
        className="shrink-0 rounded-xl"
        onClick={onNew}
        aria-label="New tab in the right Dock"
        title={shells ? "New tab" : "New Git, Workflows, or Agents tab"}
      >
        <Plus aria-hidden />
      </Button>
    </div>
  );
}
