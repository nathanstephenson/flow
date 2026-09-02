import { Select as BaseSelect } from "@base-ui/react/select";
import { Check, ChevronsUpDown } from "lucide-react";
import type { ComponentProps } from "react";

import { cn } from "@/lib/utils.ts";

/**
 * Base UI's Select in shadcn's stock select skin. Used for the backend picker, the Effort control
 * and the model picker below the combobox threshold.
 *
 * Kept as a Select rather than promoted to a combobox everywhere because a short fixed list is
 * exactly where a native-feeling select wins: it type-to-filters for free and it is the accessible
 * path we did not have to build. Note Base UI's `value` is scalar unless `multiple` is set, so none
 * of these pass an array.
 *
 * Icons are imported one at a time. A namespace import of lucide-react pulls in the entire set and
 * tree-shakes to nothing.
 */
export const Select = BaseSelect.Root;
export const SelectValue = BaseSelect.Value;
export const SelectGroup = BaseSelect.Group;

export function SelectTrigger({ className, children, ...props }: ComponentProps<typeof BaseSelect.Trigger>) {
  return (
    <BaseSelect.Trigger
      className={cn(
        "flex h-8 w-fit items-center justify-between gap-2 rounded-md border border-input bg-transparent " +
          "px-3 text-sm whitespace-nowrap shadow-xs transition-[color,box-shadow] outline-none " +
          "hover:bg-accent hover:text-accent-foreground focus-visible:border-ring focus-visible:ring-[3px] " +
          "focus-visible:ring-ring/50 data-[popup-open]:border-ring " +
          "disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30",
        className,
      )}
      {...props}
    >
      {children}
      <BaseSelect.Icon className="text-muted-foreground">
        <ChevronsUpDown className="size-4 opacity-50" aria-hidden />
      </BaseSelect.Icon>
    </BaseSelect.Trigger>
  );
}

export function SelectPopup({ className, children, ...props }: ComponentProps<typeof BaseSelect.Popup>) {
  return (
    <BaseSelect.Portal>
      <BaseSelect.Positioner sideOffset={4} align="start" alignItemWithTrigger={false}>
        <BaseSelect.Popup
          className={cn(
            "z-50 max-h-[min(24rem,var(--available-height))] min-w-(--anchor-width) overflow-x-hidden " +
              "overflow-y-auto rounded-md border bg-popover p-1 text-popover-foreground shadow-md outline-none",
            className,
          )}
          {...props}
        >
          {children}
        </BaseSelect.Popup>
      </BaseSelect.Positioner>
    </BaseSelect.Portal>
  );
}

export function SelectItem({ className, children, ...props }: ComponentProps<typeof BaseSelect.Item>) {
  return (
    <BaseSelect.Item
      className={cn(
        "relative flex w-full cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm " +
          "outline-hidden select-none data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground",
        className,
      )}
      {...props}
    >
      <BaseSelect.ItemIndicator className="size-4 shrink-0">
        <Check className="size-4" aria-hidden />
      </BaseSelect.ItemIndicator>
      <BaseSelect.ItemText className="truncate">{children}</BaseSelect.ItemText>
    </BaseSelect.Item>
  );
}

export function SelectGroupLabel({ className, ...props }: ComponentProps<typeof BaseSelect.GroupLabel>) {
  return (
    <BaseSelect.GroupLabel
      className={cn("px-2 py-1.5 text-xs text-muted-foreground", className)}
      {...props}
    />
  );
}
