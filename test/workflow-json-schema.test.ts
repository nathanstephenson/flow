import assert from 'node:assert/strict';
import test from 'node:test';
import type { Json, JsonSchema } from '../src/protocol/workflows.ts';
import { compileJsonSchema, validateJsonSchema } from '../src/workflows/json-schema.ts';

const dialects = [
  'http://json-schema.org/draft-07/schema#',
  'https://json-schema.org/draft/2019-09/schema',
  'https://json-schema.org/draft/2020-12/schema',
];
const annotations = {
  example: { nullable: true, format: 'not-a-format' },
  externalDocs: { url: 'https://docs.example.test/tool' },
  xml: { name: 'tool', attribute: true },
  markdownDescription: '**Tool input**',
  enumDescriptions: ['First', 'Second'],
  enumNames: ['One', 'Two'],
  enumTitles: ['One', 'Two'],
};

function freeze(value: Json): void {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
}

function cannotCompile(schema: JsonSchema, reason: RegExp): void {
  assert.throws(() => compileJsonSchema(schema), (error: Error) => {
    assert.match(error.message, /^MCP JSON Schema cannot be validated:/);
    assert.match(error.message, reason);
    assert.match(error.message, /supported dialects: draft-07, 2019-09, 2020-12/);
    assert.match(error.message, /No validation was skipped/);
    return true;
  });
}

for (const dialect of dialects) {
  test(`${dialect}: annotations at root, local refs and branches preserve original constraints`, () => {
    const schema: JsonSchema = {
      $schema: dialect,
      ...annotations,
      type: 'object',
      definitions: {
        id: { ...annotations, type: 'string', pattern: '^LIN-[0-9]+$' },
      },
      properties: {
        id: { $ref: '#/definitions/id', ...annotations },
        mode: { ...annotations, enum: ['one', 'two'] },
        count: { ...annotations, type: 'integer', minimum: 1 },
        email: { ...annotations, type: 'string', format: 'email' },
        tags: { type: 'array', items: { ...annotations, type: 'string', minLength: 2 } },
      },
      required: ['id', 'mode', 'count', 'email'],
      additionalProperties: false,
      allOf: [{ ...annotations, properties: { count: { maximum: 3, ...annotations } } }],
      if: { ...annotations, properties: { mode: { const: 'one' } } },
      then: { ...annotations, properties: { count: { const: 1 } } },
      else: { ...annotations, properties: { count: { minimum: 2 } } },
      anyOf: [{ ...annotations, required: ['tags'] }, { ...annotations, properties: { count: { const: 1 } } }],
      oneOf: [{ ...annotations, properties: { mode: { const: 'one' } } }, { ...annotations, properties: { mode: { const: 'two' } } }],
      not: { ...annotations, properties: { id: { const: 'LIN-0' } } },
    };
    const original = structuredClone(schema);
    freeze(schema);
    const valid: Json = { id: 'LIN-1', mode: 'one', count: 1, email: 'a@example.test' };
    validateJsonSchema(schema, valid);
    validateJsonSchema(schema, { ...valid, mode: 'two', count: 2, tags: ['ok'] });
    for (const invalid of [
      { ...valid, id: 'bad' },
      { ...valid, id: 'LIN-0' },
      { ...valid, mode: 'other' },
      { ...valid, count: 0 },
      { ...valid, count: 2 },
      { ...valid, mode: 'two' },
      { ...valid, mode: 'two', count: 2 },
      { ...valid, mode: 'two', count: 4, tags: ['ok'] },
      { ...valid, email: 'bad' },
      { ...valid, tags: ['x'] },
      { ...valid, extra: true },
      { mode: 'one', count: 1, email: 'a@example.test' },
    ]) assert.throws(() => validateJsonSchema(schema, invalid), /MCP schema validation failed:/);
    assert.deepEqual(schema, original);
    assert.strictEqual(compileJsonSchema(schema), compileJsonSchema(original));
  });

  test(`${dialect}: annotations do not disable dialect-specific validation`, () => {
    const modern = !dialect.includes('draft-07');
    const tuple: JsonSchema = {
      $schema: dialect, ...annotations, type: 'array', minItems: 2,
      ...(dialect.includes('2020-12')
        ? { prefixItems: [{ ...annotations, const: 'a' }, { ...annotations, type: 'boolean' }], items: false }
        : { items: [{ ...annotations, const: 'a' }, { ...annotations, type: 'boolean' }], additionalItems: false }),
    };
    validateJsonSchema(tuple, ['a', true]);
    for (const invalid of [['a'], ['b', true], ['a', 'true'], ['a', true, 1]]) {
      assert.throws(() => validateJsonSchema(tuple, invalid), /schema validation failed/);
    }
    const dependencies: JsonSchema = {
      $schema: dialect, type: 'object', ...annotations,
      properties: { a: { type: 'number', ...annotations }, b: { type: 'number' } },
      ...(modern ? { dependentRequired: { a: ['b'] }, unevaluatedProperties: false } : { dependencies: { a: ['b'] }, additionalProperties: false }),
    };
    validateJsonSchema(dependencies, { a: 1, b: 2 });
    assert.throws(() => validateJsonSchema(dependencies, { a: 1 }), /schema validation failed/);
    assert.throws(() => validateJsonSchema(dependencies, { extra: 1 }), /schema validation failed/);
  });

  test(`${dialect}: unknown keywords, validation extensions and formats fail with AJV reasons`, () => {
    for (const keyword of ['customValidation', 'x-custom', 'x-markdownDescription', 'discriminator']) {
      cannotCompile({ $schema: dialect, type: 'string', [keyword]: true }, new RegExp(`unknown keyword: "${keyword}"`));
      cannotCompile({ $schema: dialect, type: 'object', properties: { nested: { type: 'string', [keyword]: true } } }, new RegExp(keyword));
    }
    cannotCompile({ $schema: dialect, type: 'string', format: 'unknown-format' }, /unknown format "unknown-format"/);
    cannotCompile({ $schema: dialect, definitions: { bad: { type: 'string', format: 'unknown-format' } }, $ref: '#/definitions/bad' }, /unknown format/);
    cannotCompile({ $schema: dialect, anyOf: [{ type: 'string' }, { type: 'number', customValidation: true }] }, /unknown keyword: "customValidation"/);
    cannotCompile({ $schema: dialect, type: 'not-a-type' }, /schema is invalid/);
  });

  test(`${dialect}: native nullable support remains enforced, not treated as annotation`, () => {
    const schema: JsonSchema = { $schema: dialect, type: 'string', nullable: true, minLength: 2, ...annotations };
    validateJsonSchema(schema, null);
    validateJsonSchema(schema, 'ok');
    assert.throws(() => validateJsonSchema(schema, 'x'), /minLength/);
    assert.throws(() => validateJsonSchema(schema, 1), /type/);
    assert.throws(() => validateJsonSchema({ $schema: dialect, type: 'string', nullable: false }, null), /type/);
    cannotCompile({ $schema: dialect, nullable: true }, /nullable.*without.*type/);
  });

  test(`${dialect}: validation never coerces, inserts defaults or removes properties`, () => {
    const schema: JsonSchema = {
      $schema: dialect, type: 'object', ...annotations,
      properties: { count: { type: 'integer' }, enabled: { type: 'boolean', default: true } },
      required: ['count', 'enabled'], additionalProperties: false,
    };
    for (const value of [
      { count: 1, enabled: false },
      { count: '1', enabled: false },
      { count: 1 },
      { count: 1, enabled: false, extra: true },
    ]) {
      const original = structuredClone(value);
      if (Object.keys(value).length === 2 && typeof value.count === 'number') validateJsonSchema(schema, value);
      else assert.throws(() => validateJsonSchema(schema, value), /schema validation failed/);
      assert.deepEqual(value, original);
    }
  });

  test(`${dialect}: asynchronous schemas are rejected with an explicit reason`, () => {
    cannotCompile({ $schema: dialect, $async: true, type: 'string', ...annotations }, /Asynchronous schemas are not supported/);
  });
}

test('remote references are rejected without fetching and retain the unresolved reference', (t) => {
  let fetches = 0;
  t.mock.method(globalThis, 'fetch', () => { fetches++; throw new Error('Unexpected schema fetch'); });
  for (const dialect of dialects) {
    cannotCompile({ $schema: dialect, $ref: 'https://not-fetched.test/schema' }, /can't resolve reference https:\/\/not-fetched\.test\/schema/);
    cannotCompile({ $schema: dialect, type: 'object', properties: { nested: { $ref: 'https://not-fetched.test/nested' } } }, /can't resolve reference/);
  }
  assert.equal(fetches, 0);
});

test('unsupported dialects fail with the original dialect in the error', () => {
  for (const dialect of ['http://json-schema.org/draft-04/schema#', 'https://example.test/draft/2020-12/schema']) {
    cannotCompile({ $schema: dialect, type: 'string', ...annotations }, /no schema with key or ref/);
    assert.throws(() => compileJsonSchema({ $schema: dialect }), (error: Error) => error.message.includes(dialect));
  }
});

test('MCP default dialect is 2020-12 and boolean schemas retain their meaning', () => {
  const schema: JsonSchema = { type: 'array', ...annotations, prefixItems: [{ const: 1 }], items: false };
  validateJsonSchema(schema, [1]);
  assert.throws(() => validateJsonSchema(schema, [1, 2]), /schema validation failed/);
  validateJsonSchema(true, null);
  assert.throws(() => validateJsonSchema(false, null), /schema validation failed/);
});
