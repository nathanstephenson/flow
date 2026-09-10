import { useCallback, useEffect, useRef } from "react";

import type { ScopeSkills, Skill } from "../../src/protocol/events.ts";

/**
 * Asking the Session Host which Skills a Scope offers, before it has an Agent Session.
 *
 * Inside an Agent Session the Composer asks a different way — the `list_skills` Command, keyed by
 * session — and that path is untouched. This is the New Agent Session view's half.
 *
 * **A fetcher, not a state hook, and the difference is load-bearing.** An earlier cut of this held
 * the answer in state and handed the Composer whatever was there, which meant that pressing `/`
 * before the request landed answered "no Skills" — and the Composer draws that identically to a
 * Scope that genuinely has none. `composer.tsx` documents why those two must read differently, so
 * what it is handed here is the *request*: one promise per Scope, resolving when the host answers.
 * A menu opened early waits and says "Looking for Skills…", which is true.
 *
 * **Prefetched.** The request is started when the Scope changes rather than when the menu opens,
 * because it costs a Backend Session: pi answers off disk, but Claude spawns its CLI and takes
 * around six seconds (`src/daemon/skills.ts` carries the measurement). Starting it when somebody
 * picks a Project spends that while they are typing instead of in front of an open menu. Nothing is
 * cached — the host holds a probe only while it is in flight, because a Skill directory changes
 * whenever somebody saves a file.
 */
export function useScopeSkills(
  scope: string | undefined,
  backend: string,
): () => Promise<Skill[]> {
  /*
   * The request for the Scope on screen. A ref rather than state because nothing renders from it —
   * the Composer owns what the menu shows — and replacing it is also what retires the stale-answer
   * guard `useBranches` needs: there is no second answer to discard, because the only promise anyone
   * can reach is the current one.
   */
  const inFlight = useRef<Promise<Skill[]>>(Promise.resolve([]));

  useEffect(() => {
    inFlight.current =
      scope === undefined || scope === "" || backend === ""
        ? Promise.resolve([])
        : fetchScopeSkills(scope, backend);
  }, [scope, backend]);

  return useCallback(() => inFlight.current, []);
}

/**
 * The Skills one Scope offers through one Backend Adapter.
 *
 * An empty list for every failure, which is the choice `useBranches` makes and for the same reason:
 * there is no action a reader could take from a message here, and `/` still types a `/`. The
 * `problem` the host reports is deliberately dropped — the menu has nowhere to say it, and "no
 * Skills" is the same outcome either way. Somewhere to show it is a separate decision.
 */
async function fetchScopeSkills(scope: string, backend: string): Promise<Skill[]> {
  try {
    const response = await fetch(
      `/api/skills?scope=${encodeURIComponent(scope)}&backend=${encodeURIComponent(backend)}`,
      { credentials: "same-origin" },
    );
    if (!response.ok) return [];
    const answer = (await response.json()) as ScopeSkills;
    // The host echoes the Scope back precisely so a client can check rather than trust.
    return answer.scope === scope ? answer.skills : [];
  } catch {
    return [];
  }
}
