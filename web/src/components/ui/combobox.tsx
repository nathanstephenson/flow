import { Combobox as BaseCombobox } from "@base-ui/react/combobox";
import { Check, Search } from "lucide-react";
import type { ComponentProps } from "react";

import { cn } from "@/lib/utils.ts";

/**
 * Base UI's Combobox — the component Radix never had, and the reason the model picker needs no
 * `cmdk`, no Popover scaffolding and no hand-rolled filter.
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
        "inline-flex h-6 max-w-56 items-center gap-1 truncate rounded-sm border border-(--color-line) " +
          "bg-(--color-surface-2) px-1.5 font-mono text-2xs text-(--color-fg-strong) hover:border-(--color-line-strong)",
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
            "flex max-h-[min(28rem,var(--available-height))] w-72 flex-col rounded-md border " +
              "border-(--color-line-strong) bg-(--color-overlay) outline-none",
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
    <div className="flex items-center gap-1.5 border-b border-(--color-line) px-2">
      <Search size={11} className="shrink-0 text-(--color-fg-faint)" aria-hidden />
      <BaseCombobox.Input
        className={cn(
          "h-7 w-full bg-transparent font-mono text-xs text-(--color-fg-strong) outline-none " +
            "placeholder:text-(--color-fg-faint)",
          className,
        )}
        {...props}
      />
    </div>
  );
}

export function ComboboxList({ className, ...props }: ComponentProps<typeof BaseCombobox.List>) {
  return <BaseCombobox.List className={cn("overflow-y-auto p-1", className)} {...props} />;
}

export function ComboboxItem({ className, children, ...props }: ComponentProps<typeof BaseCombobox.Item>) {
  return (
    <BaseCombobox.Item
      className={cn(
        "flex cursor-default items-center gap-2 rounded-sm px-2 py-1 font-mono text-xs text-(--color-fg) " +
          "data-[highlighted]:bg-(--color-surface-2) data-[highlighted]:text-(--color-fg-strong)",
        className,
      )}
      {...props}
    >
      <BaseCombobox.ItemIndicator className="w-3 shrink-0 text-(--color-accent)">
        <Check size={10} aria-hidden />
      </BaseCombobox.ItemIndicator>
      <span className="truncate">{children}</span>
    </BaseCombobox.Item>
  );
}

export function ComboboxGroupLabel({ className, ...props }: ComponentProps<typeof BaseCombobox.GroupLabel>) {
  return (
    <BaseCombobox.GroupLabel
      className={cn("px-2 pt-2 pb-1 font-sans text-2xs uppercase tracking-wide text-(--color-fg-faint)", className)}
      {...props}
    />
  );
}

export function ComboboxEmpty({ className, ...props }: ComponentProps<typeof BaseCombobox.Empty>) {
  return (
    <BaseCombobox.Empty
      className={cn("px-2 py-3 text-center font-sans text-xs text-(--color-fg-muted)", className)}
      {...props}
    />
  );
}
