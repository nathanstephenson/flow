import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";

import type { Command, SessionSummary } from "../../src/protocol/commands.ts";
import { toast } from "@/components/ui/toaster.tsx";
import { useHost } from "@/host.tsx";

/**
 * The Agent Session list, polled.
 *
 * A poll rather than a subscription because the Session Host offers no push for the list; the
 * hand-rolled version exists rather than a query library because there are no cache keys, no
 * pagination and no invalidation graph here — there is one endpoint that the host already sorts.
 * What it does add over a bare `setInterval` is the four things the old client lacked: it stops
 * while the tab is hidden instead of hammering loopback every two seconds in the background, it
 * aborts a poll it no longer wants, it drops a late response that a newer one has already
 * overtaken, and it backs off when the host is not answering.
 *
 * It is a provider rather than a module-level store because there is no reducer behind it and
 * nothing else needs it: `contract.ts` deliberately defines no surface for the Agent Session list,
 * because a list of summaries is not a Presentation Transcript and has none of the properties that
 * made the per-Agent-Session views worth their machinery.
 */

const POLL_MS = 2_000;
const BACKOFF_MAX_MS = 30_000;

type SessionsValue = {
  sessions: SessionSummary[];
  /** Poll now. Called after every command, because a command is the thing most likely to change it. */
  nudge: () => void;
};

const SessionsContext = createContext<SessionsValue | undefined>(undefined);

export function useAgentSessions(): SessionsValue {
  const value = useContext(SessionsContext);
  if (!value) throw new Error("useAgentSessions outside SessionsProvider");
  return value;
}

export function SessionsProvider({ children }: { children: ReactNode }) {
  const { connection } = useHost();
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const nudgeRef = useRef<() => void>(() => {});

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let inFlight: AbortController | undefined;
    // Monotonic, so a slow response cannot overwrite the result of a poll that started later.
    let issued = 0;
    let delivered = 0;
    let failures = 0;

    const schedule = (delay: number): void => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void poll(), delay);
    };

    const poll = async (): Promise<void> => {
      if (stopped || document.hidden) return;
      inFlight?.abort();
      inFlight = new AbortController();
      const ticket = ++issued;
      try {
        const next = await connection.listSessions();
        if (stopped || ticket <= delivered) return;
        delivered = ticket;
        failures = 0;
        setSessions(next);
        schedule(POLL_MS);
      } catch {
        if (stopped) return;
        failures += 1;
        // A host that has gone away should not be asked twice a second forever.
        schedule(Math.min(BACKOFF_MAX_MS, POLL_MS * 2 ** failures));
      }
    };

    const onVisible = (): void => {
      if (!document.hidden) void poll();
    };

    nudgeRef.current = () => void poll();
    void poll();
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      stopped = true;
      nudgeRef.current = () => {};
      if (timer) clearTimeout(timer);
      inFlight?.abort();
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [connection]);

  const nudge = useCallback(() => nudgeRef.current(), []);

  return <SessionsContext.Provider value={{ sessions, nudge }}>{children}</SessionsContext.Provider>;
}

/**
 * Sends a command, reports what happened, and re-polls.
 *
 * Both halves are new. A failed command used to vanish into an unhandled rejection, so a refused
 * settle looked exactly like a slow one; and the list used to be re-polled after a settle but never
 * after an abort, so the sidebar and the pane disagreed until the next tick.
 *
 * Returns the result, or `undefined` if the host refused — callers that need to undo something they
 * did optimistically in the *composer* (never in the transcript, ADR 0001) check for that.
 */
export function useCommand(): <T>(command: Command) => Promise<T | undefined> {
  const { connection } = useHost();
  const { nudge } = useAgentSessions();

  return useCallback(
    async <T,>(command: Command): Promise<T | undefined> => {
      try {
        const result = await connection.command<T>(command);
        nudge();
        return result;
      } catch (error) {
        toast.error(`${command.type} failed`, error instanceof Error ? error.message : String(error));
        nudge();
        return undefined;
      }
    },
    [connection, nudge],
  );
}
