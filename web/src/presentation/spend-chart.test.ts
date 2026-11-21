import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { SpendWindow } from "../../../src/protocol/spend.ts";
import { niceCeiling, OTHER, spendChart } from "./spend-chart.ts";

const model = (id: string, costUSD: number, tokens = 0) => ({ id, tokens, cached: 0, costUSD });

function window(buckets: SpendWindow["buckets"]): SpendWindow {
  return { tokens: 0, cached: 0, costUSD: 0, models: [], sources: [], buckets };
}

describe("the Spend graph", () => {
  const order = ["a", "b", "c", "d", "e", "f", "g"];

  it("names the first five lifetime models and folds the rest into Other", () => {
    const chart = spendChart(window([{ start: "s", models: [model("a", 1), model("f", 2), model("g", 3)] }]), order, "costUSD");

    assert.deepEqual(chart.series, [{ id: "a", color: "var(--series-1)" }, { id: OTHER, color: "var(--muted-foreground)" }]);
    assert.deepEqual(chart.bars[0]!.segments.map(segment => [segment.id, segment.value]), [["a", 1], [OTHER, 5]]);
    assert.equal(chart.bars[0]!.total, 6);
  });

  it("keeps a model's colour when other models are absent", () => {
    const chart = spendChart(window([{ start: "s", models: [model("c", 1)] }]), order, "costUSD");
    assert.deepEqual(chart.series, [{ id: "c", color: "var(--series-3)" }]);
  });

  it("plots tokens when asked, so zero-cost use shows", () => {
    const empty = spendChart(window([{ start: "s", models: [model("a", 0, 900)] }]), order, "costUSD");
    const tokens = spendChart(window([{ start: "s", models: [model("a", 0, 900)] }]), order, "tokens");

    assert.deepEqual([empty.series.length, empty.bars[0]!.total], [0, 0]);
    assert.deepEqual([tokens.bars[0]!.total, tokens.max], [900, 1000]);
  });

  it("rounds the axis up to a readable value", () => {
    assert.deepEqual([0, 0.03, 7, 18, 240].map(niceCeiling), [1, 0.05, 10, 20, 250]);
  });
});
