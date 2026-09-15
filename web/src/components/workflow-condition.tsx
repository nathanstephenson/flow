import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select.tsx";
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
    <fieldset className="grid gap-3 rounded-lg border p-3">
      <legend className="px-1 text-sm font-medium">Condition</legend>
      {error && (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      )}
      <label className="flex flex-col gap-1">
        <span className="text-sm font-medium">Input path</span>
        <Select
          value={JSON.stringify(condition.path)}
          onValueChange={(value) =>
            value !== null &&
            onChange({
              ...step,
              condition: {
                ...condition,
                path: JSON.parse(value) as string[],
              },
            })
          }
        >
          <SelectTrigger className="w-full" aria-label="Input path">
            <SelectValue>
              {condition.path.join(".") || "Whole input"}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={JSON.stringify(condition.path)}>
              {condition.path.join(".") || "Whole input"}
            </SelectItem>
            {schema &&
              schemaPaths(schema)
                .filter(
                  (path) =>
                    JSON.stringify(path) !== JSON.stringify(condition.path),
                )
                .map((path) => (
                  <SelectItem
                    key={JSON.stringify(path)}
                    value={JSON.stringify(path)}
                  >
                    {path.join(".") || "Whole input"}
                  </SelectItem>
                ))}
          </SelectContent>
        </Select>
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-sm font-medium">Operator</span>
        <Select
          value={condition.operator}
          onValueChange={(value) => {
            if (value === null) return;
            const operator = value as typeof condition.operator;
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
          <SelectTrigger className="w-full" aria-label="Operator">
            <SelectValue>{condition.operator}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {[
              "truthy",
              "equals",
              "not-equals",
              "greater-than",
              "less-than",
            ].map((o) => (
              <SelectItem key={o} value={o}>
                {o}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
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
