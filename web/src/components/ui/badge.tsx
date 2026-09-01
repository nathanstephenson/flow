import type { ComponentProps } from "react";

import type { StatusTone } from "@client/status.ts";
import { toneColor } from "@/lib/tone.ts";
import { cn } from "@/lib/utils.ts";

/**
 * shadcn's Badge with its variants replaced wholesale by the status tones, which is the only thing
 * this app labels. Compact, squarish, mono and uppercase-tracked, so a badge reads as a machine
 * value rather than as a pill on a dashboard.
 *
 * A tone paints the text and the border, never a filled background: a solid block of colour in the
 * chrome would out-shout the running indicator, which is the one thing here that must be noticed.
 */
export type BadgeProps = ComponentProps<"span"> & { tone?: StatusTone | undefined };

export function Badge({ tone, className, style, ...props }: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex h-[18px] items-center rounded-sm border px-1.5 font-mono text-2xs uppercase tracking-wide",
        tone === undefined && "border-(--color-line) text-(--color-fg-muted)",
        className,
      )}
      style={tone === undefined ? style : { color: toneColor(tone), borderColor: toneColor(tone), ...style }}
      {...props}
    />
  );
}
