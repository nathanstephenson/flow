/**
 * Whether the reader is watching the end of the Presentation Transcript.
 *
 * The pin is derived from what the reader did — where they left the scroller — rather than measured
 * before a commit and restored after it. React has no `getSnapshotBeforeUpdate` to hang the old
 * approach on, and the derived version is the better one anyway: a measurement taken before a commit
 * can be invalidated by the very content change that prompted it, while "the reader was at the
 * bottom" stays true regardless of what arrives next.
 *
 * The threshold is 40px and stays 40px — it is tuned, and matching the old feel is the point:
 *
 * - **Fractional pixels.** Under browser zoom `scrollHeight - scrollTop - clientHeight` lands a
 *   fraction above zero at the true bottom. The 40px slack absorbs that. Tightening it towards zero
 *   is the obvious-looking change that unpins a reader who never scrolled.
 * - **Content shrinking.** A search query narrows the visible set wholesale, so the distance from
 *   the bottom jumps without the reader touching anything. Scroll to the bottom when the query
 *   changes rather than trying to interpret the jump.
 * - **Reflow above the tail.** A growing assistant snapshot under `pre-wrap` rewraps lines *above*
 *   the newest one, so the scroll height changes on ticks that appended nothing. That is why the
 *   layout effect re-applies the pin on every tick and not only on append.
 */
export const PIN_THRESHOLD_PX = 40;

/** The three numbers a scroller reports. Taking them as data is what keeps this file DOM-free. */
export type ScrollMetrics = {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
};

export function isPinned(metrics: ScrollMetrics, threshold: number = PIN_THRESHOLD_PX): boolean {
  return metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight < threshold;
}
