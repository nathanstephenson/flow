/**
 * Deep links, as string transformations.
 *
 * `#/s/<primary>` and `#/s/<primary>/split/<secondary>`, parsed and formatted by hand. No router: a
 * router costs a second source of truth for a selection the layout reducer already owns, and —
 * decisively — real paths would need the Session Host's SPA fallback to be right about every URL
 * anyone might bookmark, whereas a fragment is never sent to the server at all.
 *
 * It lives here, DOM-free, so `node --test` can hold it to account. Reading `location.hash` and
 * writing it back is the provider's business; deciding what a hash *means* is this file's, and that
 * is the half with the edge cases in it.
 */

export type PaneLayoutMode = "single" | "split";

/** A pane role. An open union on the mode means a future "grid" is an addition, not a rewrite. */
export type PaneRole = "primary" | "secondary";

export type PaneLayoutState = {
  mode: PaneLayoutMode;
  primary: string | undefined;
  secondary: string | undefined;
  /** Which pane a global action means. Only meaningful while `mode` is "split". */
  focused: PaneRole;
};

export const EMPTY_PANE_LAYOUT: PaneLayoutState = {
  mode: "single",
  primary: undefined,
  secondary: undefined,
  focused: "primary",
};

export function parsePaneLayoutHash(hash: string): PaneLayoutState {
  const parts = hash.replace(/^#\/?/, "").split("/").filter((part) => part !== "");
  if (parts[0] !== "s" || parts[1] === undefined) return EMPTY_PANE_LAYOUT;

  const primary = decode(parts[1]);
  if (primary === "") return EMPTY_PANE_LAYOUT;

  if (parts[2] !== "split" || parts[3] === undefined) {
    return { mode: "single", primary, secondary: undefined, focused: "primary" };
  }

  const secondary = decode(parts[3]);
  // The invariant, enforced at the door: one Agent Session may not occupy both panes. A link that
  // names it twice is a link to one pane, not a comparison of a transcript with itself.
  if (secondary === "" || secondary === primary) {
    return { mode: "single", primary, secondary: undefined, focused: "primary" };
  }
  return { mode: "split", primary, secondary, focused: "primary" };
}

export function formatPaneLayoutHash(state: PaneLayoutState): string {
  if (state.primary === undefined) return "";
  const primary = `#/s/${encodeURIComponent(state.primary)}`;
  return state.mode === "split" && state.secondary !== undefined
    ? `${primary}/split/${encodeURIComponent(state.secondary)}`
    : primary;
}

/** Two hashes describe the same layout, or they do not. `focused` is not in the URL. */
export function samePaneLayout(left: PaneLayoutState, right: PaneLayoutState): boolean {
  return left.mode === right.mode && left.primary === right.primary && left.secondary === right.secondary;
}

function decode(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    // A hand-edited hash with a stray `%` is not worth a thrown exception on load.
    return "";
  }
}
