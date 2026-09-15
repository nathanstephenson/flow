import type { Json, VisualSchema } from "../../../src/protocol/workflows.ts";
export function emptySchema(type: VisualSchema["type"]): VisualSchema {
  if (type === "object") return { type, fields: {} };
  if (type === "array") return { type, items: { type: "string" } };
  if (type === "enum") return { type, values: ["value"] };
  if (type === "union") return { type, variants: [{ type: "string" }] };
  return { type };
}
export function initialValue(schema: VisualSchema): Json {
  switch (schema.type) {
    case "json": return {};
    case "null": return null;
    case "object":
      return Object.fromEntries(
        Object.entries(schema.fields)
          .filter(([, f]) => f.required || f.default !== undefined)
          .map(([k, f]) => [k, f.default ?? initialValue(f.schema)]),
      );
    case "array":
      return [];
    case "number":
      return 0;
    case "boolean":
      return false;
    case "enum":
      return schema.values[0] ?? "";
    case "union":
      return initialValue(schema.variants[0]!);
    default:
      return "";
  }
}
