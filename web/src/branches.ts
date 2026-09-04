import { useCallback, useEffect, useRef, useState } from "react";

import type { BranchList } from "../../src/protocol/git.ts";

/**
 * Asking the Session Host what a Scope could be switched to.
 *
 * A query rather than state (ADR 0011's reasoning for `/api/directories`): the answer changes
 * outside GoodHarness whenever someone commits in a terminal, so it is asked when it is wanted and
 * never held. Which is also why this is a hook rather than part of `HostConfig` — the branch a
 * session is *on* arrives on the stream as `branch_changed`, and only the list of alternatives has
 * to be fetched.
 *
 * Deliberately not fetched on mount. The rail can hold twenty Agent Sessions, and a picker that
 * loaded its options before anyone opened it would be twenty requests to render a label the stream
 * already carries.
 */

export type Branches = {
  list: BranchList | undefined;
  loading: boolean;
  /** Ask now. Safe to call repeatedly; only the newest answer is kept. */
  load: () => void;
};

export function useBranches(scope: string | undefined): Branches {
  const [list, setList] = useState<BranchList | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  // Bumped per request, so a slow answer for a Scope its reader has moved on from is dropped rather
  // than rendered — the same hazard the echoed `scope` on BranchList exists for.
  const generation = useRef(0);

  // A new Scope invalidates whatever was loaded for the last one.
  useEffect(() => {
    generation.current += 1;
    setList(undefined);
    setLoading(false);
  }, [scope]);

  const load = useCallback(() => {
    if (scope === undefined || scope.trim() === "") return;
    const mine = (generation.current += 1);
    setLoading(true);
    void (async () => {
      try {
        const response = await fetch(`/api/branches?scope=${encodeURIComponent(scope)}`, {
          credentials: "same-origin",
        });
        const answer = response.ok ? ((await response.json()) as BranchList) : undefined;
        if (generation.current !== mine) return;
        setList(answer);
      } catch {
        // A failed ask leaves the picker with nothing to offer, which reads as "no branches" rather
        // than as an error. There is no action a reader could take from a message here.
        if (generation.current === mine) setList(undefined);
      } finally {
        if (generation.current === mine) setLoading(false);
      }
    })();
  }, [scope]);

  return { list, loading, load };
}
