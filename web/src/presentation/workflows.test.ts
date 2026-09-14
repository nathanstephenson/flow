import { test } from "node:test";
import { emptySchema, initialValue } from "./workflow-schema.ts";
import { parseRoute, formatRoute } from "./route.ts";
import assert from "node:assert/strict";
import type { WorkflowDefinition } from "../../../src/protocol/workflows.ts";
import {
  mappingChoices,
  nextStepName,
  recoveryCandidates,
  workflowIssue,
  recoveryOutput,
  schemaPaths,
  startIssue,
  validatedStepInput,
  withMappingField,
} from "./workflows.ts";
import {
  defaultLayout,
  fillWithWorkflows,
  parseLayouts,
  tabLabel,
  reconcileLayout,
} from "./docks.ts";
const definition: WorkflowDefinition = {
  version: 1,
  id: "sample",
  name: "Sample",
  backend: "pi",
  inputSchema: {
    type: "object",
    fields: { text: { schema: { type: "string" }, required: true } },
  },
  steps: [
    {
      id: "one",
      name: "One",
      kind: "typescript",
      code: "return input;",
      outputSchema: {
        type: "object",
        fields: { text: { schema: { type: "string" }, required: true } },
      },
    },
    {
      id: "two",
      name: "Two",
      kind: "typescript",
      code: "return input;",
      outputSchema: { type: "string" },
    },
  ],
  edges: [{ id: "edge", from: "one", to: "two", outcome: "success" }],
};
test("mapping permits optional combined fields without testing a candidate against the entire consumer schema", () => {
  const d: WorkflowDefinition = { ...definition, inputSchema: { type: "object", fields: { optional: { schema: { type: "string" } } } }, steps: definition.steps.map((s) => s.id === "two" ? { ...s, inputSchema: { type: "number" } } : s) };
  assert.ok(mappingChoices(d, "two", "object").some((c) => c.label === "Workflow input.optional"));
  assert.ok(!mappingChoices(d, "two").some((c) => c.label === "Workflow input.optional"));
});
test("generated names remain unique after deletion", () => {
  assert.equal(nextStepName({ ...definition, steps: [{ id: "x", name: "shell_2", kind: "shell", command: "" }] }, "shell"), "shell_1");
});
test("handled original failures are not recovery candidates", () => {
  const execution = { version: 1 as const, id: "e", sessionId: "s", scope: "/tmp", definition: { ...definition, edges: [{ id: "e", from: "one", to: "two", outcome: "failure" as const }] }, input: {}, status: "recovery-required" as const, startedAt: 0, steps: { one: { status: "failed" as const, outcome: "failure" as const, attempts: [] }, two: { status: "completed" as const, attempts: [] } } };
  assert.deepEqual(recoveryCandidates(execution), []);
  assert.deepEqual(recoveryCandidates({ ...execution, steps: { ...execution.steps, two: { status: "failed", recovery: true, attempts: [] } } }), ["two"]);
});
test("validation issues are readable", () => {
  assert.equal(workflowIssue({ issues: [{ path: ["backend"], message: "Required" }] }), "backend: Required");
});
test("matching Backend Adapter route uses the existing creation surface", () => {
  const route = parseRoute("#/new/pi");
  assert.deepEqual(route, {
    view: "session",
    sessionId: undefined,
    backend: "pi",
  });
  assert.equal(formatRoute(route), "#/new/pi");
});
test("visual schema defaults preserve required and optional field semantics", () => {
  assert.deepEqual(emptySchema("array"), {
    type: "array",
    items: { type: "string" },
  });
  assert.deepEqual(
    initialValue({
      type: "object",
      fields: {
        optional: { schema: { type: "string" } },
        defaulted: { schema: { type: "number" }, default: 7 },
        required: { required: true, schema: { type: "boolean" } },
      },
    }),
    { defaulted: 7, required: false },
  );
});
test("visual conditions reject incompatible input types", () => {
  const branch: WorkflowDefinition = {
    ...definition,
    steps: [
      {
        id: "condition",
        name: "Condition",
        kind: "branch",
        condition: { operator: "truthy", path: ["text"] },
      },
    ],
    edges: [],
  };
  assert.match(startIssue(branch, "pi", false)!, /boolean/);
  branch.steps = [
    {
      id: "condition",
      name: "Condition",
      kind: "branch",
      condition: { operator: "equals", path: ["text"], value: "ready" },
    },
  ];
  assert.equal(startIssue(branch, "pi", false), undefined);
});
test("workflow docks retain kind and survive Shell reconciliation", () => {
  const layout = defaultLayout();
  layout.right = fillWithWorkflows(layout.right, "workflow-tab");
  const restored = parseLayouts(JSON.stringify({ session: layout })).session!;
  assert.equal(tabLabel(restored.right, "workflow-tab"), "Workflows");
  assert.equal(
    reconcileLayout(restored, []).right.tabs[0]?.content?.kind,
    "workflows",
  );
});
test("schema paths expose nested visual sources", () => {
  assert.deepEqual(schemaPaths(definition.inputSchema), [[], ["text"]]);
});
test("mapping sources exclude future steps", () => {
  assert.ok(
    mappingChoices(definition, "one").every(
      (c) => c.reference.source === "input",
    ),
  );
  assert.ok(
    mappingChoices(definition, "two").some(
      (c) => c.reference.source === "step" && c.reference.stepId === "one",
    ),
  );
});
test("mapping transformations preserve step configuration and reject reserved keys", () => {
  const step = definition.steps[0]!;
  const mapped = withMappingField(step, "message", {
    source: "input",
    path: ["text"],
  });
  assert.equal(mapped.name, step.name);
  assert.deepEqual(mapped.mapping, {
    kind: "object",
    fields: { message: { source: "input", path: ["text"] } },
  });
  assert.throws(() =>
    withMappingField(step, "__proto__", { source: "input", path: [] }),
  );
});
test("start eligibility blocks mismatch and occupied slots", () => {
  assert.equal(startIssue(definition, "pi", false), undefined);
  assert.match(startIssue(definition, "claude", false)!, /Backend Adapter/);
  assert.match(startIssue(definition, "pi", true)!, /occupied/);
});
test("step sample and recovery output use inferred and immutable schemas", () => {
  assert.deepEqual(validatedStepInput(definition, "one", { text: "hello" }), {
    text: "hello",
  });
  assert.throws(() => validatedStepInput(definition, "one", {}));
  assert.throws(() => recoveryOutput(definition, "one", { text: 1 }));
  assert.deepEqual(recoveryOutput(definition, "one", { text: "done" }), {
    text: "done",
  });
});
