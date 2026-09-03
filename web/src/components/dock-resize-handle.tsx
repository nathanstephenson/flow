import { clampDockSize, type DockSide } from "@/presentation/docks.ts";
import { useResizeDrag } from "@/components/use-resize-drag.ts";
import { cn } from "@/lib/utils.ts";

/**
 * A Dock's leading edge: drag to resize.
 *
 * The rail's handle and this one share their gesture (`use-resize-drag.ts`) and differ in what a
 * press that goes nowhere means. The rail collapses on a click, because that is where upstream
 * taught people to click; a Dock does not, because it has a minimise button of its own inline with
 * its tabs — and a splitter that also minimised would make a careful drag ambiguous in the one case
 * where precision is the point.
 *
 * The maximum is a share of the pane rather than a constant, so the clamp needs the container it is
 * dividing. It is measured at each pointer move rather than at the start, because the window can be
 * resized mid-gesture and because the pane is the element being changed.
 */
export function DockResizeHandle({
  side,
  size,
  onResize,
  onNudge,
}: {
  side: DockSide;
  size: number;
  onResize: (px: number) => void;
  onNudge: (direction: -1 | 1, shiftKey: boolean) => void;
}) {
  const axis = side === "bottom" ? "row" : "col";
  const extent = (container: HTMLElement | null): number | undefined =>
    container === null ? undefined : side === "bottom" ? container.clientHeight : container.clientWidth;

  const { dragging, onPointerDown } = useResizeDrag({
    // Both Docks are on the trailing side of the pane, so their handles are on their *leading*
    // edges: the size grows as the pointer moves up, or left.
    grow: -1,
    axis,
    variable: side === "bottom" ? "--dock-bottom" : "--dock-right",
    container: (handle) => handle.closest<HTMLElement>("[data-dock-frame]"),
    size,
    clamp: (px, container) => clampDockSize(side, px, extent(container)),
    onCommit: onResize,
  });

  return (
    <div
      role="separator"
      aria-orientation={side === "bottom" ? "horizontal" : "vertical"}
      aria-label={side === "bottom" ? "Resize the bottom Dock" : "Resize the right Dock"}
      aria-valuenow={size}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onKeyDown={(event) => {
        // Towards the transcript is smaller, away from it is bigger, on both axes: Up and Left grow
        // the Dock because the Dock is below and to the right of what they point at.
        if (event.key === (axis === "row" ? "ArrowUp" : "ArrowLeft")) onNudge(1, event.shiftKey);
        else if (event.key === (axis === "row" ? "ArrowDown" : "ArrowRight")) onNudge(-1, event.shiftKey);
        else return;
        // Up and Down are `sidebar-previous`/`next` in the global table, so this has to stop here.
        event.preventDefault();
        event.stopPropagation();
      }}
      title="Drag to resize"
      className={cn(
        // A 16px target straddling the Dock's edge, with a 2px line down the middle of it, drawn the
        // same way as the rail's for the same reason: a 2px hit area is a 2px hit area.
        "absolute z-20 shrink-0",
        "after:absolute hover:after:bg-sidebar-border focus-visible:after:bg-sidebar-ring focus-visible:outline-hidden",
        side === "bottom"
          ? "inset-x-0 -top-2 h-4 cursor-row-resize after:inset-x-0 after:top-1/2 after:h-[2px] after:-translate-y-1/2"
          : "inset-y-0 -left-2 w-4 cursor-col-resize after:inset-y-0 after:left-1/2 after:w-[2px] after:-translate-x-1/2",
        dragging && "after:bg-sidebar-ring",
      )}
    />
  );
}
