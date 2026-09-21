import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";

import type { WebUpdateStatus } from "../../src/protocol/update.ts";
import { authenticatedFetch } from "@/authentication.ts";
import { OPEN_BROWSER_UPDATE_CHECK_MS, UPDATE_RECONNECT_LIMIT_MS, type UpdateViewState } from "@/presentation/update.ts";

type UpdatesValue = {
  status?: WebUpdateStatus;
  view: UpdateViewState;
  transportError?: string;
  check(refresh?: boolean): Promise<void>;
  begin(): Promise<void>;
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
      setView(Date.now() - reconnectingSince.current >= UPDATE_RECONNECT_LIMIT_MS ? "recovery-needed" : "reconnecting");
    }
  }, [status?.operation?.state, view]);

  const begin = useCallback(async (): Promise<void> => {
    setView("starting");
    setTransportError(undefined);
    let response: Response;
    try {
      response = await authenticatedFetch("/api/update", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirmed: true }),
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

  useEffect(() => {
    if (status?.operation?.state !== "updating" && view !== "reconnecting" && view !== "recovery-needed") return;
    const delay = view === "recovery-needed" ? 10_000 : 2_000;
    const timer = window.setTimeout(() => { void check(false); }, delay);
    return () => window.clearTimeout(timer);
  }, [check, status?.operation?.state, view]);

  return (
    <UpdatesContext.Provider value={{ status, view, ...(transportError ? { transportError } : {}), check, begin }}>
      {children}
    </UpdatesContext.Provider>
  );
}
