import { Toast } from "@base-ui/react/toast";

/**
 * Where command errors go. Today they go nowhere: the old client threw them into an unhandled
 * rejection, so a rejected send looked exactly like a slow one.
 *
 * Built on Base UI's Toast rather than on the `sonner` package that shadcn's `sonner` component
 * wraps. The plan's dependency list does not include `sonner`, and @base-ui/react — already the only
 * UI dependency — ships a Toast with a manager that can be created at module scope. That last part
 * is what matters here: the reporter has to be callable from a command dispatcher that is not a
 * component, and a hook cannot be.
 *
 * Bottom right, mono, no icons: a toast in this app is a machine message, not an announcement.
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
          className="mb-1.5 w-72 rounded-md border border-(--color-line-strong) bg-(--color-overlay) p-2"
          style={{
            // A failed command is the case this exists for, so an error toast wears the error hue on
            // its edge rather than on a filled background.
            borderColor: item.type === "error" ? "var(--color-err)" : undefined,
          }}
        >
          <Toast.Title className="font-mono text-xs text-(--color-fg-strong)" />
          <Toast.Description className="mt-0.5 font-mono text-2xs break-words text-(--color-fg-muted)" />
          <Toast.Close
            className="absolute top-1 right-1 px-1 font-mono text-2xs text-(--color-fg-faint) hover:text-(--color-fg)"
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
        <Toast.Viewport className="fixed right-3 bottom-3 z-50 flex w-72 flex-col items-end">
          <ToastList />
        </Toast.Viewport>
      </Toast.Portal>
    </Toast.Provider>
  );
}
