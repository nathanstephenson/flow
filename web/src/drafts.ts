import { useCallback, useEffect, useMemo, useRef } from "react";

import {
  EMPTY_DRAFT,
  pruneDrafts,
  replaceDraft,
  type Draft,
} from "@/presentation/drafts.ts";

/**
 * The Drafts, per Agent Session, held for the life of the page.
 *
 * A pane remounts whenever the focus moves — `agent-session-pane.tsx` keys it on the Agent Session
 * id — so a Composer's `useState` is destroyed by a glance at another Agent Session. That is the bug
 * this fixes, and it is the same shape of bug `useDocks` exists for: state that belongs to a reader's
 * session with the app rather than to the component currently showing it.
 *
 * **A ref, not `useState`.** `useDocks` holds its layouts in state, which is right for something
 * that changes on a click and wrong for something that changes on a keystroke: rendering from this
 * would re-render the app shell, the rail, the pane header and the whole transcript on every
 * character typed. So nothing renders from the stash. Each view keeps its own local state, seeds it
 * from here on mount, and writes it back on unmount.
 *
 * **Seeding is a read, not a take.** A view that removed its Draft while mounting would lose it to
 * StrictMode, which invokes `useState` initialisers twice. Reading twice is free; taking twice is a
 * bug that only appears in development.
 *
 * **Memory only, deliberately.** Unlike the Docks beside it there is no `localStorage` here. A Draft
 * is not a Setting (ADR 0009) and not a Presentation Transcript (ADR 0001) — but the deciding reason
 * is its Attachments: bytes surviving a reload would belong to no transcript and never would, which
 * is exactly the "class of garbage that has no owner" ADR 0014 rejected an upload endpoint over. A
 * Draft is also not a Steering Queue message: that one has been sent, the host owns it, and its bytes
 * are on disk. This has been committed to nothing, and losing it to a reload is the honest cost of
 * that.
 *
 * The object URLs are the one thing React cannot clean up, so ownership is stated once here: what
 * leaves a *live* list is revoked by the view holding it, and what is left behind belongs to the
 * stash, which revokes it when the Draft is replaced by one dropping it or pruned with its Agent
 * Session. Both halves are needed and neither is sufficient. Double revocation across that boundary
 * is harmless — `revokeObjectURL` on an already-revoked URL does nothing — which is what makes
 * read-not-take safe.
 */

/**
 * The New Agent Session view's Draft, which belongs to no Agent Session.
 *
 * A key rather than a second field, so `read`/`write` have one signature and one meaning everywhere.
 * The space is what makes it safe: Agent Session ids are minted by the Session Host and contain none,
 * so nothing can collide with this, and `pruneDrafts` is told to leave it alone rather than being
 * asked to recognise it.
 */
export const NEW_AGENT_SESSION_DRAFT = "new agent session";

export type DraftStash = {
  /** The Draft held for `key`, or an empty one. Never removes it — see the header. */
  read: (key: string) => Draft;
  /**
   * Hold `draft` for `key`, revoking whatever it dropped.
   *
   * Keyed rather than pre-bound to the caller's own Agent Session, because a send that resolves after
   * the reader has navigated away must still be able to clear the Draft it came from.
   */
  write: (key: string, draft: Draft) => void;
  /**
   * The Scope the New Agent Session view was last showing.
   *
   * Beside the Drafts rather than inside one: a Draft is a message, and a Scope is a form field that
   * happens to survive the same navigation. Keeping them apart is what stops `Draft` drifting into
   * meaning "a message plus whichever inputs we decided to remember".
   */
  scope: () => string | undefined;
  setScope: (scope: string) => void;
};

export function useDraftStash(knownSessionIds: readonly string[]): DraftStash {
  const drafts = useRef<Record<string, Draft>>({});
  const scope = useRef<string | undefined>(undefined);

  const read = useCallback((key: string): Draft => drafts.current[key] ?? EMPTY_DRAFT, []);

  const write = useCallback((key: string, draft: Draft): void => {
    const { draft: held, revoke } = replaceDraft(drafts.current[key], draft);
    drafts.current = { ...drafts.current, [key]: held };
    for (const url of revoke) URL.revokeObjectURL(url);
  }, []);

  const readScope = useCallback((): string | undefined => scope.current, []);
  const setScope = useCallback((next: string): void => {
    scope.current = next;
  }, []);

  /**
   * Forget the Agent Sessions that are gone. Reaping deletes one server-side without telling any
   * browser, so nothing else would ever shrink this.
   */
  useEffect(() => {
    const { drafts: kept, revoke } = pruneDrafts(drafts.current, knownSessionIds, [
      NEW_AGENT_SESSION_DRAFT,
    ]);
    drafts.current = kept;
    for (const url of revoke) URL.revokeObjectURL(url);
  }, [knownSessionIds]);

  return useMemo(
    () => ({ read, write, scope: readScope, setScope }),
    [read, write, readScope, setScope],
  );
}
