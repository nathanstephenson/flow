import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { MAX_ZOOM, panBy, UNZOOMED, zoomAt } from "./zoom-pan.ts";

describe("zooming and panning an image", () => {
  it("keeps the point under the pointer still while zooming", () => {
    const view = zoomAt(UNZOOMED, 2, 100, 50, 400, 200);
    assert.deepEqual(view, { scale: 2, x: -100, y: -50 });
    assert.equal((100 - view.x) / view.scale, 100);
  });

  it("never zooms out past the fitted size or in past the maximum", () => {
    assert.deepEqual(zoomAt(UNZOOMED, 0.5, 100, 50, 400, 200), UNZOOMED);
    assert.equal(zoomAt(UNZOOMED, 100, 0, 0, 400, 200).scale, MAX_ZOOM);
  });

  it("returns to the fitted position when zoomed back out", () => {
    const zoomed = zoomAt(UNZOOMED, 2, 300, 150, 400, 200);
    assert.deepEqual(zoomAt(zoomed, 0.5, 10, 10, 400, 200), UNZOOMED);
  });

  it("pans only as far as the image's edges", () => {
    const zoomed = zoomAt(UNZOOMED, 2, 0, 0, 400, 200);
    assert.deepEqual(panBy(zoomed, 50, 50, 400, 200), { scale: 2, x: 0, y: 0 });
    assert.deepEqual(panBy(zoomed, -1000, -1000, 400, 200), { scale: 2, x: -400, y: -200 });
    assert.deepEqual(panBy(UNZOOMED, -20, 0, 400, 200), UNZOOMED);
  });
});
