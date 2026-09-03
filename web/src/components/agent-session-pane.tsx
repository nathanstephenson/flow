import { useState, type CSSProperties } from "react";

import { sessionLabel } from "@client/session-label.ts";
import { useAgentSession, useChrome } from "@/agent-session-view.tsx";
import { useAgentSessions } from "@/agent-sessions.tsx";
import type { Docks } from "@/docks.ts";
import type { AgentSessionView } from "@/store/contract.ts";
import { AgentSessionPaneHeader } from "@/components/agent-session-pane-header.tsx";
import { Composer } from "@/components/composer.tsx";
import { Dock } from "@/components/dock.tsx";
import { TranscriptSearchField } from "@/components/transcript-search-field.tsx";
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
  docks?: Docks;
  /**
   * Whether the transcript search field is on screen. Owned by the app shell because ⌘F is resolved
   * there with every other key, and the pane remounts per Agent Session.
   */
  searchOpen: boolean;
  onCloseSearch: () => void;
};

export function AgentSessionPane({ sessionId, docks, searchOpen, onCloseSearch }: AgentSessionPaneProps) {
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
      {...(docks ? { docks } : {})}
    />
  );
}

function AttachedPane({
  view,
  sessionId,
  docks,
  searchOpen,
  onCloseSearch,
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

      <TranscriptView view={view} query={query} />

      <Composer sessionId={sessionId} chrome={chrome} />
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
      <AgentSessionPaneHeader sessionId={sessionId} title={title} chrome={chrome} {...(docks ? { docks } : {})} />

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
          {bottomOpen && bottom && docks ? (
            <Dock side="bottom" dock={bottom} sessionId={sessionId} dispatch={docks.dispatch} />
          ) : null}
        </div>

        {rightOpen && right && docks ? (
          <Dock side="right" dock={right} sessionId={sessionId} dispatch={docks.dispatch} />
        ) : null}
      </div>
    </div>
  );
}
