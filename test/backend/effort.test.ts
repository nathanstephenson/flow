import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ModelInfo as SdkModelInfo } from "@anthropic-ai/claude-agent-sdk";

import { clampEffort } from "../../src/backend/effort.ts";
import { describeModel } from "../../src/backend/claude/index.ts";

/**
 * The two pure pieces of the Effort mapping. Both decide what a client is offered, and both are
 * reachable without a model behind them — the rest of the Claude adapter needs the real CLI.
 */

describe("clampEffort", () => {
  it("passes a level the model serves straight through", () => {
    assert.equal(clampEffort("high", ["low", "medium", "high"]), "high");
  });

  it("falls to the nearest level the model does serve", () => {
    // Claude has no `off`; pi has no `max`. Neither should make a model switch fail.
    assert.equal(clampEffort("max", ["low", "medium", "high"]), "high");
    assert.equal(clampEffort("off", ["low", "medium", "high", "max"]), "low");
  });

  it("breaks a tie downwards, so a clamp never quietly costs more", () => {
    assert.equal(clampEffort("medium", ["low", "high"]), "low");
  });

  it("returns nothing for a model with no effort control", () => {
    assert.equal(clampEffort("high", []), undefined);
    assert.equal(clampEffort("high", undefined), undefined);
  });
});

describe("Claude model mapping", () => {
  const sdkModel = (overrides: Partial<SdkModelInfo>): SdkModelInfo =>
    ({ value: "sonnet", displayName: "Sonnet", description: "", ...overrides }) as SdkModelInfo;

  it("keeps the alias as the id and the display name as the label", () => {
    assert.deepEqual(describeModel(sdkModel({ value: "opus[1m]", displayName: "Opus (1M context)" })), {
      id: "opus[1m]",
      provider: "anthropic",
      label: "Opus (1M context)",
    });
  });

  it("carries per-model effort levels", () => {
    const model = describeModel(sdkModel({ supportedEffortLevels: ["low", "high", "max"] }));
    assert.deepEqual(model.effortLevels, ["low", "high", "max"]);
  });

  it("declares no levels for a model without an effort control", () => {
    // haiku reports supportedEffortLevels absent; the control must be hidden, not shown empty.
    assert.equal(describeModel(sdkModel({ value: "haiku" })).effortLevels, undefined);
    assert.equal(describeModel(sdkModel({ supportedEffortLevels: [] })).effortLevels, undefined);
  });
});
