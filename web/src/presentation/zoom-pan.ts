/** Scale and offset of a zoomable image, in a box of its own fitted size. Scale 1 fills the box. */
export type ZoomView = { scale: number; x: number; y: number };

export const UNZOOMED: ZoomView = { scale: 1, x: 0, y: 0 };
export const MAX_ZOOM = 8;

function clamp(view: ZoomView, width: number, height: number): ZoomView {
  const scale = Math.min(MAX_ZOOM, Math.max(1, view.scale));
  return {
    scale,
    x: Math.min(0, Math.max(width - width * scale, view.x)),
    y: Math.min(0, Math.max(height - height * scale, view.y)),
  };
}

/** Zoom by `factor` keeping the image point under (`px`, `py`) where it is. */
export function zoomAt(view: ZoomView, factor: number, px: number, py: number, width: number, height: number): ZoomView {
  const scale = Math.min(MAX_ZOOM, Math.max(1, view.scale * factor));
  const ratio = scale / view.scale;
  return clamp({ scale, x: px - (px - view.x) * ratio, y: py - (py - view.y) * ratio }, width, height);
}

export function panBy(view: ZoomView, dx: number, dy: number, width: number, height: number): ZoomView {
  return clamp({ ...view, x: view.x + dx, y: view.y + dy }, width, height);
}
