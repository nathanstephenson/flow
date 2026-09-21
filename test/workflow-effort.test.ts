import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { effortCapability, initialWorkflowEffort } from "../src/client/model-choices.ts";
import { effortForWorkflowModelSelection, normalizeNoControlEffort } from "../src/client/workflow-effort.ts";
import type { Capabilities, ModelInfo } from "../src/protocol/events.ts";
import type { WorkflowDefinition } from "../src/protocol/workflows.ts";

const supported: ModelInfo = { id: "supported", effortLevels: ["minimal", "low", "medium", "high", "max"] };
const restricted: ModelInfo = { id: "restricted", effortLevels: ["off", "low", "high"] };
const noControl: ModelInfo = { id: "plain" };
const capabilities: Capabilities = {
  providers: ["test"], models: [supported, restricted, noControl], compaction: false, fork: false,
  subagents: true, enquiries: false, permissions: false,
};

const definition = (model: string, effort: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"): WorkflowDefinition => ({
  version: 1,
  id: "effort",
  name: "Effort",
  backend: "test",
  permission: "ask",
  inputSchema: { type: "object", fields: {} },
  steps: [{ id: "agent", name: "Agent", kind: "agent", model, effort, instructions: "Return JSON", outputSchema: { type: "string" } }],
  edges: [],
});
const agentEffort = (value: WorkflowDefinition | undefined) => {
  const step = value?.steps[0];
  return step?.kind === "agent" ? step.effort : undefined;
};

describe("Effort capability states", () => {
  it("keeps loading/unknown distinct from confirmed no-control", () => {
    assert.equal(effortCapability(undefined, supported).status, "unknown");
    assert.equal(effortCapability(capabilities, { id: "missing" }).status, "unknown");
    assert.deepEqual(effortCapability(capabilities, noControl), { status: "none", levels: [] });
    assert.deepEqual(effortCapability(capabilities, restricted), { status: "supported", levels: ["off", "low", "high"] });
  });

  it("defaults a first model selection from confirmed levels only", () => {
    assert.equal(initialWorkflowEffort(supported), "medium");
    assert.equal(initialWorkflowEffort(restricted), "off", "lowest SDK level wins when medium is absent");
    assert.equal(initialWorkflowEffort(noControl), "off");
    assert.equal(effortForWorkflowModelSelection("", "off", supported), "medium");
    assert.equal(effortForWorkflowModelSelection("", "off", restricted), "off");
  });

  it("preserves an existing unsupported value across model switches", () => {
    assert.equal(effortForWorkflowModelSelection("supported", "max", restricted), "max");
  });

  it("automatically applies off only after no-control support is confirmed", () => {
    const saved = definition("plain", "high");
    assert.equal(agentEffort(normalizeNoControlEffort(saved, undefined)), "high");
    assert.equal(agentEffort(normalizeNoControlEffort(saved, [{ backend: "test", models: [], problem: "offline" }])), "high");
    assert.equal(agentEffort(normalizeNoControlEffort(saved, [{ backend: "test", models: [noControl] }])), "off");
  });
});
