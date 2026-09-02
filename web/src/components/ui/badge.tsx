import type { ComponentProps } from "react";

import type { StatusTone } from "@client/status.ts";
import { toneColor } from "@/lib/tone.ts";
import { cn } from "@/lib/utils.ts";

/**
 * shadcn's Badge, with its variants replaced wholesale by the status tones — which is the only thing
 * this app labels.
 *
 * A tone paints the text and the border, never a filled background: a solid block of colour in the
 * chrome would out-shout the running indicator, which is the one thing here that must be noticed.
 */
export type BadgeProps = ComponentProps<"span"> & { tone?: StatusTone | undefined };

export function Badge({ tone, className, style, ...props }: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-md border " +
          "px-2 py-0.5 text-xs font-medium whitespace-nowrap",
        tone === undefined && "text-muted-foreground",
        className,
      )}
      style={tone === undefined ? style : { color: toneColor(tone), borderColor: toneColor(tone), ...style }}
      {...props}
    />
  );
}
