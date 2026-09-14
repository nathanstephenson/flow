import { z } from 'zod';
import type { Json, VisualSchema, WorkflowStep } from '../protocol/workflows.ts';

export const dictionaryKey = z.string().refine(key => !['__proto__', 'constructor', 'prototype'].includes(key), 'Reserved dictionary key');

export function dictionaryRecord<T extends z.ZodType>(value: T) {
  return z.unknown().superRefine((input, context) => {
    if (input && typeof input === 'object') {
      for (const key of Object.keys(input)) {
        if (!dictionaryKey.safeParse(key).success) context.addIssue({ code: 'custom', message: 'Reserved dictionary key', path: [key] });
      }
    }
  }).pipe(z.record(dictionaryKey, value));
}

const jsonSchema: z.ZodType<Json> = z.lazy(() => z.union([z.null(), z.boolean(), z.number(), z.string(), z.array(jsonSchema), z.record(z.string(), jsonSchema)]));
export const visualSchemaValidator: z.ZodType<VisualSchema> = z.lazy(() => z.discriminatedUnion('type', [
  z.object({ type: z.literal('string') }).strict(),
  z.object({ type: z.literal('number'), integer: z.boolean().optional() }).strict(),
  z.object({ type: z.literal('boolean') }).strict(),
  z.object({ type: z.literal('enum'), values: z.array(z.string()).min(1).refine(values => new Set(values).size === values.length) }).strict(),
  z.object({ type: z.literal('array'), items: visualSchemaValidator }).strict(),
  z.object({ type: z.literal('union'), variants: z.array(visualSchemaValidator).min(2) }).strict(),
  z.object({ type: z.literal('object'), fields: dictionaryRecord(z.object({ schema: visualSchemaValidator, required: z.boolean().optional(), default: jsonSchema.optional() }).strict()) }).strict(),
])) as z.ZodType<VisualSchema>;

export function toZod(schema: VisualSchema): z.ZodType {
  switch (schema.type) {
    case 'string': return z.string();
    case 'number': return schema.integer ? z.number().int() : z.number();
    case 'boolean': return z.boolean();
    case 'enum': return z.enum(schema.values as [string, ...string[]]);
    case 'array': return z.array(toZod(schema.items));
    case 'union': return z.union(schema.variants.map(toZod));
    case 'object': return z.object(Object.fromEntries(Object.entries(schema.fields).map(([key, field]) => {
      let validator = toZod(field.schema);
      if (field.default !== undefined) validator = validator.default(parseValue(field.schema, field.default));
      else if (!field.required) validator = validator.optional();
      return [key, validator];
    }))).strict();
  }
}

export function parseValue(schema: VisualSchema, value: unknown): Json {
  return jsonSchema.parse(toZod(schema).parse(value));
}

export function validateSchema(schema: VisualSchema): void {
  visualSchemaValidator.parse(schema);
  toZod(schema);
}

export function toTypeScript(schema: VisualSchema): string {
  switch (schema.type) {
    case 'enum': return schema.values.map(value => JSON.stringify(value)).join(' | ');
    case 'array': return `Array<${toTypeScript(schema.items)}>`;
    case 'union': return schema.variants.map(toTypeScript).join(' | ');
    case 'object': return `{ ${Object.entries(schema.fields).map(([name, field]) => `${JSON.stringify(name)}${field.required || field.default !== undefined ? '' : '?'}: ${toTypeScript(field.schema)}`).join('; ')} }`;
    default: return schema.type;
  }
}

export const shellOutputSchema: VisualSchema = { type: 'object', fields: {
  exitCode: { schema: { type: 'number', integer: true }, required: true },
  stdout: { schema: { type: 'string' }, required: true },
  stderr: { schema: { type: 'string' }, required: true },
} };

export function declaredOutputSchema(step: WorkflowStep): VisualSchema | undefined {
  if (step.kind === 'shell') return shellOutputSchema;
  if (step.kind === 'branch') return { type: 'boolean' };
  if (step.kind === 'join') return undefined;
  return step.outputSchema;
}

export function schemaAt(schema: VisualSchema, path: string[]): { schema: VisualSchema; optional: boolean } {
  if (!path.length) return { schema, optional: false };
  if (schema.type === 'union') {
    const fields = schema.variants.map(variant => schemaAt(variant, path));
    return { schema: unionSchema(fields.map(field => field.schema)), optional: fields.some(field => field.optional) };
  }
  const [key, ...rest] = path as [string, ...string[]];
  if (schema.type === 'object') {
    const field = Object.hasOwn(schema.fields, key) ? schema.fields[key] : undefined;
    if (!field) throw new Error(`Unknown field: ${key}`);
    const nested = schemaAt(field.schema, rest);
    return { schema: nested.schema, optional: nested.optional || (!field.required && field.default === undefined) };
  }
  if (schema.type === 'array' && /^(0|[1-9]\d*)$/.test(key)) return { schema: schemaAt(schema.items, rest).schema, optional: true };
  throw new Error(`Invalid field path: ${key}`);
}

export function schemaAssignable(source: VisualSchema, target: VisualSchema): boolean {
  if (source.type === 'union') return source.variants.every(variant => schemaAssignable(variant, target));
  if (target.type === 'union') return target.variants.some(variant => schemaAssignable(source, variant));
  if (source.type === 'enum') return target.type === 'string' || (target.type === 'enum' && source.values.every(value => target.values.includes(value)));
  if (source.type !== target.type) return false;
  if (source.type === 'number' && target.type === 'number') return !target.integer || !!source.integer;
  if (source.type === 'array' && target.type === 'array') return schemaAssignable(source.items, target.items);
  if (source.type === 'object' && target.type === 'object') {
    return Object.keys(source.fields).every(name => Object.hasOwn(target.fields, name)) && Object.entries(target.fields).every(([name, field]) => {
      const supplied = Object.hasOwn(source.fields, name) ? source.fields[name] : undefined;
      const required = field.required && field.default === undefined;
      if (!supplied) return !required;
      return (!required || supplied.required || supplied.default !== undefined) && schemaAssignable(supplied.schema, field.schema);
    });
  }
  return true;
}

export function partialSchema(schema: VisualSchema): VisualSchema {
  if (schema.type === 'object') return { type: 'object', fields: Object.fromEntries(Object.entries(schema.fields).map(([name, field]) => [name, { schema: partialSchema(field.schema) }])) };
  if (schema.type === 'array') return { type: 'array', items: partialSchema(schema.items) };
  if (schema.type === 'union') return unionSchema(schema.variants.map(partialSchema));
  return schema;
}

export function unionSchema(schemas: VisualSchema[]): VisualSchema {
  const unique = [...new Map(schemas.map(schema => [JSON.stringify(schema), schema])).values()];
  return unique.length === 1 ? unique[0]! : { type: 'union', variants: unique };
}

export function valueAt(value: Json, path: string[]): Json | undefined {
  let current: Json | undefined = value;
  for (const key of path) {
    if (current === null || typeof current !== 'object' || !Object.hasOwn(current, key)) return undefined;
    current = (current as Record<string, Json>)[key];
  }
  return current;
}
