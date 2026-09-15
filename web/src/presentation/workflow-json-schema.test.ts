import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  JsonSchema,
  WorkflowDefinition,
} from "../../../src/protocol/workflows.ts";
import {
  initialTemplate,
  schemaHints,
  propertyHints,
  templateValue,
  valueTemplate,
  conditionalHints,
} from "./workflow-json-schema.ts";
import {
  mappingChoices,
  schemaPaths,
  validatedStepInput,
} from "./workflows.ts";

test("argument editor models every JSON value without text parsing and nested references remain unresolved", () => {
  const values = [
    null,
    true,
    4,
    "not JSON",
    ["a", null],
    { a: false, nested: { x: [4] } },
  ];
  for (const value of values)
    assert.deepEqual(templateValue(valueTemplate(value)), value);
  assert.equal(
    templateValue({
      kind: "object",
      fields: {
        id: { kind: "reference", reference: { source: "input", path: ["id"] } },
        literal: { kind: "literal", value: 2 },
      },
    }),
    undefined,
  );
  assert.deepEqual(
    initialTemplate({ type: ["string", "null"], default: null }),
    { kind: "literal", value: null },
  );
  assert.deepEqual(initialTemplate({ enum: ["first", null] }), {
    kind: "literal",
    value: "first",
  });
});

test("editor discovers local refs, composition and conditional/dependent fields without weakening validation", () => {
  const root: JsonSchema = {
    type: "object",
    $defs: {
      base: {
        type: "object",
        properties: { id: { type: "string", pattern: "^LIN-" } },
        required: ["id"],
      },
    },
    allOf: [
      { $ref: "#/$defs/base" },
      { properties: { mode: { enum: ["issue", "search"] } } },
    ],
    if: { properties: { mode: { const: "search" } }, required: ["mode"] },
    then: { properties: { query: { type: "string" } }, required: ["query"] },
    else: { properties: { details: { type: "boolean" } } },
    dependentSchemas: {
      query: { properties: { limit: { type: "integer", minimum: 1 } } },
    },
  };
  const hints = schemaHints(root, root);
  assert.deepEqual(Object.keys(propertyHints(hints)).sort(), ["id", "mode"]);
  const search = conditionalHints(hints, root, {
    id: "LIN-1",
    mode: "search",
    query: "test",
  });
  assert.deepEqual(Object.keys(propertyHints(search)).sort(), [
    "id",
    "limit",
    "mode",
    "query",
  ]);
  assert.deepEqual(
    Object.keys(
      propertyHints(
        conditionalHints(hints, root, { id: "LIN-1", mode: "issue" }),
      ),
    ).sort(),
    ["details", "id", "mode"],
  );
});

test("JSON structured fields participate in mapping discovery and single-step input validation", () => {
  const def: WorkflowDefinition = {
    version: 1,
    id: "mcp",
    name: "MCP",
    backend: "fake",
    inputSchema: { type: "object", fields: {} },
    steps: [
      {
        id: "fetch",
        name: "Fetch",
        kind: "mcp",
        tool: {
          connectionId: "c",
          connectionName: "C",
          identity: "0".repeat(64),
          serverIdentity: "1".repeat(64),
          toolName: "lookup",
          inputSchema: {
            type: "object",
            properties: { id: { type: "string", minLength: 1 } },
            required: ["id"],
          },
          outputSchema: {
            type: "object",
            properties: {
              issue: { type: "object", properties: { id: { type: "string" } } },
            },
          },
        },
      },
      {
        id: "agent",
        name: "Agent",
        kind: "agent",
        instructions: "",
        model: "fake",
        effort: "off",
        outputSchema: { type: "null" },
      },
    ],
    edges: [{ id: "next", from: "fetch", to: "agent", outcome: "success" }],
  };
  assert.ok(
    mappingChoices(def, "agent").some(
      (choice) => choice.label === "Fetch.structuredContent.issue.id",
    ),
  );
  assert.deepEqual(
    schemaPaths({
      type: "json",
      schema: { type: "object", properties: { id: { type: "string" } } },
    }),
    [[], ["id"]],
  );
  assert.throws(() => validatedStepInput(def, "fetch", { id: "" }));
  assert.deepEqual(validatedStepInput(def, "fetch", { id: "LIN-123" }), {
    id: "LIN-123",
  });
});
