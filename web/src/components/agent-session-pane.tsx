import { useState } from "react";

import { sessionLabel } from "@client/session-label.ts";
import { useAgentSession, useChrome } from "@/agent-session-view.tsx";
import { useAgentSessions } from "@/agent-sessions.tsx";
import { usePaneLayout, usePaneLayoutDispatch, type PaneRole } from "@/pane-layout.tsx";
import type { AgentSessionView } from "@/store/contract.ts";
import { AgentSessionPaneHeader } from "@/components/agent-session-pane-header.tsx";
import { Composer } from "@/components/composer.tsx";
import { TranscriptSearchField } from "@/components/transcript-search-field.tsx";
import { TranscriptView } from "@/components/transcript-view.tsx";
import { cn } from "@/lib/utils.ts";

/**
 * One Agent Session on screen.
 *
 * **The props are `{ sessionId, role }`.** The pane acquires its own view and reads its own snapshots;
 * passing a `ViewState` down from a parent would put the whole subtree behind one re-render per
 * streamed frame and defeat the three-way split entirely.
 *
 * The grid is `auto auto 1fr auto` with `min-height: 0` on both the pane and the transcript — the
 * classic grid overflow trap, and the reason the transcript can scroll while the composer stays put.
 */
export function AgentSessionPane({ sessionId, role }: { sessionId: string; role: PaneRole }) {
  const view = useAgentSession(sessionId);

  // One frame at most: the acquire happens in a layout effect, so this does not reach the screen.
  if (!view) return <div className="min-h-0" />;
  return <AttachedPane key={sessionId} view={view} sessionId={sessionId} role={role} />;
}

function AttachedPane({
  view,
  sessionId,
  role,
}: {
  view: AgentSessionView;
  sessionId: string;
  role: PaneRole;
}) {
  const chrome = useChrome(view);
  const layout = usePaneLayout();
  const dispatch = usePaneLayoutDispatch();
  const { sessions } = useAgentSessions();
  const [query, setQuery] = useState("");

  const summary = sessions.find((candidate) => candidate.id === sessionId);
  const title = summary ? sessionLabel(summary) : sessionId;
  const split = layout.mode === "split";
  const focused = !split || layout.focused === role;

  return (
    <section
      data-pane={role}
      // Clicking anywhere in a pane makes it the one a global action means. Capture, because the
      // click usually lands on a control inside it.
      onFocusCapture={() => dispatch({ type: "focus_pane", role })}
      onMouseDownCapture={() => dispatch({ type: "focus_pane", role })}
      className={cn(
        "grid min-h-0 grid-rows-[auto_auto_minmax(0,1fr)_auto] bg-background",
        // A focused pane is bordered rather than tinted: a background change would make the
        // transcript inside it read as a card.
        split && "border",
        split && (focused ? "border-ring" : "border-border"),
        // Nothing here dims a Settled Agent Session. They are de-emphasised in the rail and at full
        // contrast once focused in a pane, because reading one is exactly what focusing it means
        // (ADR 0006).
      )}
      aria-label={`Agent Session ${title}`}
    >
      <AgentSessionPaneHeader
        sessionId={sessionId}
        title={title}
        chrome={chrome}
        splitOpen={split}
        closable={split}
        onToggleSplit={() =>
          dispatch({
            type: "toggle_split",
            // The freshest Agent Session that is not already in a pane. The Session Host sorts
            // Settled last, so this prefers an active one without needing to say so.
            candidate: sessions.find(
              (candidate) => candidate.id !== layout.primary && candidate.id !== layout.secondary,
            )?.id,
          })
        }
        onClose={() => dispatch({ type: "close", role })}
      />

      <TranscriptSearchField query={query} onQueryChange={setQuery} />

      <TranscriptView view={view} query={query} />

      <Composer sessionId={sessionId} chrome={chrome} />
    </section>
  );
}
