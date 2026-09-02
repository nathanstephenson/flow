import { Toast } from "@base-ui/react/toast";

/**
 * Where command errors go. Before this they went nowhere: the old client threw them into an
 * unhandled rejection, so a rejected send looked exactly like a slow one.
 *
 * Built on Base UI's Toast rather than on the `sonner` package that shadcn's `sonner` component
 * wraps. The plan's dependency list does not include `sonner`, and @base-ui/react — already the only
 * UI dependency — ships a Toast with a manager that can be created at module scope. That last part
 * is what matters here: the reporter has to be callable from a command dispatcher that is not a
 * component, and a hook cannot be.
 *
 * Bottom right, no icons: a toast in this app is a machine message, not an announcement.
 */
export const toastManager = Toast.createToastManager();

export const toast = {
  error(title: string, description?: string): void {
    toastManager.add({ title, ...(description === undefined ? {} : { description }), type: "error", timeout: 8000 });
  },
  info(title: string, description?: string): void {
    toastManager.add({ title, ...(description === undefined ? {} : { description }), type: "info" });
  },
};

function ToastList() {
  const { toasts } = Toast.useToastManager();
  return (
    <>
      {toasts.map((item) => (
        <Toast.Root
          key={item.id}
          toast={item}
          className="relative mb-2 w-72 rounded-md border bg-popover p-4 text-popover-foreground shadow-lg"
          style={{
            // A failed command is the case this exists for, so an error toast wears the error hue on
            // its edge rather than on a filled background.
            borderColor: item.type === "error" ? "var(--destructive)" : undefined,
          }}
        >
          <Toast.Title className="text-sm font-medium" />
          <Toast.Description className="mt-1 text-sm break-words text-muted-foreground" />
          <Toast.Close
            className="absolute top-2 right-2 px-1 text-sm text-muted-foreground hover:text-foreground"
            aria-label="Dismiss"
          >
            ×
          </Toast.Close>
        </Toast.Root>
      ))}
    </>
  );
}

export function Toaster() {
  return (
    <Toast.Provider toastManager={toastManager}>
      <Toast.Portal>
        <Toast.Viewport className="fixed right-4 bottom-4 z-50 flex w-72 flex-col items-end">
          <ToastList />
        </Toast.Viewport>
      </Toast.Portal>
    </Toast.Provider>
  );
}
