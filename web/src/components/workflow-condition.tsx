import type {
  WorkflowDefinition,
  WorkflowStep,
  VisualSchema,
} from "../../../src/protocol/workflows.ts";
import { validateDefinition } from "../../../src/workflows/graph.ts";
import { schemaAt } from "../../../src/workflows/schema.ts";
import { schemaPaths } from "../presentation/workflows.ts";
import { initialValue, ValueEditor } from "./workflow-editors.tsx";
export function ConditionEditor({
  definition,
  step,
  onChange,
}: {
  definition: WorkflowDefinition;
  step: Extract<WorkflowStep, { kind: "branch" }>;
  onChange: (step: WorkflowStep) => void;
}) {
  let schema: VisualSchema | undefined;
  let error = "";
  try {
    schema = validateDefinition({
      ...definition,
      steps: definition.steps.map((s) =>
        s.id === step.id
          ? {
              ...step,
              condition: { operator: "equals", path: [], value: null },
            }
          : s,
      ),
    }).inputSchemas.get(step.id);
  } catch (e) {
    error = String(e);
  }
  let field: VisualSchema = { type: "string" };
  try {
    if (schema) field = schemaAt(schema, step.condition.path).schema;
  } catch {
    error = "Select an available input path";
  }
  const condition = step.condition;
  return (
    <fieldset className="grid gap-2 border p-2">
      <legend>Visual condition</legend>
      {error && <p role="alert">{error}</p>}
      <label>
        Input path
        <select
          value={JSON.stringify(condition.path)}
          onChange={(e) =>
            onChange({
              ...step,
              condition: {
                ...condition,
                path: JSON.parse(e.target.value) as string[],
              },
            })
          }
        >
          <option value={JSON.stringify(condition.path)}>
            {condition.path.join(".") || "Whole input"}
          </option>
          {schema &&
            schemaPaths(schema).map((path) => (
              <option key={JSON.stringify(path)} value={JSON.stringify(path)}>
                {path.join(".") || "Whole input"}
              </option>
            ))}
        </select>
      </label>
      <label>
        Operator
        <select
          value={condition.operator}
          onChange={(e) => {
            const operator = e.target.value as typeof condition.operator;
            onChange({
              ...step,
              condition:
                operator === "truthy"
                  ? { operator, path: condition.path }
                  : operator === "greater-than" || operator === "less-than"
                    ? { operator, path: condition.path, value: 0 }
                    : {
                        operator,
                        path: condition.path,
                        value: initialValue(field),
                      },
            });
          }}
        >
          {["truthy", "equals", "not-equals", "greater-than", "less-than"].map(
            (o) => (
              <option key={o}>{o}</option>
            ),
          )}
        </select>
      </label>
      {condition.operator !== "truthy" && (
        <ValueEditor
          schema={
            condition.operator === "greater-than" ||
            condition.operator === "less-than"
              ? { type: "number" }
              : field
          }
          value={condition.value}
          onChange={(value) =>
            onChange({
              ...step,
              condition:
                condition.operator === "greater-than" ||
                condition.operator === "less-than"
                  ? { ...condition, value: Number(value) }
                  : {
                      operator: condition.operator as "equals" | "not-equals",
                      path: condition.path,
                      value,
                    },
            })
          }
        />
      )}
    </fieldset>
  );
}
