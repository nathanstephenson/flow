/**
 * A dropdown trigger that reads as text until you touch it.
 *
 * The composer's bottom strip carries three of these — the model, the Effort level and the branch —
 * and they have to look like one row of readings rather than three pills. So they keep their
 * chevrons, which is what says they open, and drop everything else: no border, no surface, no fixed
 * height. Hover moves the *text* and nothing else.
 *
 * **Two of these overrides look redundant and are not.** `cn` is tailwind-merge, and it only dedupes
 * classes sharing a variant — so plain `bg-transparent` does not displace a base trigger's
 * `hover:bg-input` (or a ghost Button's `hover:bg-accent`), and plain `h-auto` does not displace
 * `data-[size=default]:h-8`. Each has to be cancelled inside its own variant or the base wins, which
 * is exactly how the branch control spent two revisions as a 32px pill that filled in on hover.
 * Verified against `twMerge`, not inferred.
 *
 * Focus is deliberately untouched. `focus-visible:ring-3` survives from the base, because a
 * text-only hover is fine for a mouse but removing the focus ring as well would leave a keyboard
 * user with nothing to follow. It only paints on `:focus-visible`, so it never shows on click.
 */
export const QUIET_TRIGGER = [
  "gap-1 border-0 px-1 py-0 text-xs shadow-none",
  "h-auto data-[size=default]:h-auto data-[size=sm]:h-auto",
  "bg-transparent hover:bg-transparent",
  // The icons come with the text: several of these primitives pin their chevron to
  // `text-muted-foreground`, so it would otherwise stay behind while the label brightened.
  "text-muted-foreground hover:text-foreground hover:[&_svg]:text-foreground",
].join(" ");
