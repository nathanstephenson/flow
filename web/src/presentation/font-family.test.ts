import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { familyDescriptors, familyNames } from "./font-family.ts";

import { DEFAULT_MONOSPACE_FONT } from "../../../src/protocol/fonts.ts";

describe("taking a font-family list apart", () => {
  it("splits the default monospace stack", () => {
    assert.deepEqual(familyNames(DEFAULT_MONOSPACE_FONT), [
      "MesloLGS NF",
      "JetBrainsMono Nerd Font",
      "FiraCode Nerd Font",
      "Hack Nerd Font",
      "ui-monospace",
      "SFMono-Regular",
      "Menlo",
      "Consolas",
      "monospace",
    ]);
  });

  it("keeps a comma inside a quoted family name", () => {
    // The reason this is a character loop and not a regex: a naive split on "," yields `"Nerd` and
    // `Font, Bold"`, and the browser is then asked to load two families that do not exist.
    assert.deepEqual(familyNames(`"Comma, Sans", monospace`), ["Comma, Sans", "monospace"]);
  });

  it("handles both quote styles and ignores the other inside them", () => {
    assert.deepEqual(familyNames(`'It"s Mono', "Say 'Hi'", monospace`), [
      `It"s Mono`,
      "Say 'Hi'",
      "monospace",
    ]);
  });

  it("drops empty entries rather than emitting blanks", () => {
    assert.deepEqual(familyNames("Menlo,, ,monospace"), ["Menlo", "monospace"]);
    assert.deepEqual(familyNames(""), []);
    assert.deepEqual(familyNames("   "), []);
  });

  describe("as font shorthand descriptors", () => {
    it("quotes a name with a space, because an unquoted one is a syntax error", () => {
      assert.deepEqual(familyDescriptors("MesloLGS NF, Menlo"), ['"MesloLGS NF"', "Menlo"]);
    });

    it("leaves the generic keywords unquoted", () => {
      // Quoting `monospace` turns the generic that always resolves into a family that never does —
      // and it fails silently, which is the worst way for a terminal font to be wrong.
      assert.deepEqual(familyDescriptors("ui-monospace, monospace, sans-serif"), [
        "ui-monospace",
        "monospace",
        "sans-serif",
      ]);
    });

    it("normalises a single-quoted name to double quotes", () => {
      assert.deepEqual(familyDescriptors("'Hack Nerd Font', monospace"), [
        '"Hack Nerd Font"',
        "monospace",
      ]);
    });

    it("leaves a plain identifier alone", () => {
      assert.deepEqual(familyDescriptors("Menlo, SFMono-Regular"), ["Menlo", "SFMono-Regular"]);
    });
  });
});
