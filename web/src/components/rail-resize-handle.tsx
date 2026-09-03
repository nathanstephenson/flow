import { clampRailWidth, MAX_RAIL_WIDTH, MIN_RAIL_WIDTH } from "@/presentation/rail-width.ts";
import { useResizeDrag } from "@/components/use-resize-drag.ts";
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
 * The gesture itself is `use-resize-drag.ts`, shared with the Docks' splitters — including why it
 * writes `--sidebar-width` directly rather than going through React.
 *
 * It is a `separator` rather than a button because that is what it is once it can be dragged — the
 * WAI-ARIA window-splitter pattern, which is also what gets it arrow keys. One tab stop, which the
 * rail can afford: the roving tabindex on the Agent Session rows exists so that twenty of them cost
 * one stop, and this is the second.
 */
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
  const { dragging, onPointerDown } = useResizeDrag({
    grow: 1,
    axis: "col",
    variable: "--sidebar-width",
    // The element carrying `--sidebar-width`, which is the provider's wrapper.
    container: (handle) => handle.closest<HTMLElement>('[data-slot="sidebar-wrapper"]'),
    size: width,
    clamp: (px) => clampRailWidth(px),
    onCommit: onResize,
    onClick: toggleSidebar,
  });

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
