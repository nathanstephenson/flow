import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";

import {
  composerExtensions,
  hintFor,
  type ComposerExtensionOptions,
  type MenuKeys,
} from "./composer-extensions.ts";

/**
 * The Composer's editor, assembled and inspected without a browser.
 *
 * `EditorState.create` needs no document, no element and no jsdom — it resolves facets and
 * precedence exactly as a real editor does, which is enough to catch a whole class of bug this file
 * has now shipped three times: an extension in the wrong place, passing typecheck, passing the build,
 * passing 684 tests, and found by a person pressing a key.
 *
 * **What this can catch.** Ordering and precedence between extensions, and whether an extension is
 * installed where it was meant to be. That is where all three bugs lived — a menu wired below the
 * keymaps that took its keys, and a placeholder installed both in a compartment and beside it.
 *
 * **What it cannot.** Anything that needs layout, focus, a caret or a real key event: the IME guard,
 * the paste path, the pill's appearance, the height cap. Those still want the harness TODO.md asks
 * for. This is the cheap half, and it is worth having on its own.
 */

const menu = (over: Partial<MenuKeys> = {}): MenuKeys => ({
  active: true,
  move: () => {},
  complete: () => true,
  submit: () => true,
  dismiss: () => {},
  ...over,
});

function options(over: Partial<ComposerExtensionOptions> = {}): ComposerExtensionOptions {
  return {
    placeholder: "Message…",
    disabled: false,
    editable: new Compartment(),
    hint: new Compartment(),
    menu: () => menu(),
    permission: () => ({
      // Closed, as `enquiry` below is, and for the same reason: `permissionAction` returns undefined
      // throughout, so every binding in that group declines and the keys fall through exactly as
      // they did before this group existed.
      context: () => ({ open: false, composing: false, rows: 0 }),
      move: () => {},
      pick: () => {},
      commit: () => {},
      deny: () => {},
    }),
    enquiry: () => ({
      // Closed, which is every existing test's world: `enquiryAction` returns undefined throughout,
      // so every binding above declines and the keys fall through exactly as they did before.
      context: () => ({
        open: false,
        composing: false,
        multiSelect: false,
        typing: false,
        multiline: false,
        hasPrevious: false,
        rows: 0,
      }),
      move: () => {},
      toggle: () => {},
      pick: () => {},
      commit: () => {},
      back: () => {},
    }),
    onSubmit: () => {},
    onChange: () => {},
    onPasteFiles: () => true,
    ...over,
  };
}

const stateFrom = (over: Partial<ComposerExtensionOptions> = {}): EditorState =>
  EditorState.create({ extensions: composerExtensions(options(over)) });

/** Every placeholder installed, by the text it shows. More than one is the bug. */
const placeholdersIn = (state: EditorState): string[] =>
  state
    .facet(EditorView.contentAttributes)
    .flatMap((entry) => ("aria-placeholder" in entry ? [String(entry["aria-placeholder"])] : []));

describe("the Composer's extensions", () => {
  it("assembles without a browser, which is what makes any of this testable", () => {
    assert.equal(stateFrom().doc.toString(), "");
  });

  /*
   * The regression this file exists for.
   *
   * The menu's keys sat below both keymaps, so CodeMirror resolved Enter to "send the message"
   * before the menu ever saw it, the arrows to caret movement, and Escape to simplifying the
   * selection. The menu opened and ignored every key pressed at it.
   *
   * `state.facet(keymap)` returns the groups in the order CodeMirror will consult them, so this is
   * the real resolution order rather than a claim about it.
   */
  it("consults the Permission Prompt's keys, then the Enquiry's, then the menu's, then the editor's own", () => {
    const groups = stateFrom().facet(keymap);

    /*
     * A Permission Prompt outranks an Enquiry, an Enquiry outranks the menu, and all three outrank
     * the editor.
     *
     * Three groups rather than one array with duplicate keys, so the order between them is a fact
     * about facet position that this assertion reads back — rather than a claim about how CodeMirror
     * chains same-key bindings within a single group. No two of the three can be open at once (the
     * CLI is blocked on one callback at a time, and a locked composer opens no menu), so the order
     * is unobservable at runtime; asserting it anyway is what stops the lockout depending on that.
     *
     * Three digits for the prompt against the Enquiry's five, which is the visible difference and
     * the deliberate one: a prompt has exactly three choices, and a fourth binding would take a
     * character out of the editor to reach a row that is not there.
     */
    assert.deepEqual(
      (groups[0] ?? []).map((binding) => binding.key),
      ["Escape", "ArrowUp", "ArrowDown", "Enter", "1", "2", "3"],
      "the Permission Prompt's keymap must be the first group CodeMirror consults",
    );

    assert.deepEqual(
      (groups[1] ?? []).map((binding) => binding.key),
      ["Escape", "ArrowUp", "ArrowDown", "Enter", "Space", "1", "2", "3", "4", "5"],
      "the Enquiry's keymap must be the second",
    );

    assert.deepEqual(
      (groups[2] ?? []).map((binding) => binding.key),
      ["Escape", "ArrowUp", "ArrowDown", "Tab", "Enter"],
      "the menu's keymap must be the third",
    );
  });

  it("still has the editor's own Enter, below the menu's", () => {
    const groups = stateFrom().facet(keymap);
    const rest = groups.slice(3).flat();

    assert.ok(
      rest.some((binding) => binding.key === "Enter"),
      "Enter still sends when the menu declines it",
    );
  });

  /*
   * The other regression. A compartment does not replace an extension sitting beside it, it adds
   * one — so a placeholder in both places drew two sentences over each other. Nothing that varies
   * may be installed outside its compartment.
   */
  it("keeps everything that varies inside a compartment", () => {
    const editable = new Compartment();
    const hint = new Compartment();
    const state = stateFrom({ editable, hint });

    assert.ok(editable.get(state) !== undefined, "editable is in its compartment");
    assert.ok(hint.get(state) !== undefined, "the placeholder is in its compartment");
  });

  /*
   * The exact bug, caught exactly.
   *
   * A placeholder renders `aria-placeholder` onto the content element, so two of them are two
   * entries in this facet — which is what a compartment plus a copy beside it produced, and what a
   * reader saw as "Message… — this Revives the Agent Session" printed over "Message… — Enter queues
   * it after the current turn".
   */
  it("installs exactly one placeholder", () => {
    const placeholders = placeholdersIn(stateFrom({ placeholder: "Message…" }));

    assert.deepEqual(placeholders, ["Message…"]);
  });

  // The status changes what the placeholder says — Reviving, queueing, ended — so it is reconfigured
  // on a live editor rather than baked in. That is the path the duplicate appeared on.
  it("still installs exactly one after the status changes it", () => {
    const hint = new Compartment();
    const state = stateFrom({ hint, placeholder: "first" });

    const after = state.update({ effects: hint.reconfigure(hintFor("second")) }).state;

    assert.deepEqual(placeholdersIn(after), ["second"], "reconfigured, not added to");
  });

  // `focusInPane` looks this up by attribute rather than by tag, because the tag changed once
  // already — from `textarea` to a contenteditable div — and did so silently.
  it("marks the input so focus-pane can find it", () => {
    const attributes = stateFrom().facet(EditorView.contentAttributes);

    assert.ok(attributes.some((entry) => "data-composer-input" in entry));
  });

  it("is read-only and not editable for an Ended Agent Session", () => {
    const ended = stateFrom({ disabled: true });

    assert.equal(ended.facet(EditorState.readOnly), true);
    assert.equal(ended.facet(EditorView.editable), false);
  });
});
