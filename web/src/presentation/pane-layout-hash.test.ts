import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  EMPTY_PANE_LAYOUT,
  formatPaneLayoutHash,
  parsePaneLayoutHash,
  samePaneLayout,
} from "./pane-layout-hash.ts";

describe("deep links to a pane layout", () => {
  it("reads one Agent Session", () => {
    assert.deepEqual(parsePaneLayoutHash("#/s/abc"), {
      mode: "single",
      primary: "abc",
      secondary: undefined,
      focused: "primary",
    });
  });

  it("reads a two-up comparison", () => {
    assert.deepEqual(parsePaneLayoutHash("#/s/abc/split/def"), {
      mode: "split",
      primary: "abc",
      secondary: "def",
      focused: "primary",
    });
  });

  /** The invariant. Two views of one Presentation Transcript is not a comparison. */
  it("refuses to put the same Agent Session in both panes", () => {
    assert.deepEqual(parsePaneLayoutHash("#/s/abc/split/abc"), {
      mode: "single",
      primary: "abc",
      secondary: undefined,
      focused: "primary",
    });
  });

  it("ignores a hash that is not a pane layout", () => {
    for (const hash of ["", "#", "#/", "#/s", "#/s/", "#/nope/abc", "#/s/abc/nope/def"]) {
      const parsed = parsePaneLayoutHash(hash);
      if (hash === "#/s/abc/nope/def") {
        assert.deepEqual(parsed.primary, "abc", hash);
        assert.equal(parsed.mode, "single", hash);
        continue;
      }
      assert.deepEqual(parsed, EMPTY_PANE_LAYOUT, hash);
    }
  });

  it("survives a hand-edited hash with a stray percent", () => {
    assert.deepEqual(parsePaneLayoutHash("#/s/%"), EMPTY_PANE_LAYOUT);
  });

  it("round-trips an id that needs escaping", () => {
    const id = "scope/with a space";
    const hash = formatPaneLayoutHash({
      mode: "single",
      primary: id,
      secondary: undefined,
      focused: "primary",
    });
    assert.equal(hash.includes(" "), false);
    assert.equal(parsePaneLayoutHash(hash).primary, id);
  });

  it("writes nothing when nothing is selected, so the URL stays clean", () => {
    assert.equal(formatPaneLayoutHash(EMPTY_PANE_LAYOUT), "");
  });

  /**
   * The provider writes the hash only when it differs, which is what stops the write and the
   * `hashchange` listener from chasing each other. This is the comparison that decision rests on.
   */
  it("compares layouts by what the URL carries, not by which pane has focus", () => {
    const left = { mode: "split" as const, primary: "a", secondary: "b", focused: "primary" as const };
    assert.equal(samePaneLayout(left, { ...left, focused: "secondary" }), true);
    assert.equal(samePaneLayout(left, { ...left, secondary: "c" }), false);
  });
});
