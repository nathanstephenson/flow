import { Separator as BaseSeparator } from "@base-ui/react/separator";
import type { ComponentProps } from "react";

import { cn } from "@/lib/utils.ts";

/**
 * Base UI's Separator in shadcn's stock separator skin — the same swap tooltip.tsx and input.tsx
 * make, since this app has no Radix.
 *
 * It exists because `SidebarSeparator` in sidebar.tsx is defined upstream as a `Separator` with
 * sidebar tokens, and a drop-in of the upstream file expects to import this name from here.
 */
export function Separator({
  className,
  orientation = "horizontal",
  ...props
}: ComponentProps<typeof BaseSeparator>) {
  return (
    <BaseSeparator
      data-slot="separator"
      orientation={orientation}
      className={cn(
        "shrink-0 bg-border data-[orientation=horizontal]:h-px data-[orientation=horizontal]:w-full " +
          "data-[orientation=vertical]:h-full data-[orientation=vertical]:w-px",
        className,
      )}
      {...props}
    />
  );
}
