import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isTypingTarget, resolveBinding, type BindingContext, type BindingEvent } from "./bindings.ts";

const idle: BindingContext = { modalOpen: false, typing: false };

function press(key: string, held: Partial<BindingEvent> = {}): BindingEvent {
  return { key, ctrlKey: false, metaKey: false, shiftKey: false, repeat: false, ...held };
}

describe("resolving a keystroke to a binding", () => {
  it("maps the unmodified keys", () => {
    assert.equal(resolveBinding(press("n"), idle), "new-agent-session");
    assert.equal(resolveBinding(press("j"), idle), "sidebar-next");
    assert.equal(resolveBinding(press("k"), idle), "sidebar-previous");
    assert.equal(resolveBinding(press("ArrowDown"), idle), "sidebar-next");
    assert.equal(resolveBinding(press("ArrowUp"), idle), "sidebar-previous");
    assert.equal(resolveBinding(press("Home"), idle), "sidebar-first");
    assert.equal(resolveBinding(press("End"), idle), "sidebar-last");
    assert.equal(resolveBinding(press("Enter"), idle), "focus-pane");
    assert.equal(resolveBinding(press("m"), idle), "model-picker");
    assert.equal(resolveBinding(press("e"), idle), "effort-picker");
    assert.equal(resolveBinding(press("s"), idle), "settle");
    assert.equal(resolveBinding(press("/"), idle), "search");
    assert.equal(resolveBinding(press("?", { shiftKey: true }), idle), "keyboard-sheet");
    assert.equal(resolveBinding(press("Escape"), idle), "blur-or-abort");
  });

  it("maps ⌘ and Ctrl to the same chords", () => {
    assert.equal(resolveBinding(press("k", { metaKey: true }), idle), "command-palette");
    assert.equal(resolveBinding(press("k", { ctrlKey: true }), idle), "command-palette");
  });

  it("leaves the browser's chords alone", () => {
    // ⌘F in particular: find-in-page over the Presentation Transcript is what ADR 0001's record of
    // what a human saw is for.
    assert.equal(resolveBinding(press("f", { metaKey: true }), idle), undefined);
    assert.equal(resolveBinding(press("r", { metaKey: true }), idle), undefined);
    assert.equal(resolveBinding(press("s", { metaKey: true }), idle), undefined);
  });

  it("does not fire a shifted letter as its unshifted binding", () => {
    assert.equal(resolveBinding(press("S", { shiftKey: true }), idle), undefined);
    assert.equal(resolveBinding(press("N", { shiftKey: true }), idle), undefined);
  });

  it("says nothing at all while a modal is open", () => {
    const modal: BindingContext = { modalOpen: true, typing: false };
    // Including Escape: the dialog closes itself, and `s` reaching Settle while someone fills in a
    // New Agent Session dialog would be indefensible.
    assert.equal(resolveBinding(press("Escape"), modal), undefined);
    assert.equal(resolveBinding(press("s"), modal), undefined);
    assert.equal(resolveBinding(press("k", { metaKey: true }), modal), undefined);
  });

  describe("while the reader is typing", () => {
    const typing: BindingContext = { modalOpen: false, typing: true };

    it("passes every letter through to the Composer", () => {
      assert.equal(resolveBinding(press("s"), typing), undefined);
      assert.equal(resolveBinding(press("n"), typing), undefined);
      assert.equal(resolveBinding(press("/"), typing), undefined);
      assert.equal(resolveBinding(press("j"), typing), undefined);
      assert.equal(resolveBinding(press("Enter"), typing), undefined, "Enter in the Composer sends");
      assert.equal(resolveBinding(press("ArrowDown"), typing), undefined, "arrows move the caret");
      assert.equal(resolveBinding(press("Home"), typing), undefined, "Home is start-of-line in the Composer");
      assert.equal(resolveBinding(press("End"), typing), undefined, "End is end-of-line in the Composer");
    });

    it("still resolves Escape, which is how a reader leaves the Composer", () => {
      assert.equal(resolveBinding(press("Escape"), typing), "blur-or-abort");
    });

    it("still resolves the chords, which cannot be typed", () => {
      assert.equal(resolveBinding(press("k", { metaKey: true }), typing), "command-palette");
    });
  });

  describe("auto-repeat", () => {
    it("walks the sidebar, which is what holding the key is for", () => {
      assert.equal(resolveBinding(press("j", { repeat: true }), idle), "sidebar-next");
      assert.equal(resolveBinding(press("ArrowUp", { repeat: true }), idle), "sidebar-previous");
    });

    it("does nothing else, so a held key cannot act twice on an Agent Session", () => {
      assert.equal(resolveBinding(press("s", { repeat: true }), idle), undefined);
      assert.equal(resolveBinding(press("n", { repeat: true }), idle), undefined);
      assert.equal(resolveBinding(press("Enter", { repeat: true }), idle), undefined);
      // Holding Home would only re-arrive at the row it already reached.
      assert.equal(resolveBinding(press("Home", { repeat: true }), idle), undefined);
      assert.equal(resolveBinding(press("k", { metaKey: true, repeat: true }), idle), undefined);
    });
  });

  it("has no binding for sending a message or Reviving an Agent Session", () => {
    // Deliberately absent: nothing that spends money or sends text is reachable from one key, and
    // ⌘Enter as "send now, interrupting" would be a second Steering Queue in a keybinding (ADR 0002).
    assert.equal(resolveBinding(press("Enter", { metaKey: true }), idle), undefined);
    assert.equal(resolveBinding(press("r"), idle), undefined);
  });
});

describe("recognising a typing surface", () => {
  it("recognises the elements a keystroke is text in", () => {
    assert.equal(isTypingTarget("input", false, undefined), true);
    assert.equal(isTypingTarget("TEXTAREA", false, undefined), true);
    assert.equal(isTypingTarget("select", false, undefined), true);
    assert.equal(isTypingTarget("div", true, undefined), true);
    assert.equal(isTypingTarget("div", false, "textbox"), true);
  });

  it("does not mistake a focused button for one", () => {
    // The old client asked whether the target was document.body, so after clicking any button every
    // shortcut silently stopped working until the reader clicked the background.
    assert.equal(isTypingTarget("button", false, undefined), false);
    assert.equal(isTypingTarget("div", false, undefined), false);
    assert.equal(isTypingTarget("summary", false, "button"), false);
  });
});
