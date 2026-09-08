/**
 * Which keys the open `/` menu takes from the editor, and what each one means.
 *
 * Pure and DOM-free so these rules are unit-tested rather than typed at. Every one of them was a
 * comment in `ComposerInput` before it was a function, and comments are not what caught the bug that
 * made this file exist: the menu was wired below CodeMirror's own keymaps, so Enter sent the message
 * instead of picking, the arrows moved the caret, and Escape simplified the selection. The menu
 * opened and ignored every key pressed at it.
 *
 * This cannot catch that on its own — precedence is CodeMirror's to resolve, and
 * `composer-extensions.test.ts` is what pins it. What this pins is the other half: *given* that the
 * handler runs, exactly which keys it may take and which it must hand straight back.
 */
export type ComposerKey = { key: string; shiftKey: boolean };

export type MenuAction =
  /** Close the menu, leaving the text alone. */
  | "dismiss"
  | "previous"
  | "next"
  /** Put the highlighted name in the box and leave the caret after it. */
  | "complete"
  /** Take the highlighted name as the whole message and send it. */
  | "submit";

/**
 * What an open menu does with a key, or nothing at all.
 *
 * `undefined` is the important half of this return type: it means the editor keeps the key, and
 * every case that returns it is a case where taking the key would break something a composer has to
 * go on doing. They are worth naming rather than falling out of an `if`:
 *
 * - **The menu is closed.** Nothing is borrowed when there is nothing to drive.
 * - **A composing IME owns Enter.** Committing a CJK candidate must not send the message. This was
 *   a real bug in the textarea this replaced, and re-earning it is why it is tested here.
 * - **Shift+Enter is a newline**, in the menu as everywhere else.
 * - **Shift+Tab moves focus backwards.** Tab is worth taking because a Skill's arguments need the
 *   name settled first; tabbing *out* of the composer is not, and someone who has opened a menu by
 *   accident should still be able to leave.
 */
export function menuAction(
  { key, shiftKey }: ComposerKey,
  { open, composing }: { open: boolean; composing: boolean },
): MenuAction | undefined {
  if (!open) return undefined;

  switch (key) {
    case "Escape":
      return "dismiss";
    case "ArrowUp":
      return "previous";
    case "ArrowDown":
      return "next";
    case "Tab":
      return shiftKey ? undefined : "complete";
    case "Enter":
      return shiftKey || composing ? undefined : "submit";
    default:
      return undefined;
  }
}

/**
 * Where the highlight lands after moving by `delta`, wrapping at both ends.
 *
 * Guarded against an empty list, which is a state the menu can legitimately be in — it opens on the
 * slash rather than on having something to show — and where the obvious modulo is `NaN`.
 */
export function highlightAfter(current: number, delta: number, count: number): number {
  if (count <= 0) return 0;
  return (((current + delta) % count) + count) % count;
}
