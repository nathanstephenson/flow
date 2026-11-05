import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isTypingTarget, resolveBinding, type BindingContext, type BindingEvent } from "./bindings.ts";

const idle: BindingContext = { typing: false, settingsOpen: false };

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
    assert.equal(resolveBinding(press("`"), idle), "toggle-bottom-dock");
    assert.equal(resolveBinding(press("~"), idle), "toggle-right-dock");
    assert.equal(resolveBinding(press("?", { shiftKey: true }), idle), "keyboard-settings");
    assert.equal(resolveBinding(press("Escape"), idle), "blur-or-abort");
  });

  it("maps ⌘ and Ctrl to the same chords", () => {
    assert.equal(resolveBinding(press("b", { metaKey: true }), idle), "toggle-rail");
    assert.equal(resolveBinding(press("b", { ctrlKey: true }), idle), "toggle-rail");
    assert.equal(resolveBinding(press("f", { metaKey: true }), idle), "search");
    assert.equal(resolveBinding(press("f", { ctrlKey: true }), idle), "search");
  });

  it("leaves the browser's chords alone", () => {
    assert.equal(resolveBinding(press("r", { metaKey: true }), idle), undefined);
    assert.equal(resolveBinding(press("s", { metaKey: true }), idle), undefined);
    assert.equal(resolveBinding(press("k", { metaKey: true }), idle), undefined);
  });

  it("does not fire a shifted letter as its unshifted binding", () => {
    assert.equal(resolveBinding(press("S", { shiftKey: true }), idle), undefined);
    assert.equal(resolveBinding(press("N", { shiftKey: true }), idle), undefined);
  });

  describe("while the reader is typing", () => {
    const typing: BindingContext = { typing: true, settingsOpen: false };

    it("passes every letter through to the Composer", () => {
      assert.equal(resolveBinding(press("s"), typing), undefined);
      assert.equal(resolveBinding(press("n"), typing), undefined);
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
      assert.equal(resolveBinding(press("b", { metaKey: true }), typing), "toggle-rail");
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
      assert.equal(resolveBinding(press("b", { metaKey: true, repeat: true }), idle), undefined);
    });
  });

  it("does not toggle the Shell while the reader is typing a backtick", () => {
    // The one binding most likely to be typed rather than pressed: a backtick opens a code fence in
    // the Composer far more often than it wants a terminal.
    assert.equal(resolveBinding(press("`"), { typing: true, settingsOpen: false }), undefined);
  });

  it("has no binding for Settling, sending a message or Reviving an Agent Session", () => {
    // Deliberately absent: nothing that spends money or sends text is reachable from one key, and
    // ⌘Enter as "send now, interrupting" would be a second Steering Queue in a keybinding (ADR 0002).
    assert.equal(resolveBinding(press("Enter", { metaKey: true }), idle), undefined);
    assert.equal(resolveBinding(press("r"), idle), undefined);
    assert.equal(resolveBinding(press("s"), idle), undefined);
  });
  /**
   * The Settings Dialog covers the rail and the pane, so the keys that address those resolve to
   * nothing while it is open. Escape belongs to the Dialog.
   */
  describe("while the Settings are open", () => {
    const settings: BindingContext = { typing: false, settingsOpen: true };

    it("drops every binding that addresses an Agent Session", () => {
      for (const key of ["j", "k", "ArrowDown", "ArrowUp", "Home", "End", "Enter", "m", "e", "s", "`", "~"]) {
        assert.equal(resolveBinding(press(key), settings), undefined, key);
      }
      assert.equal(resolveBinding(press("b", { metaKey: true }), settings), undefined);
      assert.equal(resolveBinding(press("f", { metaKey: true }), settings), undefined);
    });

    it("keeps n and ?", () => {
      assert.equal(resolveBinding(press("n"), settings), "new-agent-session");
      assert.equal(resolveBinding(press("?", { shiftKey: true }), settings), "keyboard-settings");
    });

    it("leaves Escape to the Dialog", () => {
      assert.equal(resolveBinding(press("Escape"), settings), undefined);
      assert.equal(resolveBinding(press("Escape"), { ...settings, typing: true }), undefined);
    });

    it("still yields the keyboard to a typing surface", () => {
      const typingHere: BindingContext = { ...settings, typing: true };
      assert.equal(resolveBinding(press("n"), typingHere), undefined);
      assert.equal(resolveBinding(press("?", { shiftKey: true }), typingHere), undefined);
    });
  });
});

describe("recognising a typing surface", () => {
  it("recognises the elements a keystroke is text in", () => {
    assert.equal(isTypingTarget("input", false, undefined, false), true);
    assert.equal(isTypingTarget("TEXTAREA", false, undefined, false), true);
    assert.equal(isTypingTarget("select", false, undefined, false), true);
    assert.equal(isTypingTarget("div", true, undefined, false), true);
    assert.equal(isTypingTarget("div", false, "textbox", false), true);
  });

  /**
   * A Shell paints itself on a canvas, so the element focus lands on says nothing about what a
   * keystroke means there. Without this, `n` at a prompt opens the New Agent Session view.
   */
  it("counts a focused Shell, whatever it is drawn on", () => {
    assert.equal(isTypingTarget("canvas", false, undefined, true), true);
    assert.equal(isTypingTarget("div", false, undefined, true), true);
  });

  it("does not mistake a focused button for one", () => {
    // The old client asked whether the target was document.body, so after clicking any button every
    // shortcut silently stopped working until the reader clicked the background.
    assert.equal(isTypingTarget("button", false, undefined, false), false);
    assert.equal(isTypingTarget("div", false, undefined, false), false);
    assert.equal(isTypingTarget("summary", false, "button", false), false);
  });
});
