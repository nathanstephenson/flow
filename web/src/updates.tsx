import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";

import type { WebUpdateStatus } from "../../src/protocol/update.ts";
import { authenticatedFetch } from "@/authentication.ts";
import {
  UpdateController,
  type UpdatesSnapshot,
} from "@/presentation/update-controller.ts";
import type { UpdateViewState } from "@/presentation/update.ts";

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
  const [controller] = useState(() => new UpdateController({
    getStatus: refresh => authenticatedFetch(`/api/update${refresh ? "?refresh=1" : ""}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    }),
    beginUpdate: confirmedVersion => authenticatedFetch("/api/update", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirmed: true, version: confirmedVersion }),
    }),
    now: () => Date.now(),
    setTimeout: (callback, delayMs) => window.setTimeout(callback, delayMs),
    clearTimeout: handle => window.clearTimeout(handle as number),
    setInterval: (callback, delayMs) => window.setInterval(callback, delayMs),
    clearInterval: handle => window.clearInterval(handle as number),
    onSucceeded: operationId => {
      const key = `flow-update-reloaded:${operationId}`;
      if (sessionStorage.getItem(key) === "yes") return;
      sessionStorage.setItem(key, "yes");
      location.reload();
    },
  }));
  const [snapshot, setSnapshot] = useState<UpdatesSnapshot>(controller.snapshot);

  useEffect(() => {
    const unsubscribe = controller.subscribe(setSnapshot);
    // Connecting a browser performs the first server-side check. All open browsers ask hourly; the
    // Session Host's 15-minute cache is shared, so this does not multiply registry traffic.
    controller.start();
    return () => {
      unsubscribe();
      controller.stop();
    };
  }, [controller]);

  const check = useCallback((refresh = false) => controller.check(refresh), [controller]);
  const begin = useCallback((confirmedVersion: string) => controller.begin(confirmedVersion), [controller]);

  return (
    <UpdatesContext.Provider value={{ ...snapshot, check, begin }}>
      {children}
    </UpdatesContext.Provider>
  );
}
