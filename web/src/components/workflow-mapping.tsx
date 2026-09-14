import type {
  WorkflowDefinition,
  WorkflowStep,
} from "../../../src/protocol/workflows.ts";
import { mappingChoices, withMappingField, workflowIssue } from "../presentation/workflows.ts";
export function MappingEditor({
  definition,
  step,
  onChange,
}: {
  definition: WorkflowDefinition;
  step: WorkflowStep;
  onChange: (s: WorkflowStep) => void;
}) {
  let error = "";
  let choices: ReturnType<typeof mappingChoices> = [];
  try {
    choices = mappingChoices(definition, step.id, step.mapping?.kind ?? "reference");
  } catch (e) {
    error = workflowIssue(e);
  }
  return (
    <fieldset className="border p-2 grid gap-2">
      <legend>Visual input mapping</legend>
      <p>
        Only guaranteed completed step outputs are offered. Without a mapping,
        input comes from the preceding step.
      </p>
      {error && <p role="alert">{error}</p>}
      <label>
        Input mode
        <select
          value={step.mapping?.kind ?? "default"}
          onChange={(e) => {
            const next = { ...step };
            if (e.target.value === "default") delete next.mapping;
            else
              next.mapping =
                e.target.value === "object"
                  ? { kind: "object", fields: {} }
                  : {
                      kind: "reference",
                      reference: { source: "input", path: [] },
                    };
            onChange(next);
          }}
        >
          <option value="default">Preceding output</option>
          <option value="reference">One source</option>
          <option value="object">Combine named fields</option>
        </select>
      </label>
      {step.mapping?.kind === "reference" && (
        <select
          aria-label="Input source"
          value={JSON.stringify(step.mapping.reference)}
          onChange={(e) => {
            const choice = choices.find(
              (c) => JSON.stringify(c.reference) === e.target.value,
            );
            if (choice)
              onChange({
                ...step,
                mapping: { kind: "reference", reference: choice.reference },
              });
          }}
        >
          <option value={JSON.stringify(step.mapping.reference)}>
            {choices.find(
              (c) =>
                JSON.stringify(c.reference) ===
                JSON.stringify(
                  step.mapping?.kind === "reference"
                    ? step.mapping.reference
                    : null,
                ),
            )?.label ?? "Unavailable source"}
          </option>
          {choices.map((c) => (
            <option key={c.label} value={JSON.stringify(c.reference)}>
              {c.label}
            </option>
          ))}
        </select>
      )}
      {step.mapping?.kind === "object" && (
        <>
          {Object.entries(step.mapping.fields).map(([name, ref]) => (
            <div key={name}>
              {name}
              <select
                aria-label={`${name} source`}
                value={JSON.stringify(ref)}
                onChange={(e) => {
                  const choice = choices.find(
                    (c) => JSON.stringify(c.reference) === e.target.value,
                  );
                  if (choice)
                    onChange(withMappingField(step, name, choice.reference));
                }}
              >
                <option value={JSON.stringify(ref)}>
                  {choices.find(
                    (c) => JSON.stringify(c.reference) === JSON.stringify(ref),
                  )?.label ?? "Unavailable source"}
                </option>
                {choices.map((c) => (
                  <option key={c.label} value={JSON.stringify(c.reference)}>
                    {c.label}
                  </option>
                ))}
              </select>
              <button
                onClick={() => {
                  if (step.mapping?.kind === "object")
                    onChange({
                      ...step,
                      mapping: {
                        kind: "object",
                        fields: Object.fromEntries(
                          Object.entries(step.mapping.fields).filter(
                            ([k]) => k !== name,
                          ),
                        ),
                      },
                    });
                }}
              >
                Remove mapping
              </button>
            </div>
          ))}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              const choice = choices[Number(f.get("source"))];
              const name = String(f.get("name"));
              if (
                choice &&
                name &&
                !["__proto__", "constructor", "prototype"].includes(name)
              )
                onChange(withMappingField(step, name, choice.reference));
            }}
          >
            <input name="name" aria-label="Mapped field name" required />
            <select name="source" aria-label="Mapped field source">
              {choices.map((c, i) => (
                <option key={c.label} value={i}>
                  {c.label}
                </option>
              ))}
            </select>
            <button>Add mapping</button>
          </form>
        </>
      )}
    </fieldset>
  );
}
