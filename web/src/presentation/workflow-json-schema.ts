import { validateJsonSchema } from "../../../src/workflows/json-schema.ts";
import type {
  ArgumentTemplate,
  Json,
  JsonSchema,
} from "../../../src/protocol/workflows.ts";
export const asSchema = (value: Json | undefined): JsonSchema =>
  typeof value === "boolean" ||
  (value !== null && typeof value === "object" && !Array.isArray(value))
    ? (value as JsonSchema)
    : true;
export function schemaHints(
  schema: JsonSchema,
  root: JsonSchema,
  seen = new Set<string>(),
): Record<string, Json> {
  if (typeof schema === "boolean") return {};
  let hints = { ...schema };
  if (
    typeof schema.$ref === "string" &&
    schema.$ref.startsWith("#/") &&
    !seen.has(schema.$ref)
  ) {
    seen.add(schema.$ref);
    let target: Json = root;
    for (const part of schema.$ref
      .slice(2)
      .split("/")
      .map((key) => key.replace(/~1/g, "/").replace(/~0/g, "~"))) {
      target =
        target && typeof target === "object" && !Array.isArray(target)
          ? (target[part] ?? true)
          : true;
    }
    hints = { ...schemaHints(asSchema(target), root, seen), ...hints };
  }
  for (const branch of Array.isArray(schema.allOf) ? schema.allOf : []) {
    const other = schemaHints(asSchema(branch), root, new Set(seen));
    hints = {
      ...other,
      ...hints,
      properties: { ...propertyHints(other), ...propertyHints(hints) },
      required: [
        ...new Set([
          ...(Array.isArray(other.required) ? other.required : []),
          ...(Array.isArray(hints.required) ? hints.required : []),
        ]),
      ],
    };
  }
  return hints;
}
export function propertyHints(
  schema: Record<string, Json>,
): Record<string, Json> {
  return schema.properties &&
    typeof schema.properties === "object" &&
    !Array.isArray(schema.properties)
    ? schema.properties
    : {};
}
export function templateValue(template: ArgumentTemplate): Json | undefined {
  if (template.kind === "reference") return undefined;
  if (template.kind === "literal") return template.value;
  if (template.kind === "array") {
    const values = template.items.map(templateValue);
    return values.some((value) => value === undefined)
      ? undefined
      : (values as Json[]);
  }
  const entries = Object.entries(template.fields).map(
    ([key, value]) => [key, templateValue(value)] as const,
  );
  return entries.some(([, value]) => value === undefined)
    ? undefined
    : (Object.fromEntries(entries) as Json);
}
export function valueTemplate(value: Json): ArgumentTemplate {
  if (Array.isArray(value))
    return { kind: "array", items: value.map(valueTemplate) };
  if (value && typeof value === "object")
    return {
      kind: "object",
      fields: Object.fromEntries(
        Object.entries(value).map(([key, value]) => [
          key,
          valueTemplate(value),
        ]),
      ),
    };
  return { kind: "literal", value };
}
export function initialTemplate(
  schema: JsonSchema,
  root = schema,
): ArgumentTemplate {
  const hints = schemaHints(schema, root);
  if (hints.default !== undefined || hints.const !== undefined)
    return valueTemplate(hints.default ?? hints.const ?? null);
  if (Array.isArray(hints.enum) && hints.enum.length)
    return valueTemplate(hints.enum[0]!);
  if (hints.type === "object" || hints.properties)
    return { kind: "object", fields: {} };
  if (hints.type === "array") return { kind: "array", items: [] };
  return {
    kind: "literal",
    value:
      hints.type === "null"
        ? null
        : hints.type === "boolean"
          ? false
          : hints.type === "number" || hints.type === "integer"
            ? 0
            : "",
  };
}

/** Conditional/dependent schemas affect discoverable fields, never the authoritative validator. */
export function conditionalHints(
  hints: Record<string, Json>,
  root: JsonSchema,
  value: Json | undefined,
): Record<string, Json> {
  const selected: JsonSchema[] = [];
  const object =
    value && typeof value === "object" && !Array.isArray(value) ? value : {};
  if (hints.if !== undefined && value !== undefined) {
    let matches = false;
    try {
      const condition = asSchema(hints.if);
      validateJsonSchema(
        typeof condition === "boolean"
          ? condition
          : {
              ...(typeof root === "object" && root.$defs
                ? { $defs: root.$defs }
                : {}),
              ...(typeof root === "object" && root.definitions
                ? { definitions: root.definitions }
                : {}),
              ...condition,
            },
        value,
      );
      matches = true;
    } catch {
      /* Only drives presentation. Full validation reports authoritative errors. */
    }
    selected.push(asSchema(matches ? hints.then : hints.else));
  }
  for (const keyword of ["dependentSchemas", "dependencies"]) {
    const dependencies = hints[keyword];
    if (
      dependencies &&
      typeof dependencies === "object" &&
      !Array.isArray(dependencies)
    )
      for (const [key, dependency] of Object.entries(dependencies)) {
        if (Object.hasOwn(object, key) && !Array.isArray(dependency))
          selected.push(asSchema(dependency));
      }
  }
  return selected.reduce<Record<string, Json>>((result, schema) => {
    const more = schemaHints(schema, root);
    return {
      ...result,
      ...more,
      properties: { ...propertyHints(result), ...propertyHints(more) },
      required: [
        ...new Set([
          ...(Array.isArray(result.required) ? result.required : []),
          ...(Array.isArray(more.required) ? more.required : []),
        ]),
      ],
    };
  }, hints);
}
