import { Tooltip as BaseTooltip } from "@base-ui/react/tooltip";
import type { ComponentProps, ReactNode } from "react";

import { cn } from "@/lib/utils.ts";

/**
 * Base UI's Tooltip in shadcn's stock tooltip skin. Not decoration: the pane header is icon-only
 * where it has to be, and an unlabelled icon that aborts a turn is not an affordance, it is a dare.
 */
export const TooltipProvider = BaseTooltip.Provider;

export function Tooltip({
  label,
  children,
  ...props
}: Omit<ComponentProps<typeof BaseTooltip.Root>, "children"> & { label: ReactNode; children: ReactNode }) {
  return (
    <BaseTooltip.Root {...props}>
      <BaseTooltip.Trigger render={<span className="inline-flex" />}>{children}</BaseTooltip.Trigger>
      <BaseTooltip.Portal>
        <BaseTooltip.Positioner sideOffset={6}>
          <BaseTooltip.Popup
            className={cn(
              "z-50 w-fit rounded-md bg-primary px-3 py-1.5 text-xs text-balance text-primary-foreground",
            )}
          >
            {label}
          </BaseTooltip.Popup>
        </BaseTooltip.Positioner>
      </BaseTooltip.Portal>
    </BaseTooltip.Root>
  );
}
