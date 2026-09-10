import { useEffect, useState } from "react";

import type { BackendModels } from "../../src/protocol/events.ts";

/**
 * What each Backend Adapter can reach, from `GET /api/models`.
 *
 * Two callers now — the Providers section, which needs a list to configure a Default Model against,
 * and the New Agent Session view, which needs one to preselect a model and to know whether that
 * model can be shown an Attachment. Moved out of `settings-providers.tsx` rather than copied,
 * because a second copy of this fetch would be a second answer to "which models exist" able to
 * disagree with the first.
 *
 * Answering spawns a process per backend, so the Session Host memoises it for its own life
 * (ADR 0020) — which is what makes a fetch on every arrival at either view acceptable, and why
 * `refresh` exists as the deliberate way to re-ask.
 */
export function useModelCatalogue(): {
  catalogue: BackendModels[] | undefined;
  loading: boolean;
  refresh: () => Promise<void>;
} {
  const [catalogue, setCatalogue] = useState<BackendModels[] | undefined>(undefined);
  const [loading, setLoading] = useState(true);

  const load = async (refresh: boolean): Promise<void> => {
    setLoading(true);
    try {
      const response = await fetch(`/api/models${refresh ? "?refresh=1" : ""}`, {
        credentials: "same-origin",
      });
      setCatalogue((await response.json()) as BackendModels[]);
    } catch {
      // Every field falls back to a text input, which is a usable page. A toast here would be one
      // more thing to dismiss on the way to typing the id you already knew.
      setCatalogue([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load(false);
    // On mount only: the host caches the answer, so re-asking on every render would be a request
    // per keystroke for a list that cannot have moved. "Check again" is the way to re-ask.
  }, []);

  return { catalogue, loading, refresh: () => load(true) };
}
