import { AlertDialog as BaseAlertDialog } from "@base-ui/react/alert-dialog";
import type { ComponentProps } from "react";

import { cn } from "@/lib/utils.ts";

/**
 * The app's only confirm, and deliberately so.
 *
 * Settle is a single reversible action and gets no confirm (ADR 0006). Ending an Agent Session is
 * the one act the reversibility argument does not cover: it sets `ended`, and a Revive on an Ended
 * Agent Session is refused outright. So exactly one AlertDialog exists, and if a second one ever
 * appears the question to ask is which invariant it thinks it is protecting.
 */
export const AlertDialog = BaseAlertDialog.Root;
export const AlertDialogTrigger = BaseAlertDialog.Trigger;
export const AlertDialogClose = BaseAlertDialog.Close;

export function AlertDialogPopup({ className, children, ...props }: ComponentProps<typeof BaseAlertDialog.Popup>) {
  return (
    <BaseAlertDialog.Portal>
      <BaseAlertDialog.Backdrop className="fixed inset-0 z-50 bg-background/70" />
      <BaseAlertDialog.Popup
        className={cn(
          "fixed top-1/2 left-1/2 z-50 w-[min(26rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 " +
            "rounded-lg border bg-background p-6 shadow-lg outline-none",
          className,
        )}
        {...props}
      >
        {children}
      </BaseAlertDialog.Popup>
    </BaseAlertDialog.Portal>
  );
}

export function AlertDialogTitle({ className, ...props }: ComponentProps<typeof BaseAlertDialog.Title>) {
  return <BaseAlertDialog.Title className={cn("text-lg leading-none font-semibold", className)} {...props} />;
}

export function AlertDialogDescription({
  className,
  ...props
}: ComponentProps<typeof BaseAlertDialog.Description>) {
  return (
    <BaseAlertDialog.Description className={cn("mt-2 text-sm text-muted-foreground", className)} {...props} />
  );
}
