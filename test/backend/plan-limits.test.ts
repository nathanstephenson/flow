import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { anthropicPlanLimits } from "../../src/backend/plan-limits.ts";
import { codexPlanLimits } from "../../src/backend/pi/plan-limits.ts";

describe("Plan Limits from Anthropic usage", () => {
  it("reads the 5-hour and 7-day windows and each model window", () => {
    assert.deepEqual(anthropicPlanLimits({
      five_hour: { utilization: 12, resets_at: "2026-11-23T20:40:00Z" },
      seven_day: { utilization: 25, resets_at: null },
      seven_day_opus: null,
      model_scoped: [{ display_name: "Fable", utilization: 13, resets_at: null }],
    }), {
      short: { label: "5-hour", utilization: 12, resetsAt: "2026-11-23T20:40:00Z" },
      long: { label: "7-day", utilization: 25 },
      others: [{ label: "Fable", utilization: 13 }],
    });
  });

  it("has none without a subscription", () => {
    assert.equal(anthropicPlanLimits(null), undefined);
  });
});

describe("Plan Limits from Codex usage", () => {
  const window = (used_percent: number, limit_window_seconds: number) => ({ used_percent, limit_window_seconds, reset_at: 1_800_000_000 });

  it("names each window by its length", () => {
    assert.deepEqual(codexPlanLimits({
      rate_limit: { primary_window: window(40, 18_000), secondary_window: window(10, 604_800) },
      additional_rate_limits: [{ limit_name: "Spark", rate_limit: { primary_window: window(5, 18_000), secondary_window: null } }],
    }), {
      provider: "Codex",
      short: { label: "5-hour", utilization: 40, resetsAt: "2027-01-15T08:00:00.000Z" },
      long: { label: "7-day", utilization: 10, resetsAt: "2027-01-15T08:00:00.000Z" },
      others: [{ label: "Spark 5-hour", utilization: 5, resetsAt: "2027-01-15T08:00:00.000Z" }],
    });
  });

  it("has none without both windows", () => {
    assert.equal(codexPlanLimits({ rate_limit: { primary_window: window(40, 18_000) } }), undefined);
  });
});
