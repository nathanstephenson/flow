import { Ajv } from 'ajv';
import { Ajv2019 } from 'ajv/dist/2019.js';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { default as formats } from 'ajv-formats';
import type { Json, JsonSchema } from '../protocol/workflows.ts';

// Only recognizable presentation annotations may be ignored, never validation extensions.
const annotationKeywords = ['example', 'externalDocs', 'xml', 'markdownDescription', 'enumDescriptions', 'enumNames', 'enumTitles'];

// No coercion, defaults, removal of properties or remote schema fetching.
function engineFor(Engine: typeof Ajv) {
  const engine = new Engine({ strict: true, strictTypes: false, strictTuples: false, strictRequired: false, allowUnionTypes: true, allErrors: true });
  (formats as unknown as (ajv: Ajv) => void)(engine);
  for (const keyword of annotationKeywords) engine.addKeyword({ keyword, valid: true });
  return engine;
}
const cache = new Map<string, ReturnType<Ajv['compile']>>();
export function compileJsonSchema(schema: JsonSchema) {
  const key = JSON.stringify(schema);
  const prior = cache.get(key);
  if (prior) return prior;
  const dialect = typeof schema === 'object' ? schema.$schema : undefined;
  const engine = engineFor(typeof dialect === 'string' && dialect.includes('draft-07') ? Ajv : typeof dialect === 'string' && dialect.includes('2019-09') ? Ajv2019 : Ajv2020);
  try {
    const validator = engine.compile(schema);
    if ('$async' in validator) throw new Error('Asynchronous schemas are not supported');
    if (cache.size >= 200) cache.clear();
    cache.set(key, validator);
    return validator;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`MCP JSON Schema cannot be validated: ${reason}. Reconfigure the tool schema (supported dialects: draft-07, 2019-09, 2020-12). No validation was skipped.`);
  }
}
export function validateJsonSchema(schema: JsonSchema, value: Json): void {
  const validate = compileJsonSchema(schema);
  if (!validate(value)) throw new Error('MCP schema validation failed: ' + (validate.errors ?? []).map(error => `${error.instancePath || '/'} ${error.keyword}`).join('; '));
}

// Projection is only for mapping discovery; validation always uses the original schema.
export function jsonSchemaAt(schema: JsonSchema, path: string[]): JsonSchema {
  if (!path.length) return schema;
  if (typeof schema === 'boolean') return schema;
  const [key, ...rest] = path as [string, ...string[]];
  const properties = schema.properties;
  const child = properties && typeof properties === 'object' && !Array.isArray(properties) ? properties[key] : undefined;
  if (child !== undefined && (typeof child === 'boolean' || (child && typeof child === 'object' && !Array.isArray(child)))) return jsonSchemaAt(child as JsonSchema, rest);
  return true;
}
