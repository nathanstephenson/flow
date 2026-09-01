import { Select as BaseSelect } from "@base-ui/react/select";
import { Check, ChevronsUpDown } from "lucide-react";
import type { ComponentProps } from "react";

import { cn } from "@/lib/utils.ts";

/**
 * Base UI's Select, styled. Used for the backend picker, the Effort control and the model picker
 * below the combobox threshold.
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
        "inline-flex h-6 items-center gap-1 rounded-sm border border-(--color-line) bg-(--color-surface-2) " +
          "px-1.5 font-mono text-2xs text-(--color-fg-strong) hover:border-(--color-line-strong) " +
          "data-[popup-open]:border-(--color-line-strong)",
        className,
      )}
      {...props}
    >
      {children}
      <BaseSelect.Icon className="text-(--color-fg-faint)">
        <ChevronsUpDown size={10} aria-hidden />
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
            "max-h-[min(24rem,var(--available-height))] min-w-(--anchor-width) overflow-y-auto rounded-md " +
              "border border-(--color-line-strong) bg-(--color-overlay) p-1 outline-none",
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
        "flex cursor-default items-center gap-2 rounded-sm px-2 py-1 font-mono text-xs text-(--color-fg) " +
          "data-[highlighted]:bg-(--color-surface-2) data-[highlighted]:text-(--color-fg-strong)",
        className,
      )}
      {...props}
    >
      <BaseSelect.ItemIndicator className="w-3 shrink-0 text-(--color-accent)">
        <Check size={10} aria-hidden />
      </BaseSelect.ItemIndicator>
      <BaseSelect.ItemText className="truncate">{children}</BaseSelect.ItemText>
    </BaseSelect.Item>
  );
}

export function SelectGroupLabel({ className, ...props }: ComponentProps<typeof BaseSelect.GroupLabel>) {
  return (
    <BaseSelect.GroupLabel
      className={cn("px-2 pt-2 pb-1 font-sans text-2xs uppercase tracking-wide text-(--color-fg-faint)", className)}
      {...props}
    />
  );
}
