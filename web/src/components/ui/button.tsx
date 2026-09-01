import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";

import { cn } from "@/lib/utils.ts";

/**
 * shadcn's Button, resized and repainted for an instrument rather than a marketing page.
 *
 * Two departures worth knowing. `size="xs"` exists because shadcn's default `h-9` is a quarter of a
 * 36px pane header; nothing in the chrome is that tall. And `variant="quiet"` is transparent until
 * hover, which is what a row action wants — the Settle on a sidebar row should not compete with the
 * Agent Session's title for attention until you are pointing at it.
 *
 * Rounding stops at 4px and there are no shadows anywhere, per the design system.
 */
const button = cva(
  "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-sm border font-sans " +
    "transition-colors select-none disabled:pointer-events-none disabled:opacity-45",
  {
    variants: {
      variant: {
        default:
          "border-(--color-line) bg-(--color-surface-2) text-(--color-fg-strong) hover:bg-(--color-overlay) hover:border-(--color-line-strong)",
        accent:
          "border-transparent bg-(--color-accent) text-(--color-bg) hover:bg-(--color-accent-strong)",
        // Transparent until hover. Pair it with the `invisible`/`group-hover:visible` trick rather
        // than `display`, so the grid column stays reserved and the title beside it cannot reflow.
        quiet:
          "border-transparent bg-transparent text-(--color-fg-muted) hover:bg-(--color-surface-2) hover:text-(--color-fg-strong)",
        outline:
          "border-(--color-line-strong) bg-transparent text-(--color-fg) hover:bg-(--color-surface-2)",
        danger:
          "border-(--color-err) bg-transparent text-(--color-err) hover:bg-(--color-err)/12",
      },
      size: {
        xs: "h-6 px-2 text-2xs",
        sm: "h-7 px-2.5 text-xs",
        md: "h-8 px-3 text-sm",
        icon: "h-6 w-6 p-0",
      },
    },
    defaultVariants: { variant: "default", size: "sm" },
  },
);

export type ButtonProps = ComponentProps<"button"> & VariantProps<typeof button>;

export function Button({ className, variant, size, type = "button", ...props }: ButtonProps) {
  return <button type={type} className={cn(button({ variant, size }), className)} {...props} />;
}

export { button as buttonVariants };
