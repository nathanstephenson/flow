import { useState } from "react";

import { sessionLabel } from "@client/session-label.ts";
import { useAgentSession, useChrome } from "@/agent-session-view.tsx";
import { useAgentSessions } from "@/agent-sessions.tsx";
import type { AgentSessionView } from "@/store/contract.ts";
import { AgentSessionPaneHeader } from "@/components/agent-session-pane-header.tsx";
import { Composer } from "@/components/composer.tsx";
import { TranscriptSearchField } from "@/components/transcript-search-field.tsx";
import { TranscriptView } from "@/components/transcript-view.tsx";

/**
 * The focused Agent Session, on screen.
 *
 * **The prop is `{ sessionId }`.** The pane acquires its own view and reads its own snapshots;
 * passing a `ViewState` down from a parent would put the whole subtree behind one re-render per
 * streamed frame and defeat the three-way split entirely.
 *
 * The grid is `auto auto 1fr auto` with `min-height: 0` on both the pane and the transcript — the
 * classic grid overflow trap, and the reason the transcript can scroll while the composer stays put.
 */
export function AgentSessionPane({ sessionId }: { sessionId: string }) {
  const view = useAgentSession(sessionId);

  // One frame at most: the acquire happens in a layout effect, so this does not reach the screen.
  if (!view) return <div className="min-h-0" />;
  return <AttachedPane key={sessionId} view={view} sessionId={sessionId} />;
}

function AttachedPane({ view, sessionId }: { view: AgentSessionView; sessionId: string }) {
  const chrome = useChrome(view);
  const { sessions } = useAgentSessions();
  const [query, setQuery] = useState("");

  const summary = sessions.find((candidate) => candidate.id === sessionId);
  const title = summary ? sessionLabel(summary) : sessionId;

  return (
    <section
      // The one pane, found by attribute: it is how a global shortcut moves focus into the Composer
      // or the transcript search without a ref threaded down from the app shell.
      data-pane=""
      className="grid min-h-0 grid-rows-[auto_auto_minmax(0,1fr)_auto] bg-background"
      // Nothing here dims a Settled Agent Session. They are de-emphasised in the rail and at full
      // contrast once focused in the pane, because reading one is exactly what focusing it means
      // (ADR 0006).
      aria-label={`Agent Session ${title}`}
    >
      <AgentSessionPaneHeader sessionId={sessionId} title={title} chrome={chrome} />

      <TranscriptSearchField query={query} onQueryChange={setQuery} />

      <TranscriptView view={view} query={query} />

      <Composer sessionId={sessionId} chrome={chrome} />
    </section>
  );
}
