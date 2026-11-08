import { useEffect, useRef, useState, type PointerEvent } from "react";

import { panBy, UNZOOMED, zoomAt } from "@/presentation/zoom-pan.ts";
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "@/components/ui/dialog.tsx";
import { cn } from "@/lib/utils.ts";

/** A thumbnail that opens the image in a dialog of at most 80% of the window, to zoom and pan. */
export function ExpandableImage({ src, alt, className }: { src: string; alt: string; className?: string }) {
  return (
    <Dialog>
      <DialogTrigger
        render={
          <button
            type="button"
            aria-label={alt ? `Open ${alt}` : "Open image"}
            className="cursor-zoom-in rounded-md outline-none focus-visible:ring-3 focus-visible:ring-ring/30"
          />
        }
      >
        <img src={src} alt={alt} className={cn("block", className)} />
      </DialogTrigger>
      <DialogContent className="w-auto max-w-[80vw] gap-0 p-2 sm:max-w-[80vw]">
        <DialogTitle className="sr-only">{alt || "Image"}</DialogTitle>
        <ZoomPanImage src={src} alt={alt} />
      </DialogContent>
    </Dialog>
  );
}

/** Pinch or Ctrl+wheel zooms at the pointer, scrolling and dragging pan, double-click toggles fitted and 2×. */
function ZoomPanImage({ src, alt }: { src: string; alt: string }) {
  const box = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number } | undefined>(undefined);
  const [view, setView] = useState(UNZOOMED);

  useEffect(() => {
    const element = box.current;
    if (!element) return;
    // Not React's onWheel: it is passive, and the page must not scroll behind the dialog.
    // A trackpad pinch arrives as a wheel event with ctrlKey set; plain scrolling pans.
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = element.getBoundingClientRect();
      const lines = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : 1;
      const dx = event.deltaX * lines;
      const dy = event.deltaY * lines;
      setView((current) =>
        event.ctrlKey
          ? zoomAt(current, Math.exp(-Math.max(-50, Math.min(50, dy)) * 0.01), event.clientX - rect.left, event.clientY - rect.top, rect.width, rect.height)
          : panBy(current, -dx, -dy, rect.width, rect.height),
      );
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, []);

  const rect = () => box.current!.getBoundingClientRect();
  const endDrag = () => {
    drag.current = undefined;
  };

  return (
    <div
      ref={box}
      className={cn(
        "relative touch-none overflow-hidden rounded-md select-none",
        view.scale > 1 ? "cursor-grab active:cursor-grabbing" : "cursor-zoom-in",
      )}
      onPointerDown={(event: PointerEvent<HTMLDivElement>) => {
        if (event.button !== 0) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { x: event.clientX, y: event.clientY };
      }}
      onPointerMove={(event) => {
        const start = drag.current;
        if (!start) return;
        const { width, height } = rect();
        const dx = event.clientX - start.x;
        const dy = event.clientY - start.y;
        drag.current = { x: event.clientX, y: event.clientY };
        setView((current) => panBy(current, dx, dy, width, height));
      }}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={(event) => {
        const { left, top, width, height } = rect();
        const x = event.clientX - left;
        const y = event.clientY - top;
        setView((current) => (current.scale > 1 ? UNZOOMED : zoomAt(current, 2, x, y, width, height)));
      }}
    >
      <img
        src={src}
        alt={alt}
        draggable={false}
        className="block max-h-[calc(80dvh-1rem)] max-w-[calc(80vw-1rem)] origin-top-left will-change-transform"
        style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}
      />
    </div>
  );
}
