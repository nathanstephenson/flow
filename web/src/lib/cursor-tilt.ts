/** One delegated listener tilts every `.cursor-tilt` element towards the pointer, including popup
 * and mobile portals. No React state: it writes `--tilt-x`/`--tilt-y` (-0.5 to 0.5 across the
 * element) and `data-tilt-active` once per frame.
 */
export function installCursorTilt(document: Document): () => void {
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
    active?.removeAttribute("data-tilt-active");
    active = pending = null;
  };
  const paint = () => {
    frame = undefined;
    const next = pending?.isConnected ? pending : null;
    if (active !== next) active?.removeAttribute("data-tilt-active");
    active = next;
    if (!active) return;
    const point = tiltPoint(active.getBoundingClientRect(), x, y, reduced.matches);
    active.style.setProperty("--tilt-x", `${point.x}`);
    active.style.setProperty("--tilt-y", `${point.y}`);
    active.setAttribute("data-tilt-active", "");
  };
  const move = (event: PointerEvent) => {
    if (event.pointerType === "touch") { clear(); return; }
    const hit = event.target instanceof window.Element ? event.target : null;
    pending = hit?.closest<HTMLElement>(".cursor-tilt") ?? null;
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

/** Where the pointer is across the element, from -0.5 to 0.5 on each axis; the centre with reduced motion. */
export function tiltPoint(
  rect: { left: number; top: number; width: number; height: number },
  x: number,
  y: number,
  reduced: boolean,
): { x: number; y: number } {
  if (reduced) return { x: 0, y: 0 };
  const clamp = (value: number) => Math.max(-0.5, Math.min(0.5, value));
  return { x: clamp((x - rect.left) / rect.width - 0.5), y: clamp((y - rect.top) / rect.height - 0.5) };
}
