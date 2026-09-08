import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { contextUsageDetail } from "../src/client/context-usage.ts";

/** The hover detail behind the composer's bar, which is why there is only one of these. */
describe("the Conversation Context reading spelled out in full", () => {
  const context = (usage: Parameters<typeof contextUsageDetail>[0]): string | undefined =>
    contextUsageDetail(usage)?.find((row) => row.label === "Context")?.value;

  it("says nothing when the backend reports no window", () => {
    // The `window: 0` sentinel: spend but no budget, so a percentage would lie and the meter
    // renders nothing at all rather than a bar without a denominator.
    assert.equal(contextUsageDetail({ used: 41_000, window: 0 }), undefined);
    assert.equal(contextUsageDetail(undefined), undefined);
  });

  it("abbreviates thousands", () => {
    assert.equal(context({ used: 41_000, window: 200_000 }), "21% · 41k/200k tokens");
  });

  it("abbreviates millions to one decimal place", () => {
    assert.equal(context({ used: 250_000, window: 1_000_000 }), "25% · 250k/1M tokens");
    assert.equal(context({ used: 1_240_000, window: 2_000_000 }), "62% · 1.2M/2M tokens");
  });

  it("leaves a count below a thousand alone", () => {
    assert.equal(context({ used: 512, window: 200_000 }), "0% · 512/200k tokens");
  });

  it("rounds the percentage half up, matching the short label", () => {
    assert.equal(context({ used: 41_000, window: 200_000 })?.startsWith("21%"), true);
    assert.equal(context({ used: 40_999, window: 200_000 })?.startsWith("20%"), true);
  });

  /**
   * Spend is everything billed across every model, Subagents included — a different measure from
   * occupancy, routinely larger, and saying nothing about running out of room.
   */
  const spend = {
    tokens: 128_400,
    cached: 94_457,
    costUSD: 0.2356,
    models: [
      { id: "claude-opus-5", tokens: 127_493, cached: 94_457, costUSD: 0.2346 },
      { id: "claude-haiku-4-5", tokens: 907, cached: 0, costUSD: 0.000947 },
    ],
  };

  it("omits every spend row when the backend cannot report it", () => {
    const rows = contextUsageDetail({ used: 41_000, window: 200_000 });
    assert.deepEqual(rows?.map((row) => row.label), ["Context"], "a zero would read as free");
  });

  it("states the total, the cache share and each model", () => {
    const rows = contextUsageDetail({ used: 41_000, window: 200_000, spend });
    assert.deepEqual(rows, [
      { label: "Context", value: "21% · 41k/200k tokens" },
      { label: "Spent", value: "128k tokens · $0.24" },
      { label: "Cache reads", value: "94k of 128k" },
      { label: "claude-opus-5", value: "127k · $0.23", model: true },
      { label: "claude-haiku-4-5", value: "907 · $0.0009", model: true },
    ]);
  });

  it("keeps a sub-cent Subagent from rounding away to nothing", () => {
    // $0.000947 as "$0.00" would report a Subagent as free work.
    const rows = contextUsageDetail({ used: 1, window: 200_000, spend });
    assert.equal(rows?.find((row) => row.label === "claude-haiku-4-5")?.value.endsWith("$0.0009"), true);
  });

  it("drops the breakdown when only one model ran, since Spent already says it", () => {
    const one = { ...spend, models: [spend.models[0]!] };
    const rows = contextUsageDetail({ used: 41_000, window: 200_000, spend: one });
    assert.deepEqual(rows?.map((row) => row.label), ["Context", "Spent", "Cache reads"]);
  });

  it("shows a Spent larger than the window without complaint", () => {
    // The case that proves the two are different measures: a session can bill far more than the
    // window holds, because a Subagent's tokens are billed and never occupy the parent's context.
    const big = { ...spend, tokens: 3_400_000 };
    const rows = contextUsageDetail({ used: 41_000, window: 200_000, spend: big });
    assert.equal(rows?.find((row) => row.label === "Spent")?.value.startsWith("3.4M"), true);
  });
});
