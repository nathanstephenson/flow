/**
 * One notification per frame, however many events arrive in between.
 *
 * This is the second most important decision in the state layer, after the key index. An initial
 * replay of a long Presentation Transcript arrives as one burst of SSE frames — thousands of events
 * in a few milliseconds — and a store that notified per event would render thousands of times to
 * show one screen. Coalescing turns that into roughly one render, and caps a live stream at the
 * refresh rate rather than at the event rate.
 *
 * `requestAnimationFrame` and `document` are reached through `globalThis` rather than through the
 * DOM lib on purpose: the store is compiled by `tsconfig.presentation.json`, which has no DOM, and
 * that is what keeps the store's tests checkable under the same program as the rest of the
 * presentation logic. It also makes the browser dependency one named seam a test replaces, instead
 * of an ambient global reached for from anywhere in the store.
 */
export type FrameScheduler = (task: () => void) => void;

type FrameHost = {
  requestAnimationFrame?: ((task: () => void) => number) | undefined;
  document?: { hidden?: boolean | undefined } | undefined;
};

export const scheduleFrame: FrameScheduler = (task) => {
  const host = globalThis as FrameHost;
  // A hidden document never paints, so its rAF callbacks are parked until it is shown again: a store
  // batching on rAF in a background tab would hold every event it received and publish none of them,
  // and the reader would return to a transcript minutes behind. A microtask is not frame-paced, but
  // nothing is painting, so there is no frame to pace against.
  if (host.requestAnimationFrame && host.document?.hidden !== true) host.requestAnimationFrame(task);
  else queueMicrotask(task);
};

/** Wraps `flush` so that between now and the next frame it runs at most once. */
export function coalesce(flush: () => void, schedule: FrameScheduler = scheduleFrame): () => void {
  let scheduled = false;
  return () => {
    if (scheduled) return;
    scheduled = true;
    schedule(() => {
      // Cleared before the flush rather than after, so an event that arrives while listeners are
      // still running gets a frame of its own instead of being swallowed.
      scheduled = false;
      flush();
    });
  };
}
