// A deliberately plain stub, and it is meant to stay plain until Step 5's redesign. Its job is to
// exercise every piece of new plumbing end to end — the embedded manifest, the SPA fallback, the
// cookie handoff, the shared transport, and the shared reducer running in a browser as TypeScript —
// while the app is still small enough that a fault here is obviously a plumbing fault and not a
// design one.
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

// The whole point of the migration: the reducer and the transport the TUI runs, imported rather than
// copied.
import { connect, type LinkState } from "@client/connection.ts";
import { initialState, reduce, type Entry, type ViewState } from "@client/reduce.ts";
import { editDiff } from "@client/diff.ts";
import { relativeTime } from "@client/relative-time.ts";
import type { SessionSummary } from "../../src/protocol/commands.ts";

/**
 * Same origin, and no token: in the browser the credential is the HttpOnly cookie the /auth handoff
 * set, so there is nothing for this side to hold (ADR 0004). In the dev server that origin is Vite's,
 * which proxies /api and /auth at the Session Host.
 */
const connection = connect({ url: "" });

/** The Agent Session list, polled the way the TUI polls it. */
function useAgentSessions(): SessionSummary[] {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);

  useEffect(() => {
    const poll = async (): Promise<void> => setSessions(await connection.listSessions());
    void poll();
    const timer = setInterval(() => void poll(), 2000);
    return () => clearInterval(timer);
  }, []);

  return sessions;
}

/** One Presentation Transcript, replayed from seq 0 and then followed across reconnects. */
function useTranscript(sessionId: string | undefined): { view: ViewState; link: LinkState } {
  const [view, setView] = useState<ViewState>(initialState);
  const [link, setLink] = useState<LinkState>("connecting");

  useEffect(() => {
    setView(initialState());
    if (!sessionId) return;

    // subscribe() owns the reconnect: it resumes from the highest seq it delivered, so a dropped
    // stream costs nothing and the state below keeps accumulating across one.
    return connection.subscribe({
      sessionId,
      since: 0,
      onEntry: (logged) => setView((current) => reduce(current, logged)),
      onLink: setLink,
    });
  }, [sessionId]);

  return { view, link };
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
  const { view, link } = useTranscript(selected);
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
            {selected} · {view.status} · link {link}
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
