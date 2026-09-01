import { Menu } from "@base-ui/react/menu";
import type { ComponentProps } from "react";

import { cn } from "@/lib/utils.ts";

/**
 * Base UI's Menu, used for the pane overflow.
 *
 * Items a backend cannot serve are *hidden* rather than disabled, the same rule the Effort control
 * follows: a permanently greyed row teaches nothing except that the UI knows about a feature you
 * cannot have. The Revive lives here and only here — the composer already Revives, and a second
 * affordance for one act is how a confirm dialog gets born (ADR 0003).
 *
 * Triggers take `render={<Button/>}`; Base UI has no `asChild`.
 */
export const DropdownMenu = Menu.Root;
export const DropdownMenuTrigger = Menu.Trigger;
export const DropdownMenuGroup = Menu.Group;

export function DropdownMenuPopup({ className, children, ...props }: ComponentProps<typeof Menu.Popup>) {
  return (
    <Menu.Portal>
      <Menu.Positioner sideOffset={4} align="end">
        <Menu.Popup
          className={cn(
            "min-w-44 rounded-md border border-(--color-line-strong) bg-(--color-overlay) p-1 outline-none",
            className,
          )}
          {...props}
        >
          {children}
        </Menu.Popup>
      </Menu.Positioner>
    </Menu.Portal>
  );
}

export function DropdownMenuItem({ className, ...props }: ComponentProps<typeof Menu.Item>) {
  return (
    <Menu.Item
      className={cn(
        "flex cursor-default items-center gap-2 rounded-sm px-2 py-1 font-sans text-xs text-(--color-fg) " +
          "data-[highlighted]:bg-(--color-surface-2) data-[highlighted]:text-(--color-fg-strong)",
        className,
      )}
      {...props}
    />
  );
}

export function DropdownMenuSeparator({ className, ...props }: ComponentProps<typeof Menu.Separator>) {
  return <Menu.Separator className={cn("my-1 h-px bg-(--color-line)", className)} {...props} />;
}

export function DropdownMenuLabel({ className, ...props }: ComponentProps<typeof Menu.GroupLabel>) {
  return (
    <Menu.GroupLabel
      className={cn("px-2 pt-1.5 pb-1 font-sans text-2xs uppercase tracking-wide text-(--color-fg-faint)", className)}
      {...props}
    />
  );
}
