import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ModelInfo as SdkModelInfo } from "@anthropic-ai/claude-agent-sdk";

import { clampEffort } from "../../src/backend/effort.ts";
import { describeModel, modelInForce } from "../../src/backend/claude/index.ts";
import { effortChoices } from "../../src/client/model-choices.ts";
import { initialState } from "../../src/client/reduce.ts";
import type { ModelInfo } from "../../src/protocol/events.ts";

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

/**
 * Which model a client is told is in force — and therefore which Effort levels it may offer.
 *
 * The picker lists aliases; the init message at the start of every turn names the resolved model. An
 * id that is not on the list carries no effortLevels, so announcing one made the Effort control
 * vanish one turn into every Agent Session.
 */
describe("modelInForce", () => {
  const listed: ModelInfo[] = [
    { id: "opus[1m]", provider: "anthropic", label: "Opus (1M context)", effortLevels: ["low", "medium", "high"] },
    { id: "haiku", provider: "anthropic", label: "Haiku" },
  ];
  const aliases = new Map([["claude-opus-5", "opus[1m]"]]);

  it("reports the alias for a resolved id, which is what the list is keyed on", () => {
    assert.equal(modelInForce("claude-opus-5", aliases, listed), "opus[1m]");
  });

  it("passes an id that is already on the list straight through", () => {
    assert.equal(modelInForce("haiku", aliases, listed), "haiku");
  });

  it("stands the raw id up before the list has arrived", () => {
    // loadModels has not answered yet; there is nothing to match against and nothing to protect.
    assert.equal(modelInForce("claude-opus-5", new Map(), []), "claude-opus-5");
  });

  it("declines an id the list cannot describe, rather than displacing one it can", () => {
    // The regression: this used to be announced, and every control keyed on the list degraded.
    assert.equal(modelInForce("claude-opus-5-20260101", new Map(), listed), undefined);
  });

  it("keeps the Effort levels that announcing a resolved id used to throw away", () => {
    // The symptom, asserted through the shared rule the pickers actually call.
    const view = (id: string) => ({ ...initialState(), capabilities: { providers: ["anthropic"], models: listed, compaction: true, fork: true }, model: { id } });

    assert.deepEqual(effortChoices(view("claude-opus-5")), [], "resolved id has no levels — the old behaviour");
    assert.deepEqual(effortChoices(view(modelInForce("claude-opus-5", aliases, listed) ?? "")), ["low", "medium", "high"]);
  });
});
