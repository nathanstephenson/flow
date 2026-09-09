import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { permissionAction, type PermissionContext } from "./permission-keys.ts";

/**
 * Which keys an open Permission Prompt takes from the editor, and — the half that matters — which it
 * hands back.
 *
 * The taking is easy to see on screen. The handing back is not: a key wrongly borrowed shows up as a
 * text box that has stopped accepting a character, or as a focus trap nobody can get out of, and
 * only under an IME or a keyboard nobody testing it uses.
 */

function context(over: Partial<PermissionContext> = {}): PermissionContext {
  return { open: true, composing: false, rows: 3, ...over };
}

const plain = (key: string) => ({ key, shiftKey: false });

describe("the Permission Prompt's keys", () => {
  it("borrows nothing while closed", () => {
    // The rule all three keymaps in this composer open with. Every binding is installed
    // unconditionally, so "closed" is the only thing standing between an open editor and a picker
    // that eats its digits.
    for (const key of ["Escape", "ArrowUp", "ArrowDown", "Enter", "1"]) {
      assert.equal(permissionAction(plain(key), context({ open: false })), undefined, key);
    }
  });

  it("borrows nothing while an IME is composing", () => {
    /*
     * Kept from the Enquiry's keymap even though nothing here is typed, and it is not defensive: the
     * editor is a real text box that stays focused and mounted while a prompt is open, so someone
     * mid-composition when the prompt arrives is still composing. A CJK IME takes the digits to
     * choose between candidates, and those are keys this borrows.
     */
    for (const key of ["1", "2", "3", "Enter", "ArrowDown"]) {
      assert.equal(permissionAction(plain(key), context({ composing: true })), undefined, key);
    }
  });

  it("refuses the call on Escape", () => {
    /*
     * Where this parts company with the Enquiry's keymap rather than merely being simpler than it.
     * An Enquiry gives Escape "go back a Question" because there is nowhere else to go; a prompt has
     * a real answer that ends it, and refusing is a complete one the model carries on from.
     *
     * Still not a dismissal — something is decided, and the transcript says what.
     */
    assert.deepEqual(permissionAction(plain("Escape"), context()), { action: "deny" });
  });

  it("moves the cursor on the arrows, unconditionally", () => {
    // Unlike the Enquiry's, which hands the arrows back once the typed answer has a newline in it.
    // There is no typed answer here, so there is no caret to move through and no exception to make.
    assert.deepEqual(permissionAction(plain("ArrowUp"), context()), { action: "previous" });
    assert.deepEqual(permissionAction(plain("ArrowDown"), context()), { action: "next" });
  });

  it("hands Tab back, always", () => {
    // Load-bearing rather than tidy: Shift+Tab moving focus backwards is the only way out of a
    // surface that has taken Enter away, and this surface has taken Enter *and* Escape.
    assert.equal(permissionAction(plain("Tab"), context()), undefined);
    assert.equal(permissionAction({ key: "Tab", shiftKey: true }, context()), undefined);
  });

  it("decides on Enter, but never on Shift+Enter", () => {
    assert.deepEqual(permissionAction(plain("Enter"), context()), { action: "commit" });
    // Not because a newline is wanted, but so a hand still holding Shift from something else cannot
    // authorise a tool by pressing Enter.
    assert.equal(permissionAction({ key: "Enter", shiftKey: true }, context()), undefined);
  });

  it("addresses a choice by digit", () => {
    // What "numbered picker" means: a row can be taken without being travelled to. Unconditional
    // here, where the Enquiry's version is gated on the box being empty — nothing is typed into
    // this one, so a digit is never a character.
    assert.deepEqual(permissionAction(plain("1"), context()), { action: "pick", row: 0 });
    assert.deepEqual(permissionAction(plain("3"), context()), { action: "pick", row: 2 });
  });

  it("hands back a digit past the last choice", () => {
    // Swallowing it would take a character out of the editor to reach a row that is not there.
    assert.equal(permissionAction(plain("4"), context()), undefined);
    assert.equal(permissionAction(plain("9"), context()), undefined);
  });

  it("never takes 0, which is not a row", () => {
    assert.equal(permissionAction(plain("0"), context()), undefined);
  });

  it("leaves ordinary characters alone", () => {
    for (const key of ["a", " ", "/", "x"]) {
      assert.equal(permissionAction(plain(key), context()), undefined, key);
    }
  });
});
