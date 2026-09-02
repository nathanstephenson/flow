import { useCallback, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

import { clampRailWidth, MAX_RAIL_WIDTH, MIN_RAIL_WIDTH } from "@/presentation/rail-width.ts";
import { useSidebar } from "@/components/ui/sidebar.tsx";
import { cn } from "@/lib/utils.ts";

/**
 * The strip down the rail's right edge: drag to resize, click to collapse.
 *
 * This replaces upstream's `SidebarRail`, which wears `cursor-w-resize` but only toggles — an
 * affordance that says "drag me" and does not. The component ships no resizing at all
 * (`SIDEBAR_WIDTH` is a constant and there are no pointer handlers in it), so the drag is ours; the
 * click-to-toggle is kept because that edge is where upstream taught people to click.
 *
 * Drag and click are told apart by distance, not by timing: anything under a few pixels of travel is
 * a click. A time-based test makes a slow, careful drag collapse the rail instead of resizing it,
 * which is precisely the drag someone makes when they are trying to land on an exact width.
 *
 * **The drag does not go through React.** It writes `--sidebar-width` straight onto the provider
 * wrapper and commits to state once, on release. Two reasons, and both were visible as lag:
 *
 * - The app shell owns the width, so a state update per pointer move re-rendered the rail's rows and
 *   the Presentation Transcript beside them — once per frame, for a number only CSS reads.
 * - Persisting belongs at the end of a gesture, not inside it. `localStorage` is synchronous.
 *
 * This is safe against a re-render mid-drag: React only writes a style property whose value changed
 * between renders, and the committed state does not change until release — so an unrelated render
 * (the Agent Session poll, say) diffs the custom property as unchanged and leaves the live one alone.
 *
 * It is a `separator` rather than a button because that is what it is once it can be dragged — the
 * WAI-ARIA window-splitter pattern, which is also what gets it arrow keys. One tab stop, which the
 * rail can afford: the roving tabindex on the Agent Session rows exists so that twenty of them cost
 * one stop, and this is the second.
 */
const CLICK_SLOP = 4;

export function RailResizeHandle({
  width,
  onResize,
  onNudge,
}: {
  width: number;
  onResize: (px: number) => void;
  onNudge: (direction: -1 | 1, shiftKey: boolean) => void;
}) {
  const { toggleSidebar, state } = useSidebar();
  const [dragging, setDragging] = useState(false);
  const travel = useRef(0);

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      // Only the primary button, and never a modifier-click a browser has its own use for.
      if (event.button !== 0) return;
      const origin = event.clientX;
      const start = width;
      const element = event.currentTarget;
      // The element carrying `--sidebar-width`, which is the provider's wrapper.
      const wrapper = element.closest<HTMLElement>('[data-slot="sidebar-wrapper"]');
      let live = start;
      travel.current = 0;
      setDragging(true);
      // Suppresses the component's own 200ms width transition for the length of the gesture; see
      // the `[data-resizing]` rule in web/src/index.css.
      wrapper?.setAttribute("data-resizing", "true");
      // Capture, so the drag keeps following the pointer once it leaves this 16px strip — which it
      // does immediately, because resizing means moving away from the handle.
      element.setPointerCapture(event.pointerId);
      event.preventDefault();

      const onMove = (move: PointerEvent): void => {
        travel.current = Math.max(travel.current, Math.abs(move.clientX - origin));
        // Always from the width and pointer position this drag *started* at, never from the current
        // ones. Measuring against anything that moves as the rail resizes drifts, and re-deriving
        // from the start also means that once the clamp bites, reversing responds the moment the
        // pointer is back in range rather than after it has paid back the overshoot.
        live = clampRailWidth(start + (move.clientX - origin));
        wrapper?.style.setProperty("--sidebar-width", `${live}px`);
      };

      const onUp = (): void => {
        element.releasePointerCapture(event.pointerId);
        element.removeEventListener("pointermove", onMove);
        element.removeEventListener("pointerup", onUp);
        element.removeEventListener("pointercancel", onUp);
        wrapper?.removeAttribute("data-resizing");
        setDragging(false);

        // A press that went nowhere was a click on the edge, which is upstream's toggle. It may
        // still have nudged the property by a pixel or two, so the start value goes back first —
        // committing it instead would make every click a tiny resize.
        if (travel.current <= CLICK_SLOP) {
          wrapper?.style.setProperty("--sidebar-width", `${start}px`);
          toggleSidebar();
          return;
        }
        onResize(live);
      };

      element.addEventListener("pointermove", onMove);
      element.addEventListener("pointerup", onUp);
      element.addEventListener("pointercancel", onUp);
    },
    [onResize, toggleSidebar, width],
  );

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the rail"
      aria-valuenow={width}
      aria-valuemin={MIN_RAIL_WIDTH}
      aria-valuemax={MAX_RAIL_WIDTH}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onKeyDown={(event) => {
        if (event.key === "ArrowLeft") onNudge(-1, event.shiftKey);
        else if (event.key === "ArrowRight") onNudge(1, event.shiftKey);
        else if (event.key === "Enter" || event.key === " ") toggleSidebar();
        else return;
        // Arrows are `sidebar-next`/`previous` in the global table only as Up and Down, so Left and
        // Right are free — but Enter is `focus-pane`, so this has to stop here.
        event.preventDefault();
        event.stopPropagation();
      }}
      title="Drag to resize, click to collapse"
      className={cn(
        // A 16px target hanging off the rail's right edge, with a 2px line drawn down the middle of
        // it. Wider than it looks, because a 2px hit area is a 2px hit area.
        "absolute inset-y-0 -right-2 z-20 hidden w-4 shrink-0 cursor-col-resize sm:block",
        "after:absolute after:inset-y-0 after:left-1/2 after:w-[2px] after:-translate-x-1/2",
        "hover:after:bg-sidebar-border focus-visible:after:bg-sidebar-ring focus-visible:outline-hidden",
        // Held while dragging so the line does not flicker off as the pointer leaves the strip.
        dragging && "after:bg-sidebar-ring",
        // Collapsed, the rail has no width to drag: the strip becomes the way back, and says so.
        state === "collapsed" && "cursor-e-resize hover:bg-sidebar",
      )}
    />
  );
}
