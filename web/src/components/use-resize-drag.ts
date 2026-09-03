import { useCallback, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

/**
 * The gesture behind every splitter in the app: the rail's, and each Dock's.
 *
 * **The drag does not go through React.** It writes the size straight onto a CSS custom property on
 * an ancestor and commits to state once, on release. Two reasons, and both were visible as lag:
 *
 * - The app shell owns these numbers, so a state update per pointer move re-rendered the rail's rows
 *   or the Presentation Transcript — once per frame, for a value only CSS reads.
 * - Persisting belongs at the end of a gesture, not inside it. `localStorage` is synchronous.
 *
 * This is safe against a re-render mid-drag: React only writes a style property whose value changed
 * between renders, and the committed state does not change until release — so an unrelated render
 * (the Agent Session poll, say) diffs the custom property as unchanged and leaves the live one alone.
 *
 * Drag and click are told apart by distance, not by timing. A time-based test makes a slow, careful
 * drag do the click's job instead of resizing, which is precisely the drag someone makes when they
 * are trying to land on an exact size.
 */
const CLICK_SLOP = 4;

export type ResizeDragOptions = {
  /** Which way the pointer moves the size. `-1` where the handle is on the leading edge. */
  grow: 1 | -1;
  axis: "col" | "row";
  /** The custom property carrying the live size, and the ancestor it is set on. */
  variable: string;
  container: (handle: HTMLElement) => HTMLElement | null;
  /** The committed size this drag starts from. Never re-read mid-gesture. */
  size: number;
  /** Applied to every live value, so the clamp bites during the drag and not only at the end. */
  clamp: (px: number, container: HTMLElement | null) => number;
  onCommit: (px: number) => void;
  /** A press that went nowhere. The rail collapses; a Dock has a minimise button instead. */
  onClick?: () => void;
};

export function useResizeDrag(options: ResizeDragOptions): {
  dragging: boolean;
  onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
} {
  const [dragging, setDragging] = useState(false);
  const travel = useRef(0);
  // Read through a ref so a fresh gesture always sees the current options without rebuilding the
  // handler — and so a re-render mid-drag cannot swap the callbacks out from under one.
  const latest = useRef(options);
  latest.current = options;

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    // Only the primary button, and never a modifier-click a browser has its own use for.
    if (event.button !== 0) return;
    const { grow, axis, variable, container, size, clamp, onCommit, onClick } = latest.current;

    const handle = event.currentTarget;
    const element = container(handle);
    const origin = axis === "col" ? event.clientX : event.clientY;
    let live = size;
    travel.current = 0;
    setDragging(true);
    // Suppresses the width transition and holds one cursor for the length of the gesture; see the
    // `[data-resizing]` rules in web/src/index.css.
    element?.setAttribute("data-resizing", axis);
    // Capture, so the drag keeps following the pointer once it leaves this 16px strip — which it
    // does immediately, because resizing means moving away from the handle.
    handle.setPointerCapture(event.pointerId);
    event.preventDefault();

    const onMove = (move: PointerEvent): void => {
      const position = axis === "col" ? move.clientX : move.clientY;
      travel.current = Math.max(travel.current, Math.abs(position - origin));
      // Always from the size and pointer position this drag *started* at, never from the current
      // ones. Measuring against anything that moves as the region resizes drifts, and re-deriving
      // from the start also means that once the clamp bites, reversing responds the moment the
      // pointer is back in range rather than after it has paid back the overshoot.
      live = clamp(size + grow * (position - origin), element);
      element?.style.setProperty(variable, `${live}px`);
    };

    const onUp = (): void => {
      handle.releasePointerCapture(event.pointerId);
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("pointercancel", onUp);
      element?.removeAttribute("data-resizing");
      setDragging(false);

      // A press that went nowhere was a click on the edge. It may still have nudged the property by
      // a pixel or two, so the starting value goes back first — committing it instead would make
      // every click a tiny resize.
      if (travel.current <= CLICK_SLOP) {
        element?.style.setProperty(variable, `${size}px`);
        onClick?.();
        return;
      }
      onCommit(live);
    };

    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("pointercancel", onUp);
  }, []);

  return { dragging, onPointerDown };
}
