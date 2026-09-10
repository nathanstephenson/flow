import type { IncomingAttachment } from "../../../src/protocol/attachments.ts";

/**
 * Drafts, as the arithmetic of who owns an object URL.
 *
 * A **Draft** is a message somebody has typed and not sent (CONTEXT.md): the text, and any
 * Attachments alongside it. It is not a Steering Queue message — that one *has* been sent, the
 * Session Host owns it, and ADR 0014 already wrote its bytes to disk. A Draft has been committed to
 * nothing.
 *
 * This file is DOM-free so `node --test` can hold it to account, which is the whole reason it exists
 * separately from the hook: the interesting part of a Draft store is not the storage, it is deciding
 * *which object URLs a change has orphaned*. Getting that wrong either leaks a whole screenshot for
 * the life of the tab or revokes a URL something is still rendering, and neither failure is visible
 * from reading the call site.
 *
 * So the two functions here report what to revoke and revoke nothing themselves. `URL.revokeObjectURL`
 * is the caller's to call, in web/src/drafts.ts, which is also the only file that can.
 */

/**
 * An Attachment waiting to be sent.
 *
 * Holds both the base64 the command needs and an object URL for the thumbnail, rather than deriving
 * one from the other. A data URL would serve both, but it is the base64 again with a prefix, so
 * every thumbnail would cost a second copy of the whole image in the DOM.
 */
export type PendingAttachment = {
  /** React's key. Not the id the Session Host will mint — that does not exist until this is sent. */
  key: string;
  mediaType: IncomingAttachment["mediaType"];
  data: string;
  url: string;
};

export function outgoing(attachment: PendingAttachment): IncomingAttachment {
  return { mediaType: attachment.mediaType, data: attachment.data };
}

/**
 * What a reader has typed and not sent.
 *
 * The message and nothing else, so the shape is the same for every composer in the app. The New
 * Agent Session view also remembers the Scope being typed, and that is deliberately *not* in here: a
 * Draft is a message, a Scope is a form field, and folding the second into the first would leave the
 * word meaning "a message plus whichever adjacent inputs happened to persist".
 */
export type Draft = { text: string; attachments: PendingAttachment[] };

/** One Draft, shared by every composer nobody has typed into. */
export const EMPTY_DRAFT: Draft = { text: "", attachments: [] };

/**
 * Replace a held Draft, and say which object URLs that dropped.
 *
 * The question is "which URLs does nothing reference any more", not "which Attachments left" — and
 * asking it that way is both simpler and harder to get wrong. Diffing on `key` looks equivalent and
 * is not: a key re-held carrying a fresh URL would leak the old one, silently and for the life of
 * the tab.
 *
 * Comparing URLs rather than object identity is what keeps the refused-send path safe. That path
 * puts the *same* Attachment objects back (see `composer.tsx`), so their URLs are still referenced
 * and nothing is revoked — where an identity diff would have revoked the screenshot a moment before
 * it was rendered again.
 */
export function replaceDraft(
  previous: Draft | undefined,
  next: Draft,
): { draft: Draft; revoke: string[] } {
  if (previous === undefined) return { draft: next, revoke: [] };
  const referenced = new Set(next.attachments.map((attachment) => attachment.url));
  return {
    draft: next,
    revoke: previous.attachments
      .map((attachment) => attachment.url)
      .filter((url) => !referenced.has(url)),
  };
}

/**
 * Forget the Agent Sessions that are gone, and say what that dropped.
 *
 * Reaping deletes one server-side without telling any browser, so nothing else would ever shrink
 * this record — the same reason `pruneLayouts` exists next door in web/src/presentation/docks.ts.
 * Returns the record it was given when nothing changed, so the caller can skip the write.
 *
 * Keys that are not Agent Session ids are left alone. The New Agent Session view's Draft is one of
 * those: it belongs to a session that does not exist yet, so no list of live ids can vouch for it
 * and a prune must not be what deletes it.
 */
export function pruneDrafts(
  drafts: Record<string, Draft>,
  knownSessionIds: readonly string[],
  reserved: readonly string[] = [],
): { drafts: Record<string, Draft>; revoke: string[] } {
  const live = new Set([...knownSessionIds, ...reserved]);
  const gone = Object.keys(drafts).filter((key) => !live.has(key));
  if (gone.length === 0) return { drafts, revoke: [] };

  const kept: Record<string, Draft> = {};
  for (const [key, draft] of Object.entries(drafts)) if (live.has(key)) kept[key] = draft;
  return {
    drafts: kept,
    revoke: gone.flatMap((key) => (drafts[key]?.attachments ?? []).map((a) => a.url)),
  };
}
