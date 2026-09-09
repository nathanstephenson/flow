import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { enquiryAction, type EnquiryContext } from "./enquiry-keys.ts";

/**
 * Mirrors `composer-keys.test.ts`'s two halves — the keys it takes, and the keys it must hand back —
 * because the second half is where the bugs are. A key wrongly taken from a composer is a character
 * someone typed that never appeared.
 */

const open = (over: Partial<EnquiryContext> = {}): EnquiryContext => ({
  open: true,
  composing: false,
  multiSelect: false,
  typing: false,
  multiline: false,
  hasPrevious: false,
  rows: 3,
  ...over,
});

const press = (key: string, context: EnquiryContext, shiftKey = false) =>
  enquiryAction({ key, shiftKey }, context);

describe("the keys an open Enquiry takes", () => {
  it("drives the cursor with the arrows and answers with Enter", () => {
    assert.deepEqual(press("ArrowUp", open()), { action: "previous" });
    assert.deepEqual(press("ArrowDown", open()), { action: "next" });
    assert.deepEqual(press("Enter", open()), { action: "commit" });
  });

  it("goes back a Question with Escape, and never dismisses", () => {
    assert.deepEqual(press("Escape", open({ hasPrevious: true })), { action: "back" });
    // On the first Question there is nowhere to go, so the key is handed back and the global layer
    // blurs the composer with it. An Enquiry blocks the turn; a key that closed it would be the
    // lockout leaking, so "dismiss" is not in the vocabulary at all.
    assert.equal(press("Escape", open({ hasPrevious: false })), undefined);
  });

  it("toggles with Space, but only under multiSelect", () => {
    assert.deepEqual(press(" ", open({ multiSelect: true })), { action: "toggle" });
    assert.equal(press(" ", open({ multiSelect: false })), undefined, "a space is a space otherwise");
  });

  it("addresses a row by its number", () => {
    assert.deepEqual(press("1", open()), { action: "pick", row: 0 });
    assert.deepEqual(press("3", open()), { action: "pick", row: 2 });
    // Past the end is handed back rather than swallowed: a digit that picks nothing should still be
    // a digit, or typing "4" into an answer would silently do nothing at all.
    assert.equal(press("4", open({ rows: 3 })), undefined);
  });
});

describe("the keys it must hand back", () => {
  it("borrows nothing at all while an IME composes", () => {
    /*
     * The sharpest case, and the reason `composing` gates the whole function rather than only Enter
     * as it does in `menuAction`. A CJK IME takes Space to accept a candidate and the digits to
     * choose between them — and both are keys this borrows. Taking them mid-candidate would make the
     * composer unusable in Japanese for the length of a question.
     */
    const composing = open({ composing: true, multiSelect: true });
    for (const key of ["Enter", " ", "1", "ArrowUp", "ArrowDown", "Escape"]) {
      assert.equal(press(key, composing), undefined, `${key} belongs to the IME`);
    }
  });

  it("gives Space and the digits back the moment the box has text in it", () => {
    // The sentence the whole file reduces to: once there is something typed, the Enquiry borrows
    // only the keys a text box never needed.
    const typing = open({ typing: true, multiSelect: true });
    assert.equal(press(" ", typing), undefined);
    assert.equal(press("1", typing), undefined);
    // The arrows and Enter are still not characters, so they stay borrowed.
    assert.deepEqual(press("ArrowDown", typing), { action: "next" });
    assert.deepEqual(press("Enter", typing), { action: "commit" });
  });

  it("gives the arrows back once the typed answer is a paragraph", () => {
    const paragraph = open({ typing: true, multiline: true });
    assert.equal(press("ArrowUp", paragraph), undefined, "someone must be able to move inside it");
    assert.equal(press("ArrowDown", paragraph), undefined);
    assert.deepEqual(press("Enter", paragraph), { action: "commit" }, "Enter still answers");
  });

  it("never takes Tab, in either direction", () => {
    // Nothing to complete — that is the menu's word — and Shift+Tab is the only way out of a surface
    // that has taken Enter away.
    assert.equal(press("Tab", open()), undefined);
    assert.equal(press("Tab", open(), true), undefined);
  });

  it("leaves Shift+Enter as a newline", () => {
    assert.equal(press("Enter", open(), true), undefined);
  });

  it("borrows nothing while closed", () => {
    const closed = open({ open: false, multiSelect: true, hasPrevious: true });
    for (const key of ["Enter", " ", "1", "ArrowUp", "Escape", "Tab"]) {
      assert.equal(press(key, closed), undefined);
    }
  });
});
