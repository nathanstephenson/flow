import { JsonValueEditor } from "./workflow-json-schema.tsx";
import { useState } from "react";
import type { Json, VisualSchema } from "../../../src/protocol/workflows.ts";
import { Button } from "./ui/button.tsx";
import { Input } from "./ui/input.tsx";
import { Textarea } from "./ui/textarea.tsx";
import { Switch } from "./ui/switch.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select.tsx";
import { emptySchema, initialValue } from "../presentation/workflow-schema.ts";
export { emptySchema, initialValue } from "../presentation/workflow-schema.ts";

export function ValueEditor({
  schema,
  value,
  onChange,
  onClear,
  label = "Value",
}: {
  schema: VisualSchema;
  value: Json | undefined;
  onChange: (value: Json) => void;
  onClear?: () => void;
  label?: string;
}) {
  const [variant, setVariant] = useState(0);
  if (schema.type === "json") return <JsonValueEditor schema={schema.schema ?? true} value={value ?? null} label={label} onChange={onChange} />;
  if (schema.type === "null") return <span className="text-xs text-muted-foreground">null</span>;
  if (schema.type === "object") {
    const fields =
      value && typeof value === "object" && !Array.isArray(value) ? value : {};
    return (
      <div className="grid gap-3">
        {Object.entries(schema.fields).map(([name, field]) => (
          <div key={name} className="grid gap-2">
            <span className="text-sm font-medium">
              {name}
              {field.required ? " *" : ""}
            </span>
            {!field.required && (
              <label className="flex items-center gap-2 text-sm">
                <Switch
                  aria-label={`Include ${name}`}
                  checked={Object.hasOwn(fields, name)}
                  onCheckedChange={(checked) => {
                    const next = { ...fields };
                    if (checked)
                      next[name] = field.default ?? initialValue(field.schema);
                    else delete next[name];
                    onChange(next);
                  }}
                />
                Include
              </label>
            )}
            <ValueEditor
              schema={field.schema}
              label={label === "Value" ? name : `${label}.${name}`}
              value={fields[name] ?? field.default}
              onClear={() => {
                const next = { ...fields };
                delete next[name];
                onChange(next);
              }}
              onChange={(v) => onChange({ ...fields, [name]: v })}
            />
          </div>
        ))}
      </div>
    );
  }
  if (schema.type === "array")
    return (
      <div className="grid gap-2">
        {(Array.isArray(value) ? value : []).map((v, i) => (
          <div key={i} className="grid gap-2 rounded-lg border p-3">
            <ValueEditor
              schema={schema.items}
              label={`${label} item ${i + 1}`}
              value={v}
              onChange={(next) =>
                onChange(
                  (value as Json[]).map((old, n) => (n === i ? next : old)),
                )
              }
            />
            <Button
              size="sm"
              variant="destructive"
              className="justify-self-start"
              onClick={() =>
                onChange((value as Json[]).filter((_, n) => n !== i))
              }
            >
              Remove item
            </Button>
          </div>
        ))}
        <Button
          size="sm"
          variant="outline"
          className="justify-self-start"
          onClick={() =>
            onChange([
              ...(Array.isArray(value) ? value : []),
              initialValue(schema.items),
            ])
          }
        >
          Add item
        </Button>
      </div>
    );
  if (schema.type === "union")
    return (
      <div className="grid gap-2">
        <Select
          value={variant}
          onValueChange={(index) => {
            if (index === null) return;
            setVariant(index);
            onChange(initialValue(schema.variants[index]!));
          }}
        >
          <SelectTrigger
            className="w-full"
            aria-label={
              label === "Value" ? "Input variant" : `${label} variant`
            }
          >
            <SelectValue>{`Variant ${variant + 1}: ${schema.variants[variant]?.type ?? ""}`}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {schema.variants.map((s, i) => (
              <SelectItem key={i} value={i}>
                Variant {i + 1}: {s.type}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <ValueEditor
          schema={schema.variants[variant] ?? schema.variants[0]!}
          label={label}
          value={value}
          onChange={onChange}
        />
      </div>
    );
  if (schema.type === "boolean")
    return (
      <Switch
        aria-label={label}
        checked={value === true}
        onCheckedChange={onChange}
      />
    );
  if (schema.type === "enum")
    return (
      <Select
        value={typeof value === "string" ? value : ""}
        onValueChange={(next) => {
          if (next !== null) onChange(next);
        }}
      >
        <SelectTrigger className="w-full" aria-label={label}>
          <SelectValue>
            {typeof value === "string" && value ? value : "Select"}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          {!schema.values.includes("") && (
            <SelectItem value="">Select</SelectItem>
          )}
          {schema.values.map((v) => (
            <SelectItem key={v} value={v}>
              {v || "Empty string"}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  return (
    <Input
      aria-label={label}
      type={schema.type === "number" ? "number" : "text"}
      value={
        typeof value === "string" || typeof value === "number" ? value : ""
      }
      onChange={(e) =>
        schema.type === "number" && e.target.value === "" && onClear
          ? onClear()
          : onChange(
              schema.type === "number"
                ? e.target.value === ""
                  ? null
                  : Number(e.target.value)
                : e.target.value,
            )
      }
    />
  );
}

export function SchemaEditor({
  schema,
  onChange,
  root = false,
}: {
  schema: VisualSchema;
  onChange: (schema: VisualSchema) => void;
  root?: boolean;
}) {
  return (
    <fieldset className="grid min-w-0 gap-3 rounded-lg border p-3">
      <legend className="px-1 text-sm font-medium">Schema</legend>
      {!root && (
        <Select
          value={schema.type}
          onValueChange={(value) => {
            if (value !== null)
              onChange(emptySchema(value as VisualSchema["type"]));
          }}
        >
          <SelectTrigger className="w-full" aria-label="Schema type">
            <SelectValue>{schema.type}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {["object", "array", "string", "number", "boolean", "enum", "json", "null"].map(
              (t) => (
                <SelectItem key={t} value={t}>
                  {t}
                </SelectItem>
              ),
            )}
          </SelectContent>
        </Select>
      )}
      {schema.type === "enum" && (
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Values (one per line)</span>
          <Textarea
            value={schema.values.join("\n")}
            onChange={(e) =>
              onChange({ ...schema, values: e.target.value.split("\n") })
            }
          />
        </label>
      )}
      {schema.type === "array" && (
        <SchemaEditor
          schema={schema.items}
          onChange={(items) => onChange({ ...schema, items })}
        />
      )}
      {schema.type === "object" && (
        <>
          {Object.entries(schema.fields).map(([name, field]) => (
            <fieldset
              key={name}
              className="grid min-w-0 gap-3 rounded-lg border p-3"
            >
              <legend className="px-1 text-sm font-medium">{name}</legend>
              <Button
                size="sm"
                variant="destructive"
                className="justify-self-start"
                onClick={() =>
                  onChange({
                    ...schema,
                    fields: Object.fromEntries(
                      Object.entries(schema.fields).filter(([k]) => k !== name),
                    ),
                  })
                }
              >
                Remove field
              </Button>
              <label className="flex items-center gap-2 text-sm">
                <Switch
                  checked={!!field.required}
                  onCheckedChange={(checked) =>
                    onChange({
                      ...schema,
                      fields: {
                        ...schema.fields,
                        [name]: { ...field, required: checked },
                      },
                    })
                  }
                />
                Required
              </label>
              <SchemaEditor
                schema={field.schema}
                onChange={(s) =>
                  onChange({
                    ...schema,
                    fields: {
                      ...schema.fields,
                      [name]: { ...field, schema: s },
                    },
                  })
                }
              />
              <label className="flex items-center gap-2 text-sm">
                <Switch
                  checked={field.default !== undefined}
                  onCheckedChange={(checked) => {
                    const next = { ...field };
                    if (checked) next.default = initialValue(field.schema);
                    else delete next.default;
                    onChange({
                      ...schema,
                      fields: { ...schema.fields, [name]: next },
                    });
                  }}
                />
                Default
              </label>
              {field.default !== undefined && (
                <ValueEditor
                  schema={field.schema}
                  value={field.default}
                  onChange={(v) =>
                    onChange({
                      ...schema,
                      fields: {
                        ...schema.fields,
                        [name]: { ...field, default: v },
                      },
                    })
                  }
                />
              )}
            </fieldset>
          ))}
          <form
            className="flex flex-wrap items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              const form = e.currentTarget;
              const name = String(new FormData(form).get("field"));
              if (
                name &&
                !["__proto__", "constructor", "prototype"].includes(name) &&
                !schema.fields[name]
              ) {
                onChange({
                  ...schema,
                  fields: {
                    ...schema.fields,
                    [name]: { schema: { type: "string" } },
                  },
                });
                form.reset();
              }
            }}
          >
            <Input
              className="min-w-0 flex-1"
              name="field"
              aria-label="New field name"
              placeholder="Field name"
              required
            />
            <Button type="submit" size="sm" variant="outline">
              Add field
            </Button>
          </form>
        </>
      )}
    </fieldset>
  );
}
