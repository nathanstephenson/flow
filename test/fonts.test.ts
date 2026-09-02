import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_CHROME_FONT, DEFAULT_MONOSPACE_FONT, defaultFonts } from "../src/protocol/fonts.ts";

/**
 * The one copy of the font defaults that cannot import the others.
 *
 * `src/protocol/fonts.ts` is the source: the Session Host reads config.json against it and the web
 * client applies it. `web/src/index.css` has to restate both values, because CSS has no imports and
 * something must paint the first frame before /api/config has answered — so this is the test that
 * stops the stylesheet drifting from the protocol, which would show up only as a flash of the wrong
 * typeface and would never be noticed.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The value of a custom property in the `@theme` block, with line continuations folded out. */
function themeToken(css: string, property: string): string | undefined {
  const match = new RegExp(`^\\s*${property}:\\s*([^;]+);`, "m").exec(css);
  return match?.[1]?.replaceAll(/\s+/g, " ").trim();
}

describe("the font defaults", () => {
  const css = readFileSync(join(root, "web/src/index.css"), "utf8");

  it("are restated identically by the stylesheet", () => {
    assert.equal(
      themeToken(css, "--font-sans"),
      normalise(DEFAULT_CHROME_FONT),
      "web/src/index.css --font-sans has drifted from DEFAULT_CHROME_FONT",
    );
    assert.equal(
      themeToken(css, "--font-mono"),
      normalise(DEFAULT_MONOSPACE_FONT),
      "web/src/index.css --font-mono has drifted from DEFAULT_MONOSPACE_FONT",
    );
  });

  /**
   * The whole point of the defaults, and the reason this is configurable at all: a Powerline prompt
   * draws U+E0B0 and U+E0A0, which no stock system font carries. Ship a stack with no patched font
   * in it and every such prompt renders as tofu out of the box.
   */
  it("name a font that can draw a Powerline prompt, and end in a generic", () => {
    const { monospace, chrome } = defaultFonts();
    assert.match(monospace, /Nerd Font|MesloLGS/, "no patched font named; Powerline prompts tofu");
    assert.match(monospace, /(^|,)\s*monospace\s*$/, "must fall back to the generic");
    assert.match(chrome, /sans-serif\s*$/, "must fall back to the generic");
  });
});

/** Whitespace and nothing else: the stylesheet wraps its long value across two lines. */
function normalise(value: string): string {
  return value.replaceAll(/\s+/g, " ").trim();
}
