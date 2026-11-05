import { useEffect, type ReactNode } from "react";

import { isTypingTarget, resolveBinding, type Binding } from "@/presentation/bindings.ts";

/**
 * One `keydown` listener on `window`, asking a pure function what the key meant.
 *
 * Everything DOM-shaped stays here — reading the target, calling `preventDefault`, moving focus —
 * and the table itself lives in `web/src/presentation/bindings.ts`, where `node --test` can hold it
 * to account. `isTypingTarget` is deliberately not the old `event.target === document.body` test,
 * which was too strict in a way that read as flakiness: after clicking any button, focus is on that
 * button, and every shortcut silently stopped working.
 *
 * Handlers are optional: an unhandled binding is not `preventDefault`'d, so the browser keeps the key.
 *
 * `settingsOpen` is passed straight through to the table, which is what decides that `j` addresses
 * nothing while the Settings are open. The alternative — the app shell quietly not passing those
 * handlers — hides the reason in a useMemo instead of stating it where the bindings live.
 */
export type KeyboardHandlers = Partial<Record<Binding, () => void>>;

export function KeyboardLayer({
  handlers,
  settingsOpen,
  children,
}: {
  handlers: KeyboardHandlers;
  settingsOpen: boolean;
  children: ReactNode;
}) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null;
      const typing =
        target !== null &&
        isTypingTarget(
          target.tagName,
          target.isContentEditable,
          target.getAttribute("role") ?? undefined,
          // A Shell takes its keys through a canvas, so the element itself never looks like a typing
          // surface. Asking where it *is* instead is the only honest test.
          target.closest("[data-shell-pane]") !== null,
        );

      /*
       * A handler closer to the element has already dealt with this.
       *
       * CodeMirror calls `preventDefault` when one of its keymaps takes a key, and the composer's
       * `/` menu binds Enter, Tab, the arrows and Escape while it is open. Without this the menu
       * would close on Escape *and* the composer would blur, because this listener is on `window`
       * and sees every key the page did not stop. The alternative was `stopPropagation` at each of
       * those call sites, which is the same rule written once per handler instead of once here.
       */
      if (event.defaultPrevented) return;
      // Escape in a Dialog belongs to that Dialog, even if it closed before this listener ran.
      if (event.key === "Escape" && target?.closest('[role="dialog"]')) return;
      // Native disclosure activation happens after bubbling. Let summary keep
      // Enter instead of treating it as the rail's global "focus pane" shortcut.
      if (event.key === "Enter" && target?.closest("summary")) return;

      const binding = resolveBinding(
        {
          key: event.key,
          ctrlKey: event.ctrlKey,
          metaKey: event.metaKey,
          shiftKey: event.shiftKey,
          repeat: event.repeat,
        },
        { typing, settingsOpen },
      );
      if (binding === undefined) return;

      // Escape while typing means "leave this surface", and only the DOM knows what has focus.
      if (typing && binding === "blur-or-abort") {
        target?.blur();
        event.preventDefault();
        return;
      }

      const handler = handlers[binding];
      if (!handler) return;
      event.preventDefault();
      handler();
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [handlers, settingsOpen]);

  return <>{children}</>;
}
