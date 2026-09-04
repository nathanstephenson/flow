import {
  isAttachmentMediaType,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_ATTACHMENT_BASE64_BYTES,
  type AttachmentMediaType,
} from "../../../src/protocol/attachments.ts";

/**
 * Which of a paste's items become Attachments, and why the rest did not.
 *
 * Its own DOM-free module for the reason `rail-width.ts` is one: the interesting part of a paste is
 * not the clipboard event, it is the arithmetic around the caps and the question of what to tell
 * someone whose screenshot was refused. A silent drop looks like a broken paste, and a wrong cap
 * looks like a broken model — neither announces itself, and neither is reachable from a test through
 * a real `ClipboardEvent`.
 *
 * The caps themselves are imported rather than restated. They are the Session Host's, which refuses
 * the same things (a client-offered value it cannot use is refused), and a second copy here would be
 * a second answer to "how big is too big" able to disagree with the one that matters.
 */

/** A candidate for attachment, described in the terms a `DataTransferItem` can answer in. */
export type PastedItem = {
  /** The MIME type the clipboard reported. */
  type: string;
  /** Decoded bytes. Compared against the base64 cap after accounting for the encoding's overhead. */
  size: number;
};

export type PasteRefusal = "not-an-image" | "too-large" | "too-many";

export type PasteVerdict<T extends PastedItem> =
  | { accepted: true; item: T; mediaType: AttachmentMediaType }
  | { accepted: false; item: T; refusal: PasteRefusal };

/**
 * base64 costs four characters per three bytes, so the decoded cap is the base64 one scaled down.
 * Compared in decoded bytes because that is what a `File` reports before anything has been read —
 * refusing a 40 MB screenshot should not require encoding 40 MB first.
 */
export const MAX_ATTACHMENT_BYTES = Math.floor((MAX_ATTACHMENT_BASE64_BYTES * 3) / 4);

/**
 * Sort a paste into what can be sent and what cannot.
 *
 * `alreadyPending` is how the per-message cap is applied across several pastes rather than within
 * one: someone pasting a tenth and eleventh image separately has still asked for eleven.
 */
export function sortPastedItems<T extends PastedItem>(items: T[], alreadyPending = 0): PasteVerdict<T>[] {
  let room = MAX_ATTACHMENTS_PER_MESSAGE - alreadyPending;
  return items.map((item) => {
    if (!isAttachmentMediaType(item.type)) return { accepted: false, item, refusal: "not-an-image" };
    if (item.size > MAX_ATTACHMENT_BYTES) return { accepted: false, item, refusal: "too-large" };
    // Checked last so a run of unsendable items does not consume the room a sendable one needed.
    if (room <= 0) return { accepted: false, item, refusal: "too-many" };
    room -= 1;
    return { accepted: true, item, mediaType: item.type };
  });
}

/**
 * What to say about a refusal, as one sentence.
 *
 * Written per reason rather than as one "couldn't attach that": the three causes have three
 * different remedies — convert it, shrink it, send fewer — and a message that does not distinguish
 * them leaves the reader to guess which.
 */
export function refusalMessage(refusal: PasteRefusal): string {
  switch (refusal) {
    case "not-an-image":
      return "Only PNG, JPEG, GIF and WebP images can be attached";
    case "too-large":
      return `An image may not exceed ${Math.floor(MAX_ATTACHMENT_BYTES / 1_000_000)} MB`;
    case "too-many":
      return `At most ${MAX_ATTACHMENTS_PER_MESSAGE} images may be sent with one message`;
  }
}

/**
 * The distinct refusals in a paste, in the order they were met.
 *
 * A paste of eight oversized screenshots is one problem, not eight, so the toasts collapse to one
 * per reason — but a paste that was partly too large and partly not an image has two things worth
 * saying and says both.
 */
export function refusalsIn<T extends PastedItem>(verdicts: PasteVerdict<T>[]): PasteRefusal[] {
  const seen: PasteRefusal[] = [];
  for (const verdict of verdicts) {
    if (!verdict.accepted && !seen.includes(verdict.refusal)) seen.push(verdict.refusal);
  }
  return seen;
}
