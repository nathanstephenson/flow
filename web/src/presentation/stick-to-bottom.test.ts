import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isPinned, PIN_THRESHOLD_PX } from "./stick-to-bottom.ts";

describe("sticking to the end of the Presentation Transcript", () => {
  it("keeps the threshold at forty pixels", () => {
    // Tuned, and matching the old feel is the point. A test rather than a comment because the
    // number reads arbitrary to anyone who did not tune it.
    assert.equal(PIN_THRESHOLD_PX, 40);
  });

  it("is pinned at the bottom", () => {
    assert.equal(isPinned({ scrollHeight: 1000, scrollTop: 800, clientHeight: 200 }), true);
  });

  it("holds the pin just inside the slack and drops it just outside", () => {
    const metrics = (distance: number) => ({ scrollHeight: 1000, scrollTop: 800 - distance, clientHeight: 200 });

    assert.equal(isPinned(metrics(39)), true);
    assert.equal(isPinned(metrics(40)), false, "the threshold is exclusive");
    assert.equal(isPinned(metrics(41)), false);
  });

  it("absorbs the fractional pixels a zoomed scroller reports at the true bottom", () => {
    assert.equal(isPinned({ scrollHeight: 1000.4, scrollTop: 799.7, clientHeight: 200.2 }), true);
  });

  it("is pinned when there is nothing to scroll", () => {
    // An empty transcript, or one shorter than the pane: a reader who has never scrolled is at the
    // end by definition, and a negative distance must not read as scrolled away.
    assert.equal(isPinned({ scrollHeight: 200, scrollTop: 0, clientHeight: 200 }), true);
    assert.equal(isPinned({ scrollHeight: 0, scrollTop: 0, clientHeight: 400 }), true);
  });

  it("is not pinned when the reader has scrolled up to read", () => {
    assert.equal(isPinned({ scrollHeight: 10_000, scrollTop: 200, clientHeight: 400 }), false);
  });

  it("takes a threshold, for a caller that has measured a reason to", () => {
    assert.equal(isPinned({ scrollHeight: 1000, scrollTop: 700, clientHeight: 200 }, 200), true);
  });
});
