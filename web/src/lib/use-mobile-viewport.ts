import { useEffect } from "react";

import { useIsMobile } from "./use-mobile.ts";

export function useMobileViewport(): void {
  const mobile = useIsMobile();

  useEffect(() => {
    const viewport = window.visualViewport;
    if (!mobile || !viewport) return;
    const style = document.documentElement.style;
    const update = (): void => {
      if (viewport.scale !== 1) return;
      style.setProperty("--mobile-viewport-height", `${viewport.height}px`);
      style.setProperty("--mobile-viewport-top", `${viewport.offsetTop}px`);
      // iOS standalone mode can keep reporting the home-indicator inset while the keyboard is
      // open. The visual viewport already ends above it: do not reserve that inset a second time.
      // Compare heights, not bottoms, so Safari panning the visual viewport cannot undo this.
      if (viewport.height < window.innerHeight - 1) style.setProperty("--mobile-viewport-safe-bottom", "0px");
      else style.removeProperty("--mobile-viewport-safe-bottom");
    };
    update();
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);
    // The layout viewport can change separately from visualViewport (rotation/window resizing).
    window.addEventListener("resize", update);
    return () => {
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
      style.removeProperty("--mobile-viewport-height");
      style.removeProperty("--mobile-viewport-top");
      style.removeProperty("--mobile-viewport-safe-bottom");
    };
  }, [mobile]);
}
