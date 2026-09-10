import { refusalMessage, refusalsIn, sortPastedItems } from "@/presentation/attachments.ts";
import type { PendingAttachment } from "@/presentation/drafts.ts";
import { toast } from "@/components/ui/toaster.tsx";

/**
 * Turning a paste into Attachments: the caps, the toasts, and reading the bytes.
 *
 * Split out of the Composer because two composers now do this — one in an Agent Session and one on
 * the New Agent Session view — and the alternative was a second copy of `base64Of`, which has a
 * stack-overflow trap in it (see below) that nobody should have to rediscover.
 *
 * **The policy of whether an image may be pasted at all stays with the caller.** That is not an
 * oversight: the two disagree. A Composer knows the model in force and treats an unknown one as a
 * model that cannot be shown an image (ADR 0014), while the New Agent Session view chooses the model
 * itself and so always knows. Folding that decision in here would mean a flag, and the flag would be
 * the thing under discussion rather than the answer to it.
 */
export async function attachPasted(
  files: File[],
  alreadyPending: number,
): Promise<PendingAttachment[]> {
  const verdicts = sortPastedItems(
    files.map((file) => ({ type: file.type, size: file.size, file })),
    alreadyPending,
  );
  for (const refusal of refusalsIn(verdicts)) toast.error(refusalMessage(refusal));

  return await Promise.all(
    verdicts
      .filter((verdict) => verdict.accepted)
      .map(async (verdict) => ({
        key: crypto.randomUUID(),
        mediaType: verdict.mediaType,
        data: await base64Of(verdict.item.file),
        url: URL.createObjectURL(verdict.item.file),
      })),
  );
}

/**
 * A `File` as base64, without the data-URL prefix.
 *
 * Through FileReader rather than `btoa` over the bytes: the `String.fromCharCode(...bytes)` spread
 * that makes `btoa` usable on an ArrayBuffer overflows the call stack somewhere in the low hundreds
 * of kilobytes, which every screenshot clears.
 */
function base64Of(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error(`Could not read ${file.type}`));
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      resolve(result.slice(result.indexOf(",") + 1));
    };
    reader.readAsDataURL(file);
  });
}
