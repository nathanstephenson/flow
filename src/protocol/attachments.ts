/**
 * Attachments, as they cross the wire.
 *
 * In the protocol rather than beside `src/daemon/store.ts` because every layer needs the same
 * closed set: a composer decides whether a paste is even offerable, the Session Host refuses one it
 * cannot use, the HTTP route names a `content-type`, and each Backend Adapter hands a media type to
 * its SDK. `src/daemon/store.ts` owns where the bytes *live*; this file owns only what they may be.
 *
 * The set is the intersection both SDKs can serve, and it is Claude's `Base64ImageSource.media_type`
 * union verbatim — pi will take any `mimeType` string, so it is the narrower end that fixes this.
 */

/**
 * The media types an Attachment may have, mapped to the extension its id carries.
 *
 * An id **is** a filename — `<uuid>.png` — so a media type is recoverable from an id and is
 * therefore never sent alongside one. Carrying both would be two records of one fact, able to
 * disagree about a file on disk. `SessionMeta.worktree` writes down what could be derived for the
 * opposite reason: a wrong answer there runs `git worktree remove`, where a wrong answer here costs
 * one wrong header. The extension set is closed and checked on the way in, so it cannot be wrong.
 */
export const ATTACHMENT_MEDIA_TYPES = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
} as const;

export type AttachmentMediaType = keyof typeof ATTACHMENT_MEDIA_TYPES;

/**
 * One Attachment on its way in: base64, because that is the only form either SDK accepts and so the
 * only form that avoids a decode on the way up and an encode on the way back down.
 */
export type IncomingAttachment = {
  mediaType: AttachmentMediaType;
  /** base64, without a data-URL prefix. */
  data: string;
};

/**
 * The cap on one Attachment, counted in base64 characters rather than in decoded bytes, because that
 * is the unit every provider states its own limit in. 5 MB clears the strictest documented one —
 * Bedrock and Vertex — where the Claude API direct would allow 10 MB, and it is far above any
 * screenshot a person will paste.
 */
export const MAX_ATTACHMENT_BASE64_BYTES = 5_000_000;

/**
 * The cap on one message. Above twenty images a *stricter per-image dimension* limit applies to
 * every image in the request, so staying well under twenty means an oversized paste is quietly
 * downsized — which is the friendly failure — rather than rejected by the provider.
 */
export const MAX_ATTACHMENTS_PER_MESSAGE = 10;

const MEDIA_TYPE_OF_EXTENSION = new Map<string, AttachmentMediaType>(
  Object.entries(ATTACHMENT_MEDIA_TYPES).map(([mediaType, extension]) => [
    extension,
    mediaType as AttachmentMediaType,
  ]),
);

export function isAttachmentMediaType(value: string): value is AttachmentMediaType {
  return value in ATTACHMENT_MEDIA_TYPES;
}

/**
 * The media type an id names, or `undefined` if it names nothing this can serve.
 *
 * Deliberately strict about the whole id and not only its extension: this is also the check that
 * stops `../../token` reaching the filesystem, so a separate traversal guard would be a second
 * rule able to fall out of step with this one.
 */
export function mediaTypeOf(attachmentId: string): AttachmentMediaType | undefined {
  const match = /^[0-9a-f-]{36}\.([a-z]{3,4})$/.exec(attachmentId);
  if (!match?.[1]) return undefined;
  return MEDIA_TYPE_OF_EXTENSION.get(match[1]);
}
