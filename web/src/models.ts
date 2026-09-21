import { useEffect, useState } from "react";

import type { BackendModels } from "../../src/protocol/events.ts";
import { authenticatedFetch } from "@/authentication.ts";

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
  problem: string | undefined;
} {
  const [catalogue, setCatalogue] = useState<BackendModels[] | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [problem, setProblem] = useState<string | undefined>(undefined);

  const load = async (refresh: boolean): Promise<void> => {
    setLoading(true);
    setProblem(undefined);
    try {
      const response = await authenticatedFetch(`/api/models${refresh ? "?refresh=1" : ""}`);
      if (!response.ok) {
        setProblem(`Model capability discovery failed (${response.status}).`);
        return;
      }
      setCatalogue((await response.json()) as BackendModels[]);
    } catch {
      setProblem("Could not reach the Session Host to confirm model Effort support.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load(false);
    // On mount only: the host caches the answer, so re-asking on every render would be a request
    // per keystroke for a list that cannot have moved. "Check again" is the way to re-ask.
  }, []);

  return { catalogue, loading, problem, refresh: () => load(true) };
}
