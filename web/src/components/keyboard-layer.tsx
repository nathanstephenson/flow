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
 * Handlers are optional. `command-palette` and `keyboard-sheet` resolve today but have nothing to
 * open yet, and the two picker bindings would need the header's popovers to become controlled
 * components; leaving them unhandled is visible here rather than hidden in the table.
 */
export type KeyboardHandlers = Partial<Record<Binding, () => void>>;

export function KeyboardLayer({
  handlers,
  modalOpen,
  children,
}: {
  handlers: KeyboardHandlers;
  modalOpen: boolean;
  children: ReactNode;
}) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null;
      const typing =
        target !== null &&
        isTypingTarget(target.tagName, target.isContentEditable, target.getAttribute("role") ?? undefined);

      const binding = resolveBinding(
        {
          key: event.key,
          ctrlKey: event.ctrlKey,
          metaKey: event.metaKey,
          shiftKey: event.shiftKey,
          repeat: event.repeat,
        },
        { modalOpen, typing },
      );
      if (binding === undefined) return;

      // Escape while typing means "leave this surface", and only the DOM knows what has focus.
      if (binding === "blur-or-abort" && typing) {
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
  }, [handlers, modalOpen]);

  return <>{children}</>;
}
