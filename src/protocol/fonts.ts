/**
 * The two typefaces the clients draw with, and their defaults.
 *
 * In the protocol rather than beside either end because both ends need the same answer: the Session
 * Host parses `fonts` out of config.json and reports it on /api/config, and the web client applies
 * it. Defaults declared once here, so a change cannot be half-made.
 *
 * The stylesheet is the one place that cannot import this — CSS has no imports — so
 * `web/src/index.css` restates both values and `test/fonts.test.ts` holds the two to each other.
 */

export type Fonts = {
  /** The interface: labels, transcript prose, buttons. */
  chrome: string;
  /** The Shell's terminal, and the chrome that must align character by character — Scopes, ids, counts. */
  monospace: string;
};

export const DEFAULT_CHROME_FONT = "'Inter Variable', sans-serif";

/**
 * Nerd Font families first, then the stock stacks.
 *
 * A Powerline or Nerd Font prompt draws its separators from the Private Use Area — U+E0B0 for the
 * arrow, U+E0A0 for the branch — and no stock system font carries those codepoints, so a terminal
 * set to one renders them as tofu. Naming the patched fonts costs nothing when they are absent,
 * because a browser skips a family it cannot resolve, and when one is present the Shell draws the
 * prompt as its owner's real terminal does. These four are what the Powerlevel10k and Starship
 * installers put on disk, which is why they are the ones named.
 */
export const DEFAULT_MONOSPACE_FONT =
  "'MesloLGS NF', 'JetBrainsMono Nerd Font', 'FiraCode Nerd Font', 'Hack Nerd Font', " +
  "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

export function defaultFonts(): Fonts {
  return { chrome: DEFAULT_CHROME_FONT, monospace: DEFAULT_MONOSPACE_FONT };
}
