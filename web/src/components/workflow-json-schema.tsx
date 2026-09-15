import { useState } from "react";
import type {
  ArgumentTemplate,
  InputReference,
  Json,
  JsonSchema,
} from "../../../src/protocol/workflows.ts";
import {
  schemaHints,
  conditionalHints,
  propertyHints,
  asSchema,
  initialTemplate,
  templateValue,
  valueTemplate,
} from "../presentation/workflow-json-schema.ts";
import { Button } from "./ui/button.tsx";
import { Input } from "./ui/input.tsx";
import { Switch } from "./ui/switch.tsx";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "./ui/select.tsx";

function arrayItemSchema(schema: Record<string, Json>, index: number): JsonSchema {
  return asSchema(
    Array.isArray(schema.prefixItems)
      ? (schema.prefixItems[index] ?? schema.items)
      : Array.isArray(schema.items)
        ? (schema.items[index] ?? schema.additionalItems)
        : schema.items,
  );
}

type Choice = { label: string; reference: InputReference };
export function JsonSchemaEditor({
  schema,
  root = schema,
  template,
  onChange,
  choices = [],
  label = "Arguments",
  depth = 0,
}: {
  schema: JsonSchema;
  root?: JsonSchema;
  template: ArgumentTemplate;
  onChange: (value: ArgumentTemplate) => void;
  choices?: Choice[];
  label?: string;
  depth?: number;
}) {
  const [property, setProperty] = useState("");
  const [variant, setVariant] = useState(0);
  const hints = conditionalHints(
    schemaHints(schema, root),
    root,
    templateValue(template),
  );
  const alternatives = Array.isArray(hints.oneOf)
    ? hints.oneOf
    : Array.isArray(hints.anyOf)
      ? hints.anyOf
      : Array.isArray(hints.type)
        ? hints.type.map((type) => ({ type }))
        : [];
  const variantHints = alternatives.length
    ? schemaHints(asSchema(alternatives[variant]), root)
    : {};
  const effective: Record<string, Json> = {
    ...hints,
    ...variantHints,
    properties: { ...propertyHints(hints), ...propertyHints(variantHints) },
  };
  const properties = propertyHints(effective);
  const value = templateValue(template);
  const type =
    template.kind === "object"
      ? "object"
      : template.kind === "array"
        ? "array"
        : value === null
          ? "null"
          : typeof value;
  const nested = (
    child: JsonSchema,
    node: ArgumentTemplate,
    change: (value: ArgumentTemplate) => void,
    name: string,
  ) => (
    <JsonSchemaEditor
      schema={child}
      root={root}
      template={node}
      onChange={change}
      choices={choices}
      label={name}
      depth={depth + 1}
    />
  );
  return (
    <fieldset className="grid min-w-0 gap-3 rounded-lg border p-3">
      <legend className="px-1 text-sm font-medium">{label}</legend>
      {typeof effective.description === "string" && (
        <p className="text-xs text-muted-foreground">{effective.description}</p>
      )}
      {choices.length > 0 && (
        <Select
          value={
            template.kind === "reference"
              ? JSON.stringify(template.reference)
              : "literal"
          }
          onValueChange={(value) => {
            if (value === "literal") onChange(initialTemplate(schema, root));
            else {
              const choice = choices.find(
                (choice) => JSON.stringify(choice.reference) === value,
              );
              if (choice)
                onChange({ kind: "reference", reference: choice.reference });
            }
          }}
        >
          <SelectTrigger aria-label={`${label} source`}>
            <SelectValue>
              {template.kind === "reference"
                ? (choices.find(
                    (choice) =>
                      JSON.stringify(choice.reference) ===
                      JSON.stringify(template.reference),
                  )?.label ?? "Unavailable reference")
                : "Literal value"}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="literal">Literal value</SelectItem>
            {choices.map((choice) => (
              <SelectItem
                key={choice.label}
                value={JSON.stringify(choice.reference)}
              >
                {choice.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      {template.kind !== "reference" && (
        <>
          {alternatives.length > 0 && (
            <Select
              value={variant}
              onValueChange={(index) => {
                if (index !== null) {
                  setVariant(index);
                  onChange(
                    initialTemplate(asSchema(alternatives[index]), root),
                  );
                }
              }}
            >
              <SelectTrigger aria-label={`${label} variant`}>
                <SelectValue>Variant {variant + 1}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {alternatives.map((_, index) => (
                  <SelectItem key={index} value={index}>
                    Variant {index + 1}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <Select
            value={type}
            onValueChange={(type) => {
              if (type) onChange(initialTemplate({ type }));
            }}
          >
            <SelectTrigger aria-label={`${label} JSON type`}>
              <SelectValue>{type}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {["object", "array", "string", "number", "boolean", "null"].map(
                (type) => (
                  <SelectItem key={type} value={type}>
                    {type}
                  </SelectItem>
                ),
              )}
            </SelectContent>
          </Select>
          {Array.isArray(effective.enum) && (
            <Select
              value={JSON.stringify(value)}
              onValueChange={(v) => {
                if (v) onChange(valueTemplate(JSON.parse(v)));
              }}
            >
              <SelectTrigger aria-label={`${label} enum`}>
                <SelectValue>{JSON.stringify(value)}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {effective.enum.map((value, index) => (
                  <SelectItem key={index} value={JSON.stringify(value)}>
                    {JSON.stringify(value)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          {template.kind === "object" && (
            <>
              {[
                ...new Set([
                  ...Object.keys(properties),
                  ...Object.keys(template.fields),
                ]),
              ].map((key) => {
                const field = Object.hasOwn(template.fields, key)
                  ? template.fields[key]
                  : undefined;
                const patternSchemas =
                  effective.patternProperties &&
                  typeof effective.patternProperties === "object" &&
                  !Array.isArray(effective.patternProperties)
                    ? Object.entries(effective.patternProperties)
                        .filter(([pattern]) => {
                          try {
                            return new RegExp(pattern).test(key);
                          } catch {
                            return false;
                          }
                        })
                        .map(([, schema]) => schema)
                    : [];
                const child = asSchema(
                  Object.hasOwn(properties, key)
                    ? properties[key]
                    : patternSchemas.length
                      ? { allOf: patternSchemas }
                      : effective.additionalProperties,
                );
                return (
                  <div key={key} className="grid gap-2">
                    <label className="flex items-center gap-2 text-sm">
                      <Switch
                        aria-label={`Include ${label}.${key}`}
                        checked={!!field}
                        onCheckedChange={(checked) => {
                          const fields = { ...template.fields };
                          if (checked)
                            fields[key] = initialTemplate(child, root);
                          else delete fields[key];
                          onChange({ kind: "object", fields });
                        }}
                      />
                      {key}
                      {Array.isArray(effective.required) &&
                      effective.required.includes(key)
                        ? " *"
                        : ""}
                    </label>
                    {field &&
                      nested(
                        child,
                        field,
                        (value) =>
                          onChange({
                            kind: "object",
                            fields: { ...template.fields, [key]: value },
                          }),
                        `${label}.${key}`,
                      )}
                  </div>
                );
              })}
              <div className="flex gap-2">
                <Input
                  aria-label={`${label} new property`}
                  placeholder="Additional property name"
                  value={property}
                  onChange={(e) => setProperty(e.target.value)}
                />
                <Button
                  variant="outline"
                  size="sm"
                  disabled={
                    !property ||
                    ["__proto__", "constructor", "prototype"].includes(property)
                  }
                  onClick={() => {
                    onChange({
                      kind: "object",
                      fields: {
                        ...template.fields,
                        [property]: initialTemplate(
                          asSchema(effective.additionalProperties),
                          root,
                        ),
                      },
                    });
                    setProperty("");
                  }}
                >
                  Add property
                </Button>
              </div>
            </>
          )}
          {template.kind === "array" && (
            <>
              {template.items.map((item, index) => (
                <div key={index} className="grid gap-2">
                  {nested(
                    arrayItemSchema(effective, index),
                    item,
                    (value) =>
                      onChange({
                        kind: "array",
                        items: template.items.map((old, i) =>
                          i === index ? value : old,
                        ),
                      }),
                    `${label}[${index}]`,
                  )}
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      onChange({
                        kind: "array",
                        items: template.items.filter((_, i) => i !== index),
                      })
                    }
                  >
                    Remove item
                  </Button>
                </div>
              ))}
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  const index = template.items.length;
                  onChange({
                    kind: "array",
                    items: [
                      ...template.items,
                      initialTemplate(
                        arrayItemSchema(effective, index),
                        root,
                      ),
                    ],
                  });
                }}
              >
                Add item
              </Button>
            </>
          )}
          {template.kind === "literal" && type === "boolean" && (
            <Switch
              aria-label={label}
              checked={value === true}
              onCheckedChange={(value) => onChange({ kind: "literal", value })}
            />
          )}
          {template.kind === "literal" &&
            (type === "string" || type === "number") && (
              <Input
                aria-label={label}
                type={type === "number" ? "number" : "text"}
                value={value as string | number}
                onChange={(e) =>
                  onChange({
                    kind: "literal",
                    value:
                      type === "number"
                        ? Number(e.target.value)
                        : e.target.value,
                  })
                }
              />
            )}
        </>
      )}
      <details className="text-xs text-muted-foreground">
        <summary>Original schema and constraints</summary>
        <pre className="overflow-auto whitespace-pre-wrap">
          {JSON.stringify(schema, null, 2)}
        </pre>
      </details>
    </fieldset>
  );
}

export function JsonValueEditor({
  schema,
  value,
  onChange,
  label,
}: {
  schema: JsonSchema;
  value: Json;
  onChange: (value: Json) => void;
  label: string;
}) {
  return (
    <JsonSchemaEditor
      schema={schema}
      template={valueTemplate(value)}
      label={label}
      onChange={(template) => {
        const value = templateValue(template);
        if (value !== undefined) onChange(value);
      }}
    />
  );
}
