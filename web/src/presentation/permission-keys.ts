/**
 * Which keys the open Permission Prompt takes from the editor, and what each one means.
 *
 * Pure and DOM-free for the reason `enquiry-keys.ts` is, and much shorter for one specific reason:
 * **nothing here is typed.** An Enquiry lets the human write their own answer, and every `typing`
 * guard in that file exists because Space and the digits are letters once the box has a character in
 * it. A Permission Prompt has three fixed choices and no text at all, so the digits are
 * unconditionally the picker's and there is no rule to state about them.
 *
 * What *does* carry over is the IME rule and the Tab rule, and neither is a formality — see below.
 */
export type PermissionKey = { key: string; shiftKey: boolean };

export type PermissionAction =
  | "previous"
  | "next"
  /** A digit: address a choice by position rather than travelling to it. */
  | "pick"
  /** Take the choice under the cursor. */
  | "commit"
  /**
   * Refuse the call.
   *
   * Escape's meaning here, and the one place this differs from an Enquiry's keymap rather than
   * merely being simpler than it. An Enquiry gives Escape "go back a Question" because there is
   * nowhere else to go; a prompt has a real answer that ends it, and refusing is a complete one the
   * model carries on from. It is still not a dismissal: something is decided, and the transcript says
   * what.
   */
  | "deny";

export type PermissionContext = {
  /** A prompt is open. Nothing is borrowed otherwise — the rule the other two keymaps open with. */
  open: boolean;
  /**
   * A composing IME.
   *
   * Kept even though nothing here is typed, and it is not defensive: the composer's editor is a real
   * text box that stays focused and mounted while a prompt is open, so someone mid-composition when
   * the prompt arrives is still composing. A CJK IME takes the digits to choose between candidates,
   * and those are keys this borrows — so while one is composing the prompt borrows nothing, and the
   * cursor is driven with the arrows once the candidate is committed.
   */
  composing: boolean;
  /** How many choices there are, so a digit past the end is handed back rather than swallowed. */
  rows: number;
};

/**
 * What an open Permission Prompt does with a key, or nothing at all.
 *
 * `undefined` means the editor keeps it, which is the important half — see `enquiryAction`.
 *
 * The arrows are taken unconditionally, unlike an Enquiry's, because there is no typed answer to
 * move a caret through: the box is empty for the whole life of a prompt.
 */
export function permissionAction(
  { key, shiftKey }: PermissionKey,
  { open, composing, rows }: PermissionContext,
): { action: PermissionAction; row?: number } | undefined {
  if (!open || composing) return undefined;

  switch (key) {
    case "Escape":
      return { action: "deny" };

    case "ArrowUp":
      return { action: "previous" };
    case "ArrowDown":
      return { action: "next" };

    /*
     * Handed back always, and here it is load-bearing rather than tidy: Shift+Tab moving focus
     * backwards is the only way out of a surface that has taken Enter away, and this surface has
     * taken Enter *and* Escape. It is the one key that must never be borrowed.
     */
    case "Tab":
      return undefined;

    /*
     * Shift+Enter is handed back, as it is everywhere in this composer — but not because it inserts
     * a newline anybody will read. It is so a hand still holding Shift from something else cannot
     * authorise a tool by pressing Enter.
     */
    case "Enter":
      return shiftKey ? undefined : { action: "commit" };

    default: {
      if (!/^[1-9]$/.test(key)) return undefined;
      const row = Number(key) - 1;
      return row < rows ? { action: "pick", row } : undefined;
    }
  }
}
