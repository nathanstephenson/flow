import { Menu } from "@base-ui/react/menu";
import type { ComponentProps } from "react";

import { cn } from "@/lib/utils.ts";

/**
 * Base UI's Menu in shadcn's stock dropdown-menu skin, used for the pane overflow.
 *
 * Items a backend cannot serve are *hidden* rather than disabled, the same rule the Effort control
 * follows: a permanently greyed row teaches nothing except that the UI knows about a feature you
 * cannot have. The Revive lives here and only here — the composer already Revives, and a second
 * affordance for one act is how a confirm dialog gets born (ADR 0003).
 *
 * Highlight is `data-[highlighted]` rather than shadcn's `focus:`, because that is the attribute
 * Base UI sets. Triggers take `render={<Button/>}`; Base UI has no `asChild`.
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
            "z-50 min-w-[12rem] overflow-hidden rounded-md border bg-popover p-1 text-popover-foreground " +
              "shadow-md outline-none",
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
        "relative flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-hidden " +
          "select-none data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground " +
          "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      {...props}
    />
  );
}

export function DropdownMenuSeparator({ className, ...props }: ComponentProps<typeof Menu.Separator>) {
  return <Menu.Separator className={cn("-mx-1 my-1 h-px bg-border", className)} {...props} />;
}

export function DropdownMenuLabel({ className, ...props }: ComponentProps<typeof Menu.GroupLabel>) {
  return <Menu.GroupLabel className={cn("px-2 py-1.5 text-sm font-medium", className)} {...props} />;
}
