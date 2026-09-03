import { useEffect, type ReactNode } from "react";

import { isTypingTarget, resolveBinding, type Binding } from "@/presentation/bindings.ts";
import type { Route } from "@/presentation/route.ts";

/**
 * One `keydown` listener on `window`, asking a pure function what the key meant.
 *
 * Everything DOM-shaped stays here — reading the target, calling `preventDefault`, moving focus —
 * and the table itself lives in `web/src/presentation/bindings.ts`, where `node --test` can hold it
 * to account. `isTypingTarget` is deliberately not the old `event.target === document.body` test,
 * which was too strict in a way that read as flakiness: after clicking any button, focus is on that
 * button, and every shortcut silently stopped working.
 *
 * Handlers are optional. `command-palette` resolves today but has nothing to open yet, and the two
 * picker bindings would need the header's popovers to become controlled components; leaving them
 * unhandled is visible here rather than hidden in the table.
 *
 * `view` is passed straight through to the table, which is what decides that `j` addresses nothing
 * while the Settings are on screen. The alternative — the app shell quietly not passing those
 * handlers — hides the reason in a useMemo instead of stating it where the bindings live.
 */
export type KeyboardHandlers = Partial<Record<Binding, () => void>>;

export function KeyboardLayer({
  handlers,
  modalOpen,
  view,
  children,
}: {
  handlers: KeyboardHandlers;
  modalOpen: boolean;
  view: Route["view"];
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

      const binding = resolveBinding(
        {
          key: event.key,
          ctrlKey: event.ctrlKey,
          metaKey: event.metaKey,
          shiftKey: event.shiftKey,
          repeat: event.repeat,
        },
        { modalOpen, typing, view },
      );
      if (binding === undefined) return;

      // Escape while typing means "leave this surface", and only the DOM knows what has focus. Both
      // of Escape's meanings are caught, so a first Escape in a Settings field blurs it rather than
      // leaving the page out from under a half-typed value.
      if (typing && (binding === "blur-or-abort" || binding === "leave-settings")) {
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
  }, [handlers, modalOpen, view]);

  return <>{children}</>;
}
