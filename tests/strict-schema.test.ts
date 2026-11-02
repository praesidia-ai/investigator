import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import type { JsonObject, JsonValue } from '../src/core/json.js';
import { findingSchema } from '../src/core/schemas.js';
import { INVESTIGATION_TOOLS } from '../src/core/tools.js';
import { evidenceRequestSchema } from '../src/evidence-plans/requests.js';
import { assertStrictMetaSchema } from '../src/providers/strict-schema.js';

function closed(properties: JsonObject = {}): JsonObject {
  return {
    type: 'object',
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  };
}
function normalize(input: JsonValue): JsonValue {
  if (Array.isArray(input)) return input.map(normalize);
  if (!input || typeof input !== 'object') return input;
  return Object.fromEntries(
    Object.entries(input).map(([key, value]) => [
      key === 'oneOf' ? 'anyOf' : key,
      normalize(value),
    ]),
  );
}
function actualSchema(input: z.ZodType): JsonObject {
  return normalize(z.toJSONSchema(input, { target: 'draft-7' }) as JsonObject) as JsonObject;
}

describe('offline Meta strict-schema readiness', () => {
  it('accepts actual frozen investigation tools and generated final finding/evidence request formats', () => {
    for (const tool of INVESTIGATION_TOOLS)
      expect(() => assertStrictMetaSchema(tool.parameters)).not.toThrow();
    expect(() => assertStrictMetaSchema(actualSchema(findingSchema))).not.toThrow();
    expect(() => assertStrictMetaSchema(actualSchema(evidenceRequestSchema))).not.toThrow();
  });

  it('accepts closed empty objects, nullable values, nested alternatives and literal discriminator names', () => {
    const schema = closed({
      result: {
        anyOf: [
          closed({ kind: { const: 'observed' }, details: { type: ['string', 'null'] } }),
          { type: 'null' },
        ],
      },
      records: { type: 'array', items: closed({ oneOf: { type: 'string' } }) },
    });
    expect(() => assertStrictMetaSchema(closed())).not.toThrow();
    expect(() => assertStrictMetaSchema(schema)).not.toThrow();
  });

  it.each([
    { type: 'array', items: { type: 'string' } },
    { anyOf: [closed(), { type: 'null' }] },
    { ...closed(), enum: ['x'] },
    { ...closed(), oneOf: [closed()] },
    { ...closed(), allOf: [closed()] },
    { type: 'object', properties: { optional: { type: 'string' } }, additionalProperties: false },
    { ...closed({ id: { type: 'string' } }), required: ['other'] },
    { ...closed({ id: { type: 'string' } }), required: ['id', 'id'] },
    { ...closed(), additionalProperties: true },
    closed({
      open: { type: 'object', properties: { data: { type: 'string' } }, required: ['data'] },
    }),
    closed({ tuple: { type: 'array', items: [{ type: 'string' }] } }),
    closed({
      dynamic: {
        type: 'object',
        patternProperties: { '.*': { type: 'string' } },
        additionalProperties: false,
      },
    }),
    closed({ wrong: { type: 'datetime' } }),
  ] as JsonObject[])(
    'rejects incompatible root, object, required and composition rules',
    (schema) => {
      expect(() => assertStrictMetaSchema(schema)).toThrow(/Meta strict mode/);
    },
  );

  it('resolves finite local definitions without fetching remote references', () => {
    const schema = {
      ...closed({ record: { $ref: '#/$defs/record' } }),
      $defs: { record: closed({ value: { type: 'string' } }) },
    };
    expect(() => assertStrictMetaSchema(schema)).not.toThrow();
    expect(() =>
      assertStrictMetaSchema({
        ...closed({ record: { $ref: '#/definitions/a~1b' } }),
        definitions: { 'a/b': { type: 'string' } },
      }),
    ).not.toThrow();
    for (const ref of [
      'https://untrusted.invalid/schema.json',
      '#/$defs/missing',
      '#/properties/value',
      '#/$defs/bad~2name',
    ])
      expect(() => assertStrictMetaSchema(closed({ record: { $ref: ref } }))).toThrow(
        /local schema reference/,
      );
  });

  it('rejects recursive references, including unused recursive definitions', () => {
    const schema = {
      ...closed({ record: { $ref: '#/$defs/record' } }),
      $defs: { record: closed({ child: { $ref: '#/$defs/record' } }) },
    };
    expect(() => assertStrictMetaSchema(schema)).toThrow(/recursive/);
    expect(() => assertStrictMetaSchema({ ...closed(), $defs: schema.$defs })).toThrow(/recursive/);
  });

  it('bounds nested data, aggregate properties and definition/literal name characters', () => {
    let node: JsonObject = { type: 'string' };
    for (let index = 0; index < 12; index += 1) node = closed({ child: node });
    expect(() => assertStrictMetaSchema(node)).toThrow(/nesting/);
    const properties = Object.fromEntries(
      Array.from({ length: 5_001 }, (_value, index) => [`p${index}`, { type: 'string' }]),
    );
    expect(() => assertStrictMetaSchema(closed(properties))).toThrow(/property/);
    expect(() =>
      assertStrictMetaSchema(closed({ ['x'.repeat(120_001)]: { type: 'string' } })),
    ).toThrow(/schema-name/);
    expect(() => assertStrictMetaSchema(closed({ value: { const: 'x'.repeat(120_001) } }))).toThrow(
      /schema-name/,
    );
  });

  it('bounds enum counts and the additional large string-enum character allowance', () => {
    expect(() =>
      assertStrictMetaSchema(
        closed({
          value: {
            type: 'string',
            enum: Array.from({ length: 1_001 }, (_value, index) => `v${index}`),
          },
        }),
      ),
    ).toThrow(/enum/);
    expect(() =>
      assertStrictMetaSchema(
        closed({
          value: {
            type: 'string',
            enum: Array.from({ length: 251 }, (_value, index) => `${index}:${'x'.repeat(60)}`),
          },
        }),
      ),
    ).toThrow(/large string enum/);
    expect(() => assertStrictMetaSchema(closed({ value: { enum: ['a', 'a'] } }))).toThrow(/unique/);
  });

  it('rejects excessive reference expansion before it can become an unbounded schema', () => {
    const definitions: JsonObject = { item0: { type: 'string' } };
    for (let index = 1; index <= 18; index += 1)
      definitions[`item${index}`] = {
        anyOf: [{ $ref: `#/$defs/item${index - 1}` }, { $ref: `#/$defs/item${index - 1}` }],
      };
    expect(() =>
      assertStrictMetaSchema({
        ...closed({ value: { $ref: '#/$defs/item18' } }),
        $defs: definitions,
      }),
    ).toThrow(/node budget/);
  });

  it('rejects cycles/nonfinite/accessor data without echoing selected schema text', () => {
    const cyclic = closed();
    cyclic['recursive'] = cyclic;
    expect(() => assertStrictMetaSchema(cyclic)).toThrow(/cyclic/);
    expect(() =>
      assertStrictMetaSchema(
        closed({ value: { type: 'number', maximum: Number.POSITIVE_INFINITY } }),
      ),
    ).toThrow(/finite/);
    const accessor = closed();
    let read = false;
    Object.defineProperty(accessor, 'description', {
      enumerable: true,
      get() {
        read = true;
        return 'private-value';
      },
    });
    expect(() => assertStrictMetaSchema(accessor)).toThrow(/ordinary JSON properties/);
    expect(read).toBe(false);
    try {
      assertStrictMetaSchema(
        { ...closed(), description: 'private-schema-content', oneOf: [] },
        'private-label',
      );
    } catch (error) {
      expect(String(error)).not.toMatch(/private-schema-content|private-label/);
    }
  });
});
