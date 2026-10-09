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
    };
    update();
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);
    return () => {
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
      style.removeProperty("--mobile-viewport-height");
      style.removeProperty("--mobile-viewport-top");
    };
  }, [mobile]);
}
