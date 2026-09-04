import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { contextUsageDetail } from "../src/client/context-usage.ts";

/** The hover detail behind the composer's bar, which is why there is only one of these. */
describe("the Conversation Context reading spelled out in full", () => {
  it("says nothing when the backend reports no window", () => {
    // The `window: 0` sentinel: spend but no budget, so a percentage would lie and the meter
    // renders nothing at all rather than a bar without a denominator.
    assert.equal(contextUsageDetail({ used: 41_000, window: 0 }), undefined);
    assert.equal(contextUsageDetail(undefined), undefined);
  });

  it("abbreviates thousands", () => {
    assert.equal(contextUsageDetail({ used: 41_000, window: 200_000 }), "21% · 41k/200k tokens");
  });

  it("abbreviates millions to one decimal place", () => {
    assert.equal(contextUsageDetail({ used: 250_000, window: 1_000_000 }), "25% · 250k/1M tokens");
    assert.equal(contextUsageDetail({ used: 1_240_000, window: 2_000_000 }), "62% · 1.2M/2M tokens");
  });

  it("leaves a count below a thousand alone", () => {
    assert.equal(contextUsageDetail({ used: 512, window: 200_000 }), "0% · 512/200k tokens");
  });

  it("rounds the percentage half up, matching the short label", () => {
    assert.equal(contextUsageDetail({ used: 41_000, window: 200_000 })?.startsWith("21%"), true);
    assert.equal(contextUsageDetail({ used: 40_999, window: 200_000 })?.startsWith("20%"), true);
  });
});
