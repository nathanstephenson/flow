import { test } from "node:test";
import assert from "node:assert/strict";
import type {
  WorkflowDefinition,
  WorkflowLoopRecord,
} from "../../../src/protocol/workflows.ts";
import {
  absolutePosition,
  cleanLoopSettings,
  extendLoop,
  limitedLoops,
  loopLayout,
  loopProgress,
  WORKFLOW_CARD_HEIGHT,
  WORKFLOW_CARD_WIDTH,
} from "./workflow-loops.ts";
import { mappingChoices } from "./workflows.ts";

const schema = {
  type: "object" as const,
  fields: { ok: { required: true, schema: { type: "boolean" as const } } },
};
const definition: WorkflowDefinition = {
  version: 1,
  id: "loops",
  name: "Loops",
  backend: "pi",
  inputSchema: schema,
  steps: ["root", "outer", "inner", "work", "check", "exit"].map((id, i) =>
    id === "inner" || id === "check"
      ? {
          id,
          name: id,
          kind: "branch",
          condition: { operator: "truthy", path: ["ok"] },
          position: { x: i * 280, y: 200 },
        }
      : {
          id,
          name: id,
          kind: "typescript",
          code: "return input",
          outputSchema: schema,
          position: { x: i * 280, y: 200 },
        },
  ),
  edges: [
    { id: "a", from: "root", to: "outer", outcome: "success" },
    { id: "b", from: "outer", to: "inner", outcome: "success" },
    { id: "c", from: "inner", to: "work", outcome: "false" },
    { id: "d", from: "work", to: "inner", outcome: "success" },
    { id: "e", from: "inner", to: "check", outcome: "true" },
    { id: "f", from: "check", to: "outer", outcome: "false" },
    { id: "g", from: "check", to: "exit", outcome: "true" },
  ],
  loopSettings: { outer: { maxTries: 5 }, inner: { maxTries: 2 } },
};
test("nested groups precede children and do not act as steps", () => {
  const nodes = loopLayout(definition);
  assert.deepEqual(
    nodes.slice(0, 2).map((node) => node.id),
    ["loop:outer", "loop:inner"],
  );
  assert.equal(nodes[1]!.parentId, "loop:outer");
  for (const node of nodes.filter((node) => node.type === "loop")) {
    assert.equal(node.selectable, false);
    assert.equal(node.deletable, false);
    assert.equal(node.connectable, false);
    assert.equal(node.draggable, false);
  }
  for (const step of definition.steps)
    assert.deepEqual(
      absolutePosition(nodes.find((node) => node.id === step.id)!, nodes),
      step.position,
    );
});
test("vertical nested loops reserve side rails and contain the full-sized cards", () => {
  const nodes = loopLayout(definition, { orientation: "vertical" });
  const loopNodes = nodes.filter((node) => node.type === "loop");
  assert.equal(loopNodes.length, 2);
  for (const loop of loopNodes) {
    assert.equal(loop.data.orientation, "vertical");
    assert.ok(Number(loop.style?.width) >= 264 + WORKFLOW_CARD_WIDTH + 24);
    assert.ok(Number(loop.style?.height) >= WORKFLOW_CARD_HEIGHT + 48);
  }
  for (const node of nodes.filter((node) => node.parentId)) {
    // The dedicated rail keeps vertical incoming edges and their labels away from loop summaries.
    assert.ok(node.position.x >= 264);
    assert.ok(node.position.y >= 24);
  }
  for (const step of definition.steps)
    assert.deepEqual(
      absolutePosition(nodes.find((node) => node.id === step.id)!, nodes),
      step.position,
    );
});

test("drag coordinates remain absolute and nested containment is stable", () => {
  const nodes = loopLayout(definition);
  const work = nodes.find((node) => node.id === "work")!;
  const position = absolutePosition(
    {
      ...work,
      position: { x: work.position.x - 900, y: work.position.y + 100 },
    },
    nodes,
  );
  const moved = {
    ...definition,
    steps: definition.steps.map((step) =>
      step.id === "work" ? { ...step, position } : step,
    ),
  };
  const next = loopLayout(moved);
  for (const step of moved.steps)
    assert.deepEqual(
      absolutePosition(next.find((node) => node.id === step.id)!, next),
      step.position,
    );
  for (const node of next.filter((node) => node.parentId)) {
    assert.ok(node.position.x >= 24);
    assert.ok(node.position.y >= 100);
  }
  assert.deepEqual(
    cleanLoopSettings(moved).loopSettings,
    definition.loopSettings,
  );
});
test("groups remain visible with invalid mappings; cycle removal clears only its settings", () => {
  const invalid = {
    ...definition,
    steps: definition.steps.map((step) => ({
      ...step,
      mapping: {
        kind: "reference" as const,
        reference: { source: "step" as const, stepId: "missing", path: [] },
      },
    })),
  };
  assert.equal(
    loopLayout(invalid).filter((node) => node.type === "loop").length,
    2,
  );
  const cleaned = cleanLoopSettings({
    ...invalid,
    steps: invalid.steps.map((step) =>
      step.id === "inner" ? { ...step, repeatMapping: step.mapping } : step,
    ),
    edges: invalid.edges.filter((edge) => edge.id !== "d"),
  });
  assert.deepEqual(cleaned.loopSettings, { outer: { maxTries: 5 } });
  assert.equal(
    cleaned.steps.find((step) => step.id === "inner")!.repeatMapping,
    undefined,
  );
});
test("mapping choices distinguish first entry and repeat while unrelated mappings are invalid", () => {
  const invalid = {
    ...definition,
    steps: definition.steps.map((step) =>
      step.id === "exit"
        ? {
            ...step,
            mapping: {
              kind: "reference" as const,
              reference: {
                source: "step" as const,
                stepId: "missing",
                path: [],
              },
            },
          }
        : step,
    ),
  };
  const first = mappingChoices(invalid, "inner", "reference", "mapping");
  const repeat = mappingChoices(invalid, "inner", "reference", "repeatMapping");
  assert.ok(
    !first.some(
      (choice) =>
        choice.reference.source === "step" &&
        choice.reference.stepId === "work",
    ),
  );
  assert.ok(
    repeat.some(
      (choice) =>
        choice.reference.source === "step" &&
        choice.reference.stepId === "work",
    ),
  );
});
test("limit recovery carries the current identity without changing the definition", () => {
  const loop: WorkflowLoopRecord = {
    activation: 2,
    try: 3,
    phase: "limit",
    grants: [{ activation: 1, try: 4 }],
  };
  assert.deepEqual(extendLoop("outer", loop, "Check the tests"), {
    kind: "extend-loop",
    headerId: "outer",
    activation: 2,
    try: 3,
    guidance: "Check the tests",
  });
  assert.equal("guidance" in extendLoop("outer", loop, ""), false);
  assert.equal(loopProgress(loop, 3), "Try 3 of 3 · Loop limit reached");
  assert.equal(
    loopProgress(
      {
        ...loop,
        phase: "repeating",
        try: 4,
        grants: [...loop.grants, { activation: 2, try: 4 }],
      },
      3,
    ),
    "Try 4 of 4 · repeating",
  );
  assert.deepEqual(
    limitedLoops({
      loops: { outer: loop, inner: { ...loop, phase: "exited" } },
    }).map(([id]) => id),
    ["outer"],
  );
});
