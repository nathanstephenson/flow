import { useState, type CSSProperties } from "react";

import { sessionLabel } from "@client/session-label.ts";
import { toolSummary } from "@client/tool-summary.ts";
import { useAgentSession, useChrome } from "@/agent-session-view.tsx";
import { useAgentSessions } from "@/agent-sessions.tsx";
import type { Docks } from "@/docks.ts";
import type { DraftStash } from "@/drafts.ts";
import type { AgentSessionView, Chrome } from "@/store/contract.ts";
import { AgentSessionPaneHeader } from "@/components/agent-session-pane-header.tsx";
import { Composer } from "@/components/composer.tsx";
import { Dock } from "@/components/dock.tsx";
import { TranscriptSearchField } from "@/components/transcript-search-field.tsx";
import { SubagentOpenProvider } from "@/components/subagent-open.tsx";
import { TranscriptView } from "@/components/transcript-view.tsx";
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
  const [query, setQuery] = useState("");

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
        sessionId={sessionId}
        chrome={chrome}
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

  const bottom = docks?.layout.bottom;
  const right = docks?.layout.right;
  const bottomOpen = bottom !== undefined && !bottom.minimised;
  const rightOpen = right !== undefined && !right.minimised;

  /*
   * Header across the top, then the Docks divide what is under it.
   *
   * The header spans the full width rather than stopping at the right Dock's edge, because what it
   * says — the title, the status, the Scope — is true of the whole Agent Session and not of the
   * conversation column alone. It is also where the Dock toggles live, and a button sitting to the
   * left of the thing it controls reads as belonging to something else.
   *
   * Beneath it the right Dock takes the full height and the bottom Dock only the conversation's
   * width. A terminal wants rows more than it wants columns, so the taller Dock is the one that gets
   * the whole column; the bottom Dock is for something glanced at under what you are reading.
   *
   * Each Dock's size is a CSS custom property rather than a React value in the grid template,
   * because that is what lets a drag repaint without a re-render (web/src/components/use-resize-drag.ts).
   * A minimised Dock is left out of the template entirely rather than sized to zero: a zero-height
   * row would still have the Shell's FitAddon measuring a container it is not in.
   */
  return (
    <div className="grid min-h-0 min-w-0 grid-rows-[auto_minmax(0,1fr)]">
      <AgentSessionPaneHeader sessionId={sessionId} title={title} chrome={chrome} docks={docks} />

      <div
        // The frame the Docks are a share of, and the element their live sizes are written onto. It
        // is this element rather than the pane so that "how much room is there" excludes the header,
        // which no drag can take space from.
        data-dock-frame=""
        className={cn(
          "grid min-h-0 min-w-0",
          rightOpen ? "grid-cols-[minmax(0,1fr)_var(--dock-right)]" : "grid-cols-[minmax(0,1fr)]",
        )}
        style={{ "--dock-bottom": `${bottom?.size ?? 0}px`, "--dock-right": `${right?.size ?? 0}px` } as CSSProperties}
      >
        <div
          className={cn(
            "grid min-h-0 min-w-0",
            bottomOpen ? "grid-rows-[minmax(0,1fr)_var(--dock-bottom)]" : "grid-rows-[minmax(0,1fr)]",
          )}
        >
          {conversation}
          {bottomOpen && bottom ? (
            <Dock side="bottom" dock={bottom} sessionId={sessionId} shells={shells} dispatch={docks.dispatch} />
          ) : null}
        </div>

        {rightOpen && right ? (
          <Dock side="right" dock={right} sessionId={sessionId} shells={shells} dispatch={docks.dispatch} />
        ) : null}
      </div>
    </div>
  );
}
