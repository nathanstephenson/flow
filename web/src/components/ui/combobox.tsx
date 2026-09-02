import { Combobox as BaseCombobox } from "@base-ui/react/combobox";
import { Check, Search } from "lucide-react";
import type { ComponentProps } from "react";

import { cn } from "@/lib/utils.ts";

/**
 * Base UI's Combobox — the component Radix never had, and the reason the model picker needs no
 * `cmdk`, no Popover scaffolding and no hand-rolled filter. Skinned as shadcn's Command-in-a-Popover.
 *
 * Its `Group`/`GroupLabel`/`Collection` parts map one-to-one onto the provider-grouped output of
 * `modelChoices()`, and `Input`/`Empty` give the search that a backend offering hundreds of models
 * needs. `limit` caps the rendered list so a thousand-model provider does not mount a thousand rows.
 */
export const Combobox = BaseCombobox.Root;
export const ComboboxCollection = BaseCombobox.Collection;
export const ComboboxGroup = BaseCombobox.Group;
export const ComboboxValue = BaseCombobox.Value;

export function ComboboxTrigger({ className, ...props }: ComponentProps<typeof BaseCombobox.Trigger>) {
  return (
    <BaseCombobox.Trigger
      className={cn(
        "flex h-8 max-w-56 items-center justify-between gap-2 truncate rounded-md border border-input " +
          "bg-transparent px-3 text-sm whitespace-nowrap shadow-xs transition-[color,box-shadow] outline-none " +
          "hover:bg-accent hover:text-accent-foreground focus-visible:border-ring focus-visible:ring-[3px] " +
          "focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30",
        className,
      )}
      {...props}
    />
  );
}

export function ComboboxPopup({ className, children, ...props }: ComponentProps<typeof BaseCombobox.Popup>) {
  return (
    <BaseCombobox.Portal>
      <BaseCombobox.Positioner sideOffset={4} align="start">
        <BaseCombobox.Popup
          className={cn(
            "z-50 flex max-h-[min(28rem,var(--available-height))] w-72 flex-col overflow-hidden rounded-md " +
              "border bg-popover text-popover-foreground shadow-md outline-none",
            className,
          )}
          {...props}
        >
          {children}
        </BaseCombobox.Popup>
      </BaseCombobox.Positioner>
    </BaseCombobox.Portal>
  );
}

export function ComboboxInput({ className, ...props }: ComponentProps<typeof BaseCombobox.Input>) {
  return (
    <div className="flex items-center gap-2 border-b px-3">
      <Search className="size-4 shrink-0 opacity-50" aria-hidden />
      <BaseCombobox.Input
        className={cn(
          "flex h-9 w-full bg-transparent py-3 text-sm outline-none placeholder:text-muted-foreground " +
            "disabled:cursor-not-allowed disabled:opacity-50",
          className,
        )}
        {...props}
      />
    </div>
  );
}

export function ComboboxList({ className, ...props }: ComponentProps<typeof BaseCombobox.List>) {
  return <BaseCombobox.List className={cn("overflow-x-hidden overflow-y-auto p-1", className)} {...props} />;
}

export function ComboboxItem({ className, children, ...props }: ComponentProps<typeof BaseCombobox.Item>) {
  return (
    <BaseCombobox.Item
      className={cn(
        "relative flex w-full cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm " +
          "outline-hidden select-none data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground",
        className,
      )}
      {...props}
    >
      <BaseCombobox.ItemIndicator className="size-4 shrink-0">
        <Check className="size-4" aria-hidden />
      </BaseCombobox.ItemIndicator>
      <span className="truncate">{children}</span>
    </BaseCombobox.Item>
  );
}

export function ComboboxGroupLabel({ className, ...props }: ComponentProps<typeof BaseCombobox.GroupLabel>) {
  return (
    <BaseCombobox.GroupLabel
      className={cn("px-2 py-1.5 text-xs text-muted-foreground", className)}
      {...props}
    />
  );
}

export function ComboboxEmpty({ className, ...props }: ComponentProps<typeof BaseCombobox.Empty>) {
  return (
    <BaseCombobox.Empty
      className={cn("px-2 py-6 text-center text-sm text-muted-foreground", className)}
      {...props}
    />
  );
}
