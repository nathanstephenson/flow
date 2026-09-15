import { useState } from "react";
import { Button } from "./ui/button.tsx";
import { Input } from "./ui/input.tsx";
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
} from "../../../src/protocol/workflows.ts";
import {
  mappingChoices,
  withMappingField,
  workflowIssue,
} from "../presentation/workflows.ts";
export function MappingEditor({
  definition,
  step,
  onChange,
}: {
  definition: WorkflowDefinition;
  step: WorkflowStep;
  onChange: (s: WorkflowStep) => void;
}) {
  const [sourceIndex, setSourceIndex] = useState(0);
  let error = "";
  let choices: ReturnType<typeof mappingChoices> = [];
  try {
    choices = mappingChoices(
      definition,
      step.id,
      step.mapping?.kind ?? "reference",
    );
  } catch (e) {
    error = workflowIssue(e);
  }
  const reference =
    step.mapping?.kind === "reference" ? step.mapping.reference : undefined;
  const referenceLabel =
    choices.find(
      (c) => JSON.stringify(c.reference) === JSON.stringify(reference),
    )?.label ?? "Unavailable source";
  const selectedSource = choices[sourceIndex] ? sourceIndex : 0;
  return (
    <fieldset className="grid gap-3 rounded-lg border p-3">
      <legend className="px-1 text-sm font-medium">Input mapping</legend>
      <p className="text-xs text-muted-foreground">
        Only guaranteed completed step outputs are offered. Without a mapping,
        input comes from the preceding step.
      </p>
      {error && (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      )}
      <label className="flex flex-col gap-1">
        <span className="text-sm font-medium">Input mode</span>
        <Select
          value={step.mapping?.kind ?? "default"}
          onValueChange={(value) => {
            if (value === null) return;
            const next = { ...step };
            if (value === "default") delete next.mapping;
            else
              next.mapping =
                value === "object"
                  ? { kind: "object", fields: {} }
                  : {
                      kind: "reference",
                      reference: { source: "input", path: [] },
                    };
            onChange(next);
          }}
        >
          <SelectTrigger className="w-full" aria-label="Input mode">
            <SelectValue>
              {step.mapping?.kind === "object"
                ? "Combine named fields"
                : step.mapping?.kind === "reference"
                  ? "One source"
                  : "Preceding output"}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="default">Preceding output</SelectItem>
            <SelectItem value="reference">One source</SelectItem>
            <SelectItem value="object">Combine named fields</SelectItem>
          </SelectContent>
        </Select>
      </label>
      {step.mapping?.kind === "reference" && (
        <Select
          value={JSON.stringify(step.mapping.reference)}
          onValueChange={(value) => {
            const choice = choices.find(
              (c) => JSON.stringify(c.reference) === value,
            );
            if (choice)
              onChange({
                ...step,
                mapping: { kind: "reference", reference: choice.reference },
              });
          }}
        >
          <SelectTrigger className="w-full" aria-label="Input source">
            <SelectValue>{referenceLabel}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={JSON.stringify(step.mapping.reference)}>
              {referenceLabel}
            </SelectItem>
            {choices
              .filter(
                (c) =>
                  JSON.stringify(c.reference) !==
                  JSON.stringify(
                    step.mapping?.kind === "reference"
                      ? step.mapping.reference
                      : null,
                  ),
              )
              .map((c) => (
                <SelectItem key={c.label} value={JSON.stringify(c.reference)}>
                  {c.label}
                </SelectItem>
              ))}
          </SelectContent>
        </Select>
      )}
      {step.mapping?.kind === "object" && (
        <>
          {Object.entries(step.mapping.fields).map(([name, ref]) => (
            <div key={name} className="grid gap-2">
              <span className="text-sm font-medium">{name}</span>
              <Select
                value={JSON.stringify(ref)}
                onValueChange={(value) => {
                  const choice = choices.find(
                    (c) => JSON.stringify(c.reference) === value,
                  );
                  if (choice)
                    onChange(withMappingField(step, name, choice.reference));
                }}
              >
                <SelectTrigger className="w-full" aria-label={`${name} source`}>
                  <SelectValue>
                    {choices.find(
                      (c) =>
                        JSON.stringify(c.reference) === JSON.stringify(ref),
                    )?.label ?? "Unavailable source"}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={JSON.stringify(ref)}>
                    {choices.find(
                      (c) =>
                        JSON.stringify(c.reference) === JSON.stringify(ref),
                    )?.label ?? "Unavailable source"}
                  </SelectItem>
                  {choices
                    .filter(
                      (c) =>
                        JSON.stringify(c.reference) !== JSON.stringify(ref),
                    )
                    .map((c) => (
                      <SelectItem
                        key={c.label}
                        value={JSON.stringify(c.reference)}
                      >
                        {c.label}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
              <Button
                size="sm"
                variant="destructive"
                className="justify-self-start"
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
              </Button>
            </div>
          ))}
          <form
            className="grid gap-2"
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
            <Input
              name="name"
              aria-label="Mapped field name"
              placeholder="Field name"
              required
            />
            <Select
              name="source"
              value={choices.length ? selectedSource : null}
              onValueChange={(value) => value !== null && setSourceIndex(value)}
            >
              <SelectTrigger
                className="w-full"
                aria-label="Mapped field source"
              >
                <SelectValue>
                  {choices[selectedSource]?.label ?? "Select source"}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {choices.map((c, i) => (
                  <SelectItem key={c.label} value={i}>
                    {c.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              type="submit"
              size="sm"
              variant="outline"
              className="justify-self-start"
            >
              Add mapping
            </Button>
          </form>
        </>
      )}
    </fieldset>
  );
}
