/**
 * Taking a CSS font-family list apart.
 *
 * Here rather than beside the code that uses it because it is a string rule with an awkward edge —
 * a quoted family name may contain a comma — and this program has no DOM, so `node --test` can hold
 * it to account. Its one caller loads each family through `document.fonts` before the Shell's
 * terminal measures its cell, and a splitter that produced `"Comma` and `Sans"` would ask the
 * browser to load two families that do not exist and quietly fall back to tofu.
 */

/** Every family in the list, in order, unquoted and trimmed. */
export function familyNames(list: string): string[] {
  return splitTopLevel(list)
    .map((family) => unquote(family.trim()))
    .filter((family) => family.length > 0);
}

/**
 * The families as CSS still spells them — quotes intact, ready to interpolate into a font shorthand.
 *
 * `document.fonts.load` takes a font shorthand, so a family whose name has a space must arrive
 * quoted or the descriptor is a syntax error and the load throws.
 */
export function familyDescriptors(list: string): string[] {
  return splitTopLevel(list)
    .map((family) => family.trim())
    .filter((family) => family.length > 0)
    .map((family) => (needsQuoting(family) ? `"${unquote(family)}"` : family));
}

/** Split on commas that are not inside quotes. */
function splitTopLevel(list: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: string | undefined;

  for (const character of list) {
    if (quote) {
      if (character === quote) quote = undefined;
      current += character;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      current += character;
      continue;
    }
    if (character === ",") {
      parts.push(current);
      current = "";
      continue;
    }
    current += character;
  }
  parts.push(current);
  return parts;
}

function unquote(family: string): string {
  const quoted = /^(['"])(.*)\1$/.exec(family);
  return quoted?.[2] ?? family;
}

/**
 * Whether a bare family name has to be quoted to be a legal shorthand.
 *
 * Already-quoted names and the CSS generic keywords are left exactly as they are: quoting
 * `monospace` would turn the generic that always resolves into a family name that never does, which
 * is the one mistake here that produces no error and no glyphs.
 */
function needsQuoting(family: string): boolean {
  if (/^['"]/.test(family)) return true;
  if (GENERICS.has(family.toLowerCase())) return false;
  return !/^[A-Za-z_-][\w-]*$/.test(family);
}

const GENERICS = new Set([
  "serif",
  "sans-serif",
  "monospace",
  "cursive",
  "fantasy",
  "system-ui",
  "ui-serif",
  "ui-sans-serif",
  "ui-monospace",
  "ui-rounded",
  "math",
  "emoji",
  "fangsong",
  "inherit",
  "initial",
  "revert",
  "revert-layer",
  "unset",
]);
