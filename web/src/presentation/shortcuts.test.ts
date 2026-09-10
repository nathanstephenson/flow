import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ALL_BINDINGS, resolveBinding, type Binding, type BindingContext } from "./bindings.ts";
import { displayKey, SHORTCUTS } from "./shortcuts.ts";

/**
 * The Keyboard section of the Settings is prose, and prose about keys goes stale silently: the
 * shortcut stops working, or changes key, and the list keeps advertising it. These are the two
 * assertions that stop that — every documented key really resolves, and every binding is really
 * documented.
 */

const SESSION: BindingContext = { typing: false, view: "session" };
const SETTINGS: BindingContext = { typing: false, view: "settings" };

const documented = SHORTCUTS.flatMap((group) => group.shortcuts);

describe("the documented shortcuts", () => {
  it("each resolve to the binding they claim", () => {
    for (const shortcut of documented) {
      for (const key of shortcut.keys) {
        const event = {
          key,
          ctrlKey: shortcut.chord === true,
          metaKey: false,
          shiftKey: false,
          repeat: false,
        };
        // In one view or the other: most bindings only mean something beside an Agent Session, and
        // `leave-settings` only means something in the Settings.
        const resolved = [SESSION, SETTINGS].map((context) => resolveBinding(event, context));
        assert.ok(
          resolved.includes(shortcut.binding),
          `${key} resolved to ${JSON.stringify(resolved)}, not ${shortcut.binding}`,
        );
      }
    }
  });

  it("cover every binding exactly once", () => {
    const listed = documented.map((shortcut) => shortcut.binding);
    assert.deepEqual(
      [...listed].sort(),
      [...ALL_BINDINGS].sort(),
      "a binding is either undocumented or listed twice",
    );
  });

  it("say something about each one", () => {
    for (const shortcut of documented) {
      assert.ok(shortcut.description.length > 0, `${shortcut.binding} has no description`);
      assert.ok(shortcut.keys.length > 0, `${shortcut.binding} names no key`);
    }
  });
});

describe("printing a key on a cap", () => {
  it("spells the arrows as arrows and leaves everything else alone", () => {
    assert.equal(displayKey("ArrowDown"), "↓");
    assert.equal(displayKey("ArrowUp"), "↑");
    assert.equal(displayKey("Escape"), "Escape");
    assert.equal(displayKey("j"), "j");
    assert.equal(displayKey("`"), "`");
  });
});

/** A named binding that is not in the union would be a typo, so the type is the assertion. */
const _exhaustive: Binding[] = ALL_BINDINGS;
void _exhaustive;
