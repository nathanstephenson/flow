import { X } from "lucide-react";

import type { PendingAttachment } from "@/presentation/drafts.ts";
import { Button } from "@/components/ui/button.tsx";
import { cn } from "@/lib/utils.ts";

/**
 * The Attachments a message will carry, above the box rather than below it.
 *
 * Above, because everything below the input describes the *next turn* — which model, how hard, how
 * much room is left — while these are the message itself. Putting them in the `TurnStrip` would file
 * content among readings.
 *
 * Deliberately small. A thumbnail here answers "did the right thing land?" and nothing else; the
 * transcript is where the image is shown at a size worth looking at.
 *
 * Its own file because both composers render one — the Composer in an Agent Session and the New
 * Agent Session view — and it holds no state of either, only the list it is handed.
 */
export function AttachmentTray({
  attachments,
  onRemove,
}: {
  attachments: PendingAttachment[];
  onRemove: (key: string) => void;
}) {
  return (
    <div className="flex flex-wrap gap-2 px-3 pt-3">
      {attachments.map((attachment) => (
        <div key={attachment.key} className="group relative">
          <img
            src={attachment.url}
            alt=""
            className="size-14 rounded-md border border-border object-cover"
          />
          <Button
            variant="secondary"
            size="icon"
            aria-label="Remove this attachment"
            onClick={() => onRemove(attachment.key)}
            className={cn(
              "absolute -top-1.5 -right-1.5 size-5 rounded-full shadow",
              // Shown on hover and on focus — keyboard-only removal must not depend on a pointer
              // ever being over the thumbnail.
              "opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100",
            )}
          >
            <X className="size-3" aria-hidden />
          </Button>
        </div>
      ))}
    </div>
  );
}
