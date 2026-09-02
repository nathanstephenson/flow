/**
 * How wide the rail is, as arithmetic.
 *
 * Its own module, DOM-free and under test, because the interesting part of a drag handle is not the
 * pointer events — it is the clamp, and the question of what to do with a stored value written by a
 * different build or edited by hand. Both are easy to get subtly wrong and impossible to notice: a
 * rail that silently pins itself to 0 looks like a rendering bug, not a bad number.
 *
 * Pixels rather than rem. The drag is measured in client coordinates, so px is the unit the input
 * arrives in, and converting to rem would mean reading the root font size to convert back on every
 * pointer move.
 */

/** 16rem at the browser default, which is what `--sidebar-width` was before this was adjustable. */
export const DEFAULT_RAIL_WIDTH = 256;

/**
 * Narrow enough to be a list of status dots and a truncated title; wide enough that a Scope's
 * basename still fits. Below the minimum the rail stops being readable rather than becoming compact,
 * and past the maximum it starts costing the Presentation Transcript the width it exists to show.
 */
export const MIN_RAIL_WIDTH = 180;
export const MAX_RAIL_WIDTH = 520;

export function clampRailWidth(px: number): number {
  // NaN fails both comparisons, so it is caught here rather than propagating into a CSS value.
  if (!Number.isFinite(px)) return DEFAULT_RAIL_WIDTH;
  return Math.round(Math.min(Math.max(px, MIN_RAIL_WIDTH), MAX_RAIL_WIDTH));
}

/**
 * A width read back from storage, or the default if it is not a usable one.
 *
 * Anything unparseable is the default rather than an error: this is a remembered convenience, and
 * the worst outcome of a bad value must be a rail of the ordinary width.
 */
export function parseRailWidth(stored: string | null): number {
  // Blank counts as unstored, and has to be checked before `Number`: `Number("")` is 0, not NaN, so
  // an empty entry would otherwise clamp to the minimum and present as a rail stuck at its narrowest.
  if (stored === null || stored.trim() === "") return DEFAULT_RAIL_WIDTH;
  const parsed = Number(stored);
  return Number.isFinite(parsed) ? clampRailWidth(parsed) : DEFAULT_RAIL_WIDTH;
}

/** As a CSS length, for `--sidebar-width`. */
export function railWidthValue(px: number): string {
  return `${clampRailWidth(px)}px`;
}

/**
 * How far one arrow key moves the handle, and a coarser step when Shift is held.
 *
 * A drag handle that only responds to a pointer is unusable without one, so the splitter takes arrow
 * keys — the WAI-ARIA window-splitter pattern. 16px is about a character of the rail's mono text,
 * which makes a single press visibly do something without being a lurch.
 */
export function railWidthStep(shiftKey: boolean): number {
  return shiftKey ? 64 : 16;
}
