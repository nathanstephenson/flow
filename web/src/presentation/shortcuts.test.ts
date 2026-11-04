import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ALL_BINDINGS, resolveBinding, type Binding, type BindingContext } from "./bindings.ts";
import { menuAction } from "./composer-keys.ts";
import { enquiryAction } from "./enquiry-keys.ts";
import { permissionAction } from "./permission-keys.ts";
import { displayKey, SHORTCUTS, type Shortcut } from "./shortcuts.ts";

/**
 * The Keyboard section of the Settings is prose, and prose about keys goes stale silently: the
 * shortcut stops working, or changes key, and the list keeps advertising it. These are the two
 * assertions that stop that — every documented key really resolves, and every binding is really
 * documented.
 */

const SESSION: BindingContext = { typing: false, settingsOpen: false };

const documented = SHORTCUTS.flatMap((group) => group.shortcuts);

/** What the named Composer keymap does with a key, with every option open so nothing is withheld. */
function composerTakes(shortcut: Shortcut, key: string): boolean {
  const pressed = { key, shiftKey: shortcut.shift === true };
  switch (shortcut.composer) {
    case "menu":
      return menuAction(pressed, { open: true, composing: false }) !== undefined;
    case "permission":
      return permissionAction(pressed, { open: true, composing: false, rows: 3 }) !== undefined;
    case "enquiry":
      return (
        enquiryAction(pressed, {
          open: true,
          composing: false,
          multiSelect: true,
          typing: false,
          multiline: false,
          hasPrevious: true,
          rows: 5,
        }) !== undefined
      );
    default:
      return false;
  }
}

describe("the documented shortcuts", () => {
  it("each resolve to the binding they claim", () => {
    for (const shortcut of documented) {
      if (shortcut.binding === undefined) continue;
      for (const key of shortcut.keys) {
        const event = {
          key,
          ctrlKey: shortcut.chord === true,
          metaKey: false,
          shiftKey: false,
          repeat: false,
        };
        assert.equal(resolveBinding(event, SESSION), shortcut.binding, key);
      }
    }
  });

  it("each Composer row is taken by the keymap it names", () => {
    for (const shortcut of documented) {
      if (shortcut.composer === undefined) continue;
      for (const key of shortcut.keys) {
        assert.ok(composerTakes(shortcut, key), `${shortcut.composer} does not take ${key}`);
      }
    }
  });

  it("do not advertise a Settle key", () => {
    assert.ok(!documented.some((shortcut) => shortcut.keys.includes("s")));
    const s = { key: "s", ctrlKey: false, metaKey: false, shiftKey: false, repeat: false };
    assert.equal(resolveBinding(s, SESSION), undefined);
  });

  it("cover every binding exactly once", () => {
    const listed = documented.flatMap((shortcut) => (shortcut.binding === undefined ? [] : [shortcut.binding]));
    assert.deepEqual(
      [...listed].sort(),
      [...ALL_BINDINGS].sort(),
      "a binding is either undocumented or listed twice",
    );
  });

  it("say something about each one", () => {
    for (const shortcut of documented) {
      assert.ok(shortcut.description.length > 0, `${shortcut.binding} has no description`);
      assert.ok(shortcut.keys.length > 0, `${shortcut.description} names no key`);
    }
  });
});

describe("printing a key on a cap", () => {
  it("spells the arrows as arrows, Space as Space, and leaves everything else alone", () => {
    assert.equal(displayKey("ArrowDown"), "↓");
    assert.equal(displayKey("ArrowUp"), "↑");
    assert.equal(displayKey("Escape"), "Escape");
    assert.equal(displayKey("j"), "j");
    assert.equal(displayKey("`"), "`");
    assert.equal(displayKey(" "), "Space");
  });
});

/** A named binding that is not in the union would be a typo, so the type is the assertion. */
const _exhaustive: Binding[] = ALL_BINDINGS;
void _exhaustive;
