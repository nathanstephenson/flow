/**
 * Which keys the open Enquiry takes from the editor, and what each one means.
 *
 * Pure and DOM-free for the reason `composer-keys.ts` is: these rules were comments before they were
 * a function, and comments are not what catches the bug. It cannot pin precedence on its own —
 * that is CodeMirror's to resolve, and `composer-extensions.test.ts` is what pins it. What this pins
 * is the other half: *given* that the handler runs, exactly which keys it may take.
 *
 * It is harder than `menuAction` in one specific way, and the whole file reduces to the sentence
 * that follows from it. The `/` menu borrows keys a text box never needed — the arrows, Tab, Escape.
 * This borrows **Space and the digits**, which are letters as far as a composer is concerned. So:
 * **the moment the box has a character in it, the Enquiry borrows only the keys a text box never
 * needed.** Every `typing` guard below is that one rule.
 */
export type EnquiryKey = { key: string; shiftKey: boolean };

export type EnquiryAction =
  | "previous"
  | "next"
  /** multiSelect only: add or remove the Option under the cursor. */
  | "toggle"
  /** A digit: address a row by position rather than travelling to it. */
  | "pick"
  /** Take the current selection as the Answer and move on. */
  | "commit"
  /** Go back to the previous Question of this Enquiry. Never a dismissal — there is no dismissing. */
  | "back";

export type EnquiryContext = {
  /** An Enquiry is open. Nothing is borrowed otherwise — the rule `menuAction` opens with. */
  open: boolean;
  /**
   * A composing IME, which here decides *everything* rather than only Enter.
   *
   * This is the sharpest departure from `menuAction`, and it is not a stylistic one: a CJK IME takes
   * Space to accept a candidate and the digits to choose between them, and both are keys this
   * borrows. So while an IME is composing the Enquiry borrows nothing at all, and the list is driven
   * with the arrows once the candidate is committed.
   */
  composing: boolean;
  multiSelect: boolean;
  /** The box has text in it, so Space and the digits go back to being characters. */
  typing: boolean;
  /**
   * The typed answer has a newline in it, so the arrows go back to being caret movement.
   *
   * Someone writing a paragraph has to be able to move around inside it — and someone who has
   * written one is not shopping for an Option anyway. Enter still commits, which is the key that
   * matters by then.
   */
  multiline: boolean;
  /** There is an earlier Question of this Enquiry to go back to. */
  hasPrevious: boolean;
  /** Options plus the Other row, so a digit past the end is handed back rather than swallowed. */
  rows: number;
};

/**
 * What an open Enquiry does with a key, or nothing at all.
 *
 * `undefined` is the important half of the return type, as it is in `menuAction`: it means the editor
 * keeps the key. Every case that returns it is one where taking the key would break something a
 * composer has to go on doing, and they are worth naming rather than falling out of an `if`.
 */
export function enquiryAction(
  { key, shiftKey }: EnquiryKey,
  { open, composing, multiSelect, typing, multiline, hasPrevious, rows }: EnquiryContext,
): { action: EnquiryAction; row?: number } | undefined {
  if (!open || composing) return undefined;

  switch (key) {
    /*
     * Back, and never "dismiss". An Enquiry blocks the turn until it is answered, so a key that
     * closed it would be the lockout leaking — a picker gone from the screen over a turn that is
     * still waiting on it. On the first Question there is nowhere to go back to, so the key is handed
     * back and the global keyboard layer blurs the composer with it, leaving Abort as the one way out
     * of a question nobody wants to answer. Which is what Abort is.
     */
    case "Escape":
      return hasPrevious ? { action: "back" } : undefined;

    case "ArrowUp":
      return multiline ? undefined : { action: "previous" };
    case "ArrowDown":
      return multiline ? undefined : { action: "next" };

    /*
     * Handed back always, for two reasons worth keeping apart. There is nothing to *complete* —
     * completion is the `/` menu's word for putting a name in the box, and an Enquiry has no name to
     * put anywhere. And Shift+Tab moves focus backwards, which matters more here than anywhere else
     * in this composer: it is the only way out of a surface that has taken Enter away.
     */
    case "Tab":
      return undefined;

    /** Shift+Enter is a newline, in the Enquiry as everywhere else. */
    case "Enter":
      return shiftKey ? undefined : { action: "commit" };

    case " ":
      return multiSelect && !typing ? { action: "toggle" } : undefined;

    default: {
      if (typing || !/^[1-9]$/.test(key)) return undefined;
      const row = Number(key) - 1;
      return row < rows ? { action: "pick", row } : undefined;
    }
  }
}
