/** One delegated listener covers native controls, including popup/mobile portals.
 * No React state, DOM discovery, canvases or text/colour overrides on pointer frames.
 */
export function installCursorGloss(document: Document): () => void {
  const window = document.defaultView;
  if (!window) return () => {};
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
  let active: HTMLElement | null = null;
  let pending: HTMLElement | null = null;
  let frame: number | undefined;
  let x = 0;
  let y = 0;

  const clear = () => {
    if (frame !== undefined) window.cancelAnimationFrame(frame);
    frame = undefined;
    active?.removeAttribute("data-gloss-active");
    active = pending = null;
  };
  const paint = () => {
    frame = undefined;
    if (active !== pending || !pending?.isConnected) active?.removeAttribute("data-gloss-active");
    active = pending?.isConnected ? pending : null;
    if (!active) return;
    const rect = active.getBoundingClientRect();
    const point = glossPoint(rect, x, y, reduced.matches);
    active.style.setProperty("--gloss-x", `${point.x}px`);
    active.style.setProperty("--gloss-y", `${point.y}px`);
    active.setAttribute("data-gloss-active", "");
  };
  const move = (event: PointerEvent) => {
    if (event.pointerType === "touch") { clear(); return; }
    const hit = event.target instanceof window.Element ? event.target : null;
    // Settle is an overlay on a row: its gloss belongs to the entire row.
    const action = hit?.closest('[data-sidebar="menu-action"]');
    const target = action
      ? action.closest('[data-sidebar="menu-item"]')?.querySelector<HTMLElement>(".cursor-gloss")
      : hit?.closest<HTMLElement>(".cursor-gloss");
    pending = target && !target.matches(':disabled, [aria-disabled="true"], [data-disabled], summary, [data-slot="accordion-trigger"], h3 > button[aria-expanded]:not([aria-haspopup])') ? target : null;
    x = event.clientX;
    y = event.clientY;
    if (frame === undefined) frame = window.requestAnimationFrame(paint);
  };
  const leave = (event: PointerEvent) => { if (!event.relatedTarget) clear(); };
  document.addEventListener("pointermove", move, { passive: true });
  document.addEventListener("pointerover", move, { passive: true });
  document.addEventListener("pointerout", leave, { passive: true });
  document.addEventListener("scroll", clear, true);
  document.addEventListener("visibilitychange", clear);
  window.addEventListener("blur", clear);
  window.addEventListener("resize", clear);
  reduced.addEventListener("change", clear);
  return () => {
    clear();
    document.removeEventListener("pointermove", move);
    document.removeEventListener("pointerover", move);
    document.removeEventListener("pointerout", leave);
    document.removeEventListener("scroll", clear, true);
    document.removeEventListener("visibilitychange", clear);
    window.removeEventListener("blur", clear);
    window.removeEventListener("resize", clear);
    reduced.removeEventListener("change", clear);
  };
}

export function glossPoint(
  rect: { left: number; top: number; width: number; height: number },
  x: number,
  y: number,
  reduced: boolean,
): { x: number; y: number } {
  return reduced
    ? { x: rect.width / 2, y: rect.height / 2 }
    : { x: Math.max(0, Math.min(rect.width, x - rect.left)), y: Math.max(0, Math.min(rect.height, y - rect.top)) };
}
