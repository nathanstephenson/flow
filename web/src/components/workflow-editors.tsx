import { useState } from "react";
import type { Json, VisualSchema } from "../../../src/protocol/workflows.ts";

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
  if (schema.type === "object")
    return (
      <div className="grid gap-2">
        {Object.entries(schema.fields).map(([name, field]) => (
          <div key={name}>
            <span>
              {name}
              {field.required ? " *" : ""}
            </span>
            {!field.required && (
              <label>
                <input
                  type="checkbox"
                  aria-label={`Include ${name}`}
                  checked={
                    !!value &&
                    typeof value === "object" &&
                    !Array.isArray(value) &&
                    Object.hasOwn(value, name)
                  }
                  onChange={(e) => {
                    const next = {
                      ...(value &&
                      typeof value === "object" &&
                      !Array.isArray(value)
                        ? value
                        : {}),
                    };
                    if (e.target.checked)
                      next[name] = field.default ?? initialValue(field.schema);
                    else delete next[name];
                    onChange(next);
                  }}
                />
                Include
              </label>
            )}
            <ValueEditor
              onClear={() => {
                const next = {
                  ...(value &&
                  typeof value === "object" &&
                  !Array.isArray(value)
                    ? value
                    : {}),
                };
                delete next[name];
                onChange(next);
              }}
              schema={field.schema}
              label={label === "Value" ? name : `${label}.${name}`}
              value={
                (value && typeof value === "object" && !Array.isArray(value)
                  ? value[name]
                  : undefined) ?? field.default
              }
              onChange={(v) =>
                onChange({
                  ...(value &&
                  typeof value === "object" &&
                  !Array.isArray(value)
                    ? value
                    : {}),
                  [name]: v,
                })
              }
            />
          </div>
        ))}
      </div>
    );
  if (schema.type === "array")
    return (
      <div>
        {(Array.isArray(value) ? value : []).map((v, i) => (
          <div key={i}>
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
            <button
              onClick={() =>
                onChange((value as Json[]).filter((_, n) => n !== i))
              }
            >
              Remove item
            </button>
          </div>
        ))}
        <button
          onClick={() =>
            onChange([
              ...(Array.isArray(value) ? value : []),
              initialValue(schema.items),
            ])
          }
        >
          Add item
        </button>
      </div>
    );
  if (schema.type === "union")
    return (
      <div>
        <select
          aria-label={label === "Value" ? "Input variant" : `${label} variant`}
          value={variant}
          onChange={(e) => {
            const index = Number(e.target.value);
            setVariant(index);
            onChange(initialValue(schema.variants[index]!));
          }}
        >
          {schema.variants.map((s, i) => (
            <option key={i} value={i}>
              Variant {i + 1}: {s.type}
            </option>
          ))}
        </select>
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
      <input
        type="checkbox"
        aria-label={label}
        checked={value === true}
        onChange={(e) => onChange(e.target.checked)}
      />
    );
  if (schema.type === "enum")
    return (
      <select
        aria-label={label}
        value={typeof value === "string" ? value : ""}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">Select</option>
        {schema.values.map((v) => (
          <option key={v}>{v}</option>
        ))}
      </select>
    );
  return (
    <input
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
    <fieldset className="border rounded p-2 grid gap-2">
      <legend>Schema</legend>
      {!root && (
        <select
          aria-label="Schema type"
          value={schema.type}
          onChange={(e) =>
            onChange(emptySchema(e.target.value as VisualSchema["type"]))
          }
        >
          {["object", "array", "string", "number", "boolean", "enum"].map(
            (t) => (
              <option key={t}>{t}</option>
            ),
          )}
        </select>
      )}
      {schema.type === "enum" && (
        <label>
          Values (one per line)
          <textarea
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
            <fieldset key={name} className="border p-2">
              <legend>{name}</legend>
              <button
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
              </button>
              <label>
                <input
                  type="checkbox"
                  checked={!!field.required}
                  onChange={(e) =>
                    onChange({
                      ...schema,
                      fields: {
                        ...schema.fields,
                        [name]: { ...field, required: e.target.checked },
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
              <label>
                <input
                  type="checkbox"
                  checked={field.default !== undefined}
                  onChange={(e) => {
                    const next = { ...field };
                    if (e.target.checked)
                      next.default = initialValue(field.schema);
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
            <input name="field" aria-label="New field name" required />
            <button>Add field</button>
          </form>
        </>
      )}
    </fieldset>
  );
}
