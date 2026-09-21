import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";

import { piAcceptsWorkflowEffort, piEffortLevels } from "../../src/backend/pi/effort-capabilities.ts";
import { describeModel } from "../../src/backend/pi/index.ts";

const model = (reasoning: boolean, thinkingLevelMap?: Model<Api>["thinkingLevelMap"]) => ({
  reasoning,
  ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
}) as Model<Api>;

describe("Pi SDK Effort capabilities", () => {
  it("uses the installed SDK's complete default set", () => {
    assert.deepEqual(piEffortLevels(model(true)), ["off", "minimal", "low", "medium", "high"]);
  });

  it("honours SDK restrictions and extended names", () => {
    assert.deepEqual(
      piEffortLevels(model(true, { minimal: null, medium: null, xhigh: "xhigh", max: "max" })),
      ["off", "low", "high", "xhigh", "max"],
    );
  });

  it("maps the SDK's off-only non-reasoning state to confirmed no-control", () => {
    const plain = model(false);
    assert.deepEqual(piEffortLevels(plain), []);
    assert.equal(piAcceptsWorkflowEffort(plain, "off"), true);
    assert.equal(piAcceptsWorkflowEffort(plain, "low"), false);
  });

  it("keeps advertised catalogue choices and workflow/subagent validation in agreement", () => {
    const restricted = {
      ...model(true, { minimal: null, medium: null, max: "max" }),
      id: "restricted", provider: "provider", name: "Restricted",
    };
    const advertised = describeModel(restricted).effortLevels ?? [];
    assert.deepEqual(advertised, piEffortLevels(restricted));
    for (const level of advertised) assert.equal(piAcceptsWorkflowEffort(restricted, level), true, level);
    assert.equal(piAcceptsWorkflowEffort(restricted, "medium"), false, "an omitted level is rejected before child work");
  });
});
