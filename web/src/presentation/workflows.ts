import type {
  InputReference,
  VisualSchema,
  WorkflowDefinition,
  Json,
  WorkflowStep,
  WorkflowExecution,
} from "../../../src/protocol/workflows.ts";
import { validateDefinition } from "../../../src/workflows/graph.ts";
import { parseValue } from "../../../src/workflows/schema.ts";
export function nextStepName(definition: WorkflowDefinition, kind: WorkflowStep["kind"]): string {
  let index = 1;
  while (definition.steps.some((step) => step.name === `${kind}_${index}`)) index++;
  return `${kind}_${index}`;
}
export function workflowIssue(error: unknown): string {
  if (error && typeof error === "object" && "issues" in error && Array.isArray(error.issues))
    return error.issues.map((issue: { path?: PropertyKey[]; message: string }) => `${issue.path?.map(String).join(".") || "Workflow"}: ${issue.message}`).join("; ");
  return error instanceof Error ? error.message : String(error);
}
export function recoveryCandidates(execution: WorkflowExecution): string[] {
  return Object.entries(execution.steps).filter(([id, record]) =>
    record.status === "interrupted" ||
    (["failed", "timed-out"].includes(record.status) &&
      (execution.testStepId || record.recovery || !execution.definition.edges.some((edge) => edge.from === id && edge.outcome === record.outcome)))
  ).map(([id]) => id);
}
export function schemaPaths(
  schema: VisualSchema,
  path: string[] = [],
): string[][] {
  return [
    path,
    ...(schema.type === "object"
      ? Object.entries(schema.fields).flatMap(([key, field]) =>
          schemaPaths(field.schema, [...path, key]),
        )
      : []),
  ];
}
export function mappingChoices(
  definition: WorkflowDefinition,
  stepId: string,
  mode: "reference" | "object" = "reference",
): { label: string; reference: InputReference }[] {
  const step = definition.steps.find((s) => s.id === stepId);
  if (!step) return [];
  const base = {
    ...definition,
    steps: definition.steps.map((s) => {
      if (s.id !== stepId) return s;
      const copy = { ...s };
      delete copy.mapping;
      delete copy.inputSchema;
      return copy;
    }),
  };
  const graph = validateDefinition(base);
  const candidates: { label: string; reference: InputReference }[] =
    schemaPaths(definition.inputSchema).map((path) => ({
      label: `Workflow input${path.length ? "." + path.join(".") : ""}`,
      reference: { source: "input", path },
    }));
  const available = candidates.splice(0);
  for (const source of definition.steps) {
    if (source.id === stepId) continue;
    const schema = graph.outputSchemas.get(source.id);
    if (!schema) continue;
    for (const path of schemaPaths(schema)) {
      const reference: InputReference = {
        source: "step",
        stepId: source.id,
        path,
      };
      available.push({ label: `${source.name}${path.length ? "." + path.join(".") : ""}`, reference });
    }
  }
  for (const candidate of available) {
      const { reference } = candidate;
      try {
        validateDefinition({
          ...base,
          steps: base.steps.map((s) =>
            s.id === stepId
              ? { ...s, mapping: mode === "object" ? { kind: "object", fields: { value: reference } } : { kind: "reference", reference } }
              : s,
          ),
        });
        candidates.push(candidate);
      } catch {}
  }
  return candidates;
}
export function validatedStepInput(
  definition: WorkflowDefinition,
  stepId: string,
  input: Json,
): Json {
  const schema = validateDefinition(definition).inputSchemas.get(stepId);
  if (!schema) throw new Error("Select a step");
  return parseValue(schema, input);
}
export function recoveryOutput(
  definition: WorkflowDefinition,
  stepId: string,
  output: Json,
): Json {
  const schema = validateDefinition(definition).outputSchemas.get(stepId);
  if (!schema) throw new Error("Select a step");
  return parseValue(schema, output);
}
export function startIssue(
  definition: WorkflowDefinition,
  backend: string,
  occupied: boolean,
): string | undefined {
  if (occupied) return "The workflow slot is occupied";
  if (definition.backend !== backend)
    return `Requires Backend Adapter ${definition.backend}`;
  try {
    validateDefinition(definition);
  } catch (e) {
    return workflowIssue(e);
  }
  return undefined;
}
export function withMappingField(
  step: WorkflowStep,
  name: string,
  reference: InputReference,
): WorkflowStep {
  if (!name || ["__proto__", "constructor", "prototype"].includes(name))
    throw new Error("Invalid field name");
  return {
    ...step,
    mapping: {
      kind: "object",
      fields: {
        ...(step.mapping?.kind === "object" ? step.mapping.fields : {}),
        [name]: reference,
      },
    },
  };
}
