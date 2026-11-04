import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { JsonObject } from '../../src/model/meta/json-types.js';
import { assertStrictMetaSchema } from '../../src/model/meta/strict-schema.js';
import { stripOptionalNulls, toStrictJsonSchema } from '../../src/model/strict.js';
import { JuratorError } from '../../src/util/errors.js';

const draftSchema = z.object({
  promises: z.array(
    z.object({
      wording: z.string().min(3).max(400),
      kind: z.enum(['must', 'must-not', 'may']),
      quote: z.string(),
      unit: z.string().nullable(),
      scope: z.array(z.string()),
      params: z.array(z.object({ name: z.string(), value: z.string() })),
    }),
  ),
  notes: z.string(),
});

function everyObject(node: unknown, visit: (o: JsonObject) => void): void {
  if (Array.isArray(node)) node.forEach((n) => everyObject(n, visit));
  else if (node && typeof node === 'object') {
    const o = node as JsonObject;
    if (o['type'] === 'object') visit(o);
    Object.values(o).forEach((v) => everyObject(v, visit));
  }
}

describe('toStrictJsonSchema', () => {
  it('closes every object and requires every property', () => {
    const { schema } = toStrictJsonSchema(draftSchema, 'drafts');
    expect(schema['$schema']).toBeUndefined();
    expect(schema['type']).toBe('object');
    let objects = 0;
    everyObject(schema, (o) => {
      objects += 1;
      expect(o['additionalProperties']).toBe(false);
      expect([...(o['required'] as string[])].sort()).toEqual(Object.keys(o['properties'] as JsonObject).sort());
    });
    expect(objects).toBe(3);
    expect(() => assertStrictMetaSchema(schema)).not.toThrow();
    const item = ((schema['properties'] as JsonObject)['promises'] as JsonObject)['items'] as JsonObject;
    expect((item['properties'] as JsonObject)['unit']).toEqual({ type: ['string', 'null'] });
  });

  it('turns optional fields into required nullable ones and strips the nulls before zod', () => {
    const schema = z.object({ a: z.string(), b: z.number().optional(), c: z.object({ d: z.string().optional() }) });
    const strict = toStrictJsonSchema(schema, 'opt');
    const props = strict.schema['properties'] as JsonObject;
    expect(strict.schema['required']).toEqual(['a', 'b', 'c']);
    expect(props['b']).toEqual({ type: ['number', 'null'] });
    expect((props['c'] as JsonObject)['required']).toEqual(['d']);
    const cleaned = stripOptionalNulls({ a: 'x', b: null, c: { d: null } }, strict);
    expect(cleaned).toEqual({ a: 'x', c: {} });
    expect(schema.parse(cleaned)).toEqual({ a: 'x', c: {} });
    // A null at a required nullable key stays.
    const s2 = toStrictJsonSchema(z.object({ n: z.string().nullable() }));
    expect(stripOptionalNulls({ n: null }, s2)).toEqual({ n: null });
  });

  it('maps oneOf to anyOf for discriminated unions inside an object', () => {
    const schema = z.object({
      loc: z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('lines'), start: z.number().int() }),
        z.object({ kind: z.literal('pointer'), pointer: z.string() }),
      ]),
    });
    const { schema: strict } = toStrictJsonSchema(schema, 'union');
    expect(JSON.stringify(strict)).not.toContain('oneOf');
    expect(JSON.stringify(strict)).toContain('anyOf');
  });

  it('rejects schemas Meta strict mode cannot take, with a plain message', () => {
    const record = z.object({ byId: z.record(z.string(), z.string()) });
    expect(() => toStrictJsonSchema(record, 'rec')).toThrowError(JuratorError);
    try {
      toStrictJsonSchema(record, 'rec');
    } catch (error) {
      expect((error as JuratorError).code).toBe('META_SCHEMA_INVALID');
      expect((error as JuratorError).message).toContain('"rec"');
    }
    expect(() => toStrictJsonSchema(z.array(z.string()), 'arr')).toThrowError(/top level/u);
  });
});
