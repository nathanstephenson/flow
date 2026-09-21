import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";

import type { WebUpdateStatus } from "../../src/protocol/update.ts";
import { authenticatedFetch } from "@/authentication.ts";
import {
  OPEN_BROWSER_UPDATE_CHECK_MS,
  UPDATE_RECOVERY_POLL_MS,
  UPDATE_RECONNECT_POLL_MS,
  pollUpdateChecks,
  reconnectView,
  type UpdateViewState,
} from "@/presentation/update.ts";

type UpdatesValue = {
  status?: WebUpdateStatus;
  view: UpdateViewState;
  transportError?: string;
  check(refresh?: boolean): Promise<void>;
  begin(confirmedVersion: string): Promise<void>;
};

const UpdatesContext = createContext<UpdatesValue | undefined>(undefined);

export function useUpdates(): UpdatesValue {
  const value = useContext(UpdatesContext);
  if (!value) throw new Error("useUpdates outside UpdatesProvider");
  return value;
}

export function UpdatesProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<WebUpdateStatus>();
  const [view, setView] = useState<UpdateViewState>("checking");
  const [transportError, setTransportError] = useState<string>();
  const reconnectingSince = useRef<number | undefined>(undefined);

  const check = useCallback(async (refresh = false): Promise<void> => {
    if (refresh) setView("checking");
    try {
      const response = await authenticatedFetch(`/api/update${refresh ? "?refresh=1" : ""}`, {
        cache: "no-store",
        signal: AbortSignal.timeout(10_000),
      });
      const body = (await response.json()) as WebUpdateStatus & { error?: string };
      if (!response.ok) throw new Error(body.error ?? `Could not check for updates (${response.status})`);
      setStatus(body);
      setTransportError(undefined);
      reconnectingSince.current = undefined;
      setView("ready");

      if (body.operation?.state === "succeeded") {
        const key = `flow-update-reloaded:${body.operation.id}`;
        if (sessionStorage.getItem(key) !== "yes") {
          sessionStorage.setItem(key, "yes");
          location.reload();
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not reach the Session Host";
      setTransportError(message);
      const operationStarted = status?.operation?.state === "updating" || view === "starting" || view === "reconnecting" || view === "recovery-needed";
      if (!operationStarted) {
        setView("ready");
        return;
      }
      reconnectingSince.current ??= Date.now();
      setView(reconnectView(reconnectingSince.current, Date.now()));
    }
  }, [status?.operation?.state, view]);

  const begin = useCallback(async (confirmedVersion: string): Promise<void> => {
    setView("starting");
    setTransportError(undefined);
    let response: Response;
    try {
      response = await authenticatedFetch("/api/update", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirmed: true, version: confirmedVersion }),
      });
    } catch {
      // The connection can disappear after the explicit request reached the host but before its 202
      // reaches this browser. Never repeat the mutation: reconnect and inspect the durable outcome.
      reconnectingSince.current = Date.now();
      setView("reconnecting");
      return;
    }
    const body = (await response.json()) as WebUpdateStatus & { error?: string };
    if (!response.ok) {
      setView("ready");
      throw new Error(body.error ?? `Could not start the update (${response.status})`);
    }
    setStatus(body);
    reconnectingSince.current = Date.now();
    setView("reconnecting");
  }, []);

  // Connecting a browser performs the first server-side check. All open browsers ask hourly; the
  // controller's 15-minute cache is shared by them, so this does not multiply registry traffic.
  useEffect(() => {
    void check(false);
    const timer = window.setInterval(() => { void check(false); }, OPEN_BROWSER_UPDATE_CHECK_MS);
    return () => window.clearInterval(timer);
  }, []); // The callback deliberately reads the first, empty operation state for this ambient poll.

  const polling = status?.operation?.state === "updating" || view === "reconnecting" || view === "recovery-needed";
  const pollingRef = useRef(polling);
  const pollDelayRef = useRef(UPDATE_RECONNECT_POLL_MS);
  pollingRef.current = polling;
  pollDelayRef.current = view === "recovery-needed" ? UPDATE_RECOVERY_POLL_MS : UPDATE_RECONNECT_POLL_MS;

  useEffect(() => {
    if (!polling) return;
    let cancelled = false;
    let cancelWait: (() => void) | undefined;
    void pollUpdateChecks({
      active: () => !cancelled && pollingRef.current,
      delay: () => pollDelayRef.current,
      wait: delayMs => new Promise(resolve => {
        const timer = window.setTimeout(resolve, delayMs);
        cancelWait = () => { window.clearTimeout(timer); resolve(); };
      }),
      check: () => check(false),
    });
    return () => {
      cancelled = true;
      cancelWait?.();
    };
  }, [check, polling]);

  return (
    <UpdatesContext.Provider value={{ status, view, ...(transportError ? { transportError } : {}), check, begin }}>
      {children}
    </UpdatesContext.Provider>
  );
}
