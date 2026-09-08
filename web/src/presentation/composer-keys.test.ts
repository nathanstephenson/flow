import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { highlightAfter, menuAction, type MenuAction } from "./composer-keys.ts";

const pressed = (
  key: string,
  { shift = false, open = true, composing = false } = {},
): MenuAction | undefined => menuAction({ key, shiftKey: shift }, { open, composing });

describe("the keys an open menu takes", () => {
  it("drives the list with the arrows and closes on Escape", () => {
    assert.equal(pressed("ArrowDown"), "next");
    assert.equal(pressed("ArrowUp"), "previous");
    assert.equal(pressed("Escape"), "dismiss");
  });

  // The two that pick, and the whole reason there are two of them.
  it("completes on Tab and sends on Enter", () => {
    assert.equal(pressed("Tab"), "complete");
    assert.equal(pressed("Enter"), "submit");
  });
});

describe("the keys an open menu must hand back", () => {
  it("takes nothing at all while it is closed", () => {
    for (const key of ["Enter", "Tab", "Escape", "ArrowUp", "ArrowDown"]) {
      assert.equal(pressed(key, { open: false }), undefined, key);
    }
  });

  /*
   * A real bug in the textarea this replaced, not a theoretical one: committing a CJK candidate
   * with Enter also sent the message. The guard had to be re-earned when the box became a
   * CodeMirror editor, and this is what keeps it earned.
   */
  it("leaves Enter to a composing IME", () => {
    assert.equal(pressed("Enter", { composing: true }), undefined);
  });

  it("leaves Shift+Enter as a newline", () => {
    assert.equal(pressed("Enter", { shift: true }), undefined);
  });

  // Tab is worth taking because a Skill's arguments need the name settled first. Tabbing *out* is
  // not, and someone who opened the menu by accident still has to be able to leave.
  it("leaves Shift+Tab to move focus backwards", () => {
    assert.equal(pressed("Tab", { shift: true }), undefined);
  });

  it("leaves every ordinary key alone", () => {
    for (const key of ["a", "/", " ", "Backspace", "Home", "ArrowLeft", "PageDown"]) {
      assert.equal(pressed(key), undefined, key);
    }
  });
});

describe("moving the highlight", () => {
  it("wraps at both ends, so the list is a ring", () => {
    assert.equal(highlightAfter(0, 1, 3), 1);
    assert.equal(highlightAfter(2, 1, 3), 0);
    assert.equal(highlightAfter(0, -1, 3), 2);
  });

  // The menu opens on the slash rather than on having something to show, so an empty list is a
  // state it is really in — and the obvious modulo is NaN there.
  it("stays put on an empty list rather than going NaN", () => {
    assert.equal(highlightAfter(0, 1, 0), 0);
    assert.equal(highlightAfter(0, -1, 0), 0);
  });
});
