import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  clampRailWidth,
  DEFAULT_RAIL_WIDTH,
  MAX_RAIL_WIDTH,
  MIN_RAIL_WIDTH,
  parseRailWidth,
  railWidthStep,
  railWidthValue,
} from "./rail-width.ts";

describe("clamping the rail's width", () => {
  it("keeps a width inside the bounds", () => {
    assert.equal(clampRailWidth(300), 300);
    assert.equal(clampRailWidth(MIN_RAIL_WIDTH), MIN_RAIL_WIDTH);
    assert.equal(clampRailWidth(MAX_RAIL_WIDTH), MAX_RAIL_WIDTH);
  });

  it("pins one outside them", () => {
    assert.equal(clampRailWidth(0), MIN_RAIL_WIDTH);
    assert.equal(clampRailWidth(-9000), MIN_RAIL_WIDTH);
    assert.equal(clampRailWidth(99999), MAX_RAIL_WIDTH);
  });

  /**
   * A drag past the window edge, or a `clientX` read while the pointer is over a different document,
   * can produce these. A rail pinned to `NaNpx` collapses to nothing and reads as a rendering bug
   * rather than as a bad number, so it is caught here.
   */
  it("refuses a number that is not one", () => {
    assert.equal(clampRailWidth(Number.NaN), DEFAULT_RAIL_WIDTH);
    assert.equal(clampRailWidth(Number.POSITIVE_INFINITY), DEFAULT_RAIL_WIDTH);
    assert.equal(clampRailWidth(Number.NEGATIVE_INFINITY), DEFAULT_RAIL_WIDTH);
  });

  it("rounds, because a subpixel rail width is noise in the DOM", () => {
    assert.equal(clampRailWidth(300.4), 300);
    assert.equal(clampRailWidth(300.6), 301);
  });
});

describe("reading a remembered width", () => {
  it("takes a stored number", () => {
    assert.equal(parseRailWidth("320"), 320);
  });

  it("defaults when nothing was stored", () => {
    assert.equal(parseRailWidth(null), DEFAULT_RAIL_WIDTH);
  });

  /** Hand-edited, or written by a build with different bounds. Either way it must not break. */
  it("defaults on junk, and clamps a stored value that is out of bounds", () => {
    for (const junk of ["", "wide", "16rem", "{}"]) {
      assert.equal(parseRailWidth(junk), DEFAULT_RAIL_WIDTH, junk);
    }
    assert.equal(parseRailWidth("9999"), MAX_RAIL_WIDTH);
    assert.equal(parseRailWidth("1"), MIN_RAIL_WIDTH);
  });

  it("starts at the width the rail had before it was adjustable", () => {
    // 16rem at the browser default — the value `--sidebar-width` was hardcoded to.
    assert.equal(DEFAULT_RAIL_WIDTH, 256);
  });
});

describe("as a CSS length", () => {
  it("is a clamped pixel value", () => {
    assert.equal(railWidthValue(300), "300px");
    assert.equal(railWidthValue(0), `${MIN_RAIL_WIDTH}px`);
    assert.equal(railWidthValue(Number.NaN), `${DEFAULT_RAIL_WIDTH}px`);
  });
});

describe("the keyboard step", () => {
  it("is coarser with Shift held", () => {
    assert.ok(railWidthStep(true) > railWidthStep(false));
    // Both have to divide the range into a usable number of presses rather than a hundred.
    for (const shift of [true, false]) {
      const presses = (MAX_RAIL_WIDTH - MIN_RAIL_WIDTH) / railWidthStep(shift);
      assert.ok(presses <= 25, `${railWidthStep(shift)}px takes ${presses} presses`);
    }
  });
});
