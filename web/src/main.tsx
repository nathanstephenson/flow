// A deliberately plain stub, and it is meant to stay plain until Step 5's redesign. Its job is to
// exercise every piece of new plumbing end to end — the embedded manifest, the SPA fallback, the
// cookie handoff, and the shared reducer running in a browser as TypeScript — while the app is still
// small enough that a fault here is obviously a plumbing fault and not a design one.
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

// The whole point of the migration: the reducer the TUI runs, imported rather than copied.
import { initialState, reduce, type Entry, type ViewState } from "@client/reduce.ts";
import { editDiff } from "@client/diff.ts";
import { relativeTime } from "@client/relative-time.ts";
import type { SessionSummary } from "../../src/protocol/commands.ts";
import type { LoggedEvent } from "../../src/protocol/events.ts";

/** The Agent Session list, polled the way the TUI polls it. */
function useAgentSessions(): SessionSummary[] {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);

  useEffect(() => {
    const poll = async (): Promise<void> => {
      const response = await fetch("/api/sessions");
      if (response.ok) setSessions((await response.json()) as SessionSummary[]);
    };
    void poll();
    const timer = setInterval(() => void poll(), 2000);
    return () => clearInterval(timer);
  }, []);

  return sessions;
}

/** One Presentation Transcript, replayed from seq 0 and then followed. */
function useTranscript(sessionId: string | undefined): ViewState {
  const [view, setView] = useState<ViewState>(initialState);

  useEffect(() => {
    setView(initialState());
    if (!sessionId) return;

    // Raw EventSource for now. Step 3 replaces it with src/client/connection.ts, which already
    // parses these frames properly and keeps `since` across a reconnect instead of replaying the
    // whole Presentation Transcript every time.
    const stream = new EventSource(`/api/sessions/${encodeURIComponent(sessionId)}/events?since=0`);
    stream.onmessage = (message: MessageEvent<string>) => {
      const logged = JSON.parse(message.data) as LoggedEvent;
      setView((current) => reduce(current, logged));
    };
    return () => stream.close();
  }, [sessionId]);

  return view;
}

function summarise(entry: Entry): string {
  if (entry.kind !== "tool") return entry.text;
  const diff = editDiff(entry.input);
  const edit = diff ? ` ${diff.path} -${diff.removed.length} +${diff.added.length}` : "";
  return `${entry.name} (${entry.status})${edit}`;
}

function App() {
  const sessions = useAgentSessions();
  const [selected, setSelected] = useState<string | undefined>(undefined);
  const view = useTranscript(selected);
  const now = Date.now();

  return (
    <main>
      <h1>GoodHarness</h1>
      <ul>
        {sessions.map((session) => (
          <li key={session.id}>
            <button type="button" onClick={() => setSelected(session.id)} disabled={session.id === selected}>
              {session.title || session.id} · {session.status} · {relativeTime(session.updatedAt, now)}
            </button>
          </li>
        ))}
      </ul>

      {selected === undefined ? (
        <p>{sessions.length === 0 ? "No Agent Sessions." : "Pick an Agent Session."}</p>
      ) : (
        <section>
          <h2>
            {selected} · {view.status}
            {view.queue.length > 0 ? ` · ${view.queue.length} queued` : ""}
          </h2>
          {view.entries.map((entry) => (
            // Both kind and id, because ids are only unique within a kind.
            <pre key={`${entry.kind}:${entry.id}`}>{`${entry.kind}: ${summarise(entry)}`}</pre>
          ))}
        </section>
      )}
    </main>
  );
}

const mount = document.getElementById("root");
if (!mount) throw new Error("index.html is missing #root");
createRoot(mount).render(<App />);
