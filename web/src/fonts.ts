/**
 * The configured typefaces, applied to the page.
 *
 * Two of them, because they answer different questions. `chrome` dresses the interface — labels,
 * transcript prose, buttons — and `monospace` dresses everything that has to align character by
 * character: the Shell's terminal, and the Scopes, Agent Session ids and token counts the pane
 * prints in mono for exactly that reason.
 *
 * They are written onto the document element rather than into the stylesheet because the stylesheet
 * is built by Vite and the values come from the Session Host at runtime (`fonts` in config.json).
 * The `@theme` block in index.css declares the same two custom properties, so the defaults there are
 * what paints the first frame and these overwrite them once /api/config has answered.
 *
 * Why this is a setting at all: a Powerline or Nerd Font prompt draws its separators from the
 * Private Use Area — U+E0B0, U+E0A0 and friends — which no stock system font carries, so a Shell
 * renders them as tofu until it is told a font that has them. Bundling one was the alternative and
 * it is the worse trade: the right font is the one already on the machine doing the reading.
 */

import { defaultFonts, type Fonts } from "../../src/protocol/fonts.ts";
import { familyDescriptors } from "@/presentation/font-family.ts";

export type { Fonts };

/**
 * What to draw with when the host reported no `fonts`. The same values `@theme` in
 * web/src/index.css restates for the first frame, and test/fonts.test.ts holds the two together.
 */
export const FALLBACK_FONTS: Fonts = defaultFonts();

export function applyFonts(fonts: Fonts | undefined): Fonts {
  const resolved: Fonts = {
    chrome: fonts?.chrome?.trim() || FALLBACK_FONTS.chrome,
    monospace: fonts?.monospace?.trim() || FALLBACK_FONTS.monospace,
  };
  const root = document.documentElement;
  // setProperty rather than a generated stylesheet: the CSSOM validates the value and drops a
  // malformed one, so a bad config line leaves the default standing instead of breaking the page.
  root.style.setProperty("--font-sans", resolved.chrome);
  root.style.setProperty("--font-mono", resolved.monospace);
  return resolved;
}

/**
 * Wait for the configured families to be usable, then report whether any webfont actually loaded.
 *
 * This exists for the Shell. Canvas2D does not participate in font loading — `fillText` with a
 * family the document has not loaded silently paints the fallback — and the terminal measures its
 * cell from the font's metrics, so drawing before the font is ready sizes every cell wrong and does
 * not correct itself. Locally installed families resolve immediately and match nothing here, which
 * is not a failure: `document.fonts.ready` is what the caller is really waiting on.
 */
export async function fontsReady(monospace: string): Promise<void> {
  try {
    // Any single family in the list being unloadable must not sink the others, hence allSettled.
    await Promise.allSettled(
      familyDescriptors(monospace).map((family) => document.fonts.load(`13px ${family}`)),
    );
    await document.fonts.ready;
  } catch {
    // A browser that dislikes one of these descriptors is not a reason to refuse to draw a terminal.
  }
}
