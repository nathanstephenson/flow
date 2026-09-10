import { useEffect, useRef, useState } from "react";

import type { ScopeSkills, Skill } from "../../src/protocol/events.ts";

/**
 * Asking the Session Host which Skills a Scope offers, before it has an Agent Session.
 *
 * The sibling of `useBranches`, and it lives beside it because the two ask about the same free-text
 * Scope field off the same debounce. Inside an Agent Session the Composer asks a different way — the
 * `list_skills` Command, keyed by session — and that path is untouched.
 *
 * **Prefetched, not lazy, which is the opposite of `useBranches` next door.** A Skill list costs a
 * Backend Session: pi answers off disk, but Claude spawns its CLI and takes about nine seconds
 * (`src/daemon/models.ts` carries the measurement). Waiting for somebody to press `/` would spend
 * all nine of those seconds in front of them with a menu open and empty. Asking when the Scope
 * settles spends them while they are choosing a Backend Adapter and typing a first message — which
 * ADR 0020 measured at five to forty seconds — so by the time `/` is pressed the answer is usually
 * already here. Nothing is cached anywhere: the host holds a probe only while it is in flight,
 * because a Skill directory changes whenever somebody saves a file.
 *
 * `undefined` until the first answer, which is not the same as an empty list: one is a menu still
 * looking and the other is a menu with nothing to offer, and the composer's menu renders them
 * differently.
 */

export type ScopeSkillCatalogue = {
  skills: Skill[] | undefined;
  /** Why there are none, when there are none for a reason. Prose, straight from the host. */
  problem: string | undefined;
};

export function useScopeSkills(
  scope: string | undefined,
  backend: string,
): ScopeSkillCatalogue {
  const [answer, setAnswer] = useState<ScopeSkills | undefined>(undefined);
  /*
   * Bumped per request, so an answer for a Scope its reader has moved on from is dropped rather than
   * rendered — the same guard `useBranches` carries, and it matters more here. A path typed by hand
   * settles at intermediate values, each of which spawns a backend, and the answers can return out
   * of order; without this, the menu could offer one directory's Skills for another's Scope.
   *
   * This is also the whole of the boot-storm guard, and it belongs on the client rather than on the
   * host: only the client knows the Scope is still being typed.
   */
  const generation = useRef(0);

  useEffect(() => {
    const mine = (generation.current += 1);
    setAnswer(undefined);
    if (scope === undefined || scope.trim() === "" || backend === "") return;

    void (async () => {
      try {
        const response = await fetch(
          `/api/skills?scope=${encodeURIComponent(scope)}&backend=${encodeURIComponent(backend)}`,
          { credentials: "same-origin" },
        );
        const found = response.ok ? ((await response.json()) as ScopeSkills) : undefined;
        // Guarded against the Scope having moved on, and against the answer being about another one:
        // the host echoes the Scope back precisely so a client can check rather than trust.
        if (generation.current !== mine || found?.scope !== scope) return;
        setAnswer(found);
      } catch {
        // A failed ask reads as "no Skills" rather than as an error, the choice `useBranches` makes.
        // There is no action a reader could take from a message here, and `/` still types a `/`.
        if (generation.current === mine) setAnswer({ backend, scope, skills: [] });
      }
    })();
  }, [scope, backend]);

  return { skills: answer?.skills, problem: answer?.problem };
}
