import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import type { ComponentProps } from "react";

import { cn } from "@/lib/utils.ts";

/** Base UI's Dialog. One user of it: starting an Agent Session. */
export const Dialog = BaseDialog.Root;
export const DialogTrigger = BaseDialog.Trigger;
export const DialogClose = BaseDialog.Close;

export function DialogPopup({ className, children, ...props }: ComponentProps<typeof BaseDialog.Popup>) {
  return (
    <BaseDialog.Portal>
      <BaseDialog.Backdrop className="fixed inset-0 bg-(--color-bg)/70" />
      <BaseDialog.Popup
        className={cn(
          "fixed top-1/2 left-1/2 w-[min(30rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 " +
            "rounded-md border border-(--color-line-strong) bg-(--color-surface) p-4 outline-none",
          className,
        )}
        {...props}
      >
        {children}
      </BaseDialog.Popup>
    </BaseDialog.Portal>
  );
}

export function DialogTitle({ className, ...props }: ComponentProps<typeof BaseDialog.Title>) {
  return (
    <BaseDialog.Title
      className={cn("font-sans text-sm font-medium text-(--color-fg-strong)", className)}
      {...props}
    />
  );
}

export function DialogDescription({ className, ...props }: ComponentProps<typeof BaseDialog.Description>) {
  return (
    <BaseDialog.Description
      className={cn("mt-1 font-sans text-xs text-(--color-fg-muted)", className)}
      {...props}
    />
  );
}
