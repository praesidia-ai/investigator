// Owner: WP-M. zod schema -> JSON Schema in Meta's strict subset, plus the matching clean-up of model output.
import { z } from 'zod';
import { JuratorError } from '../util/errors.js';
import type { JsonObject, JsonValue } from './meta/json-types.js';
import { assertStrictMetaSchema } from './meta/strict-schema.js';

export interface StrictSchema {
  readonly schema: JsonObject;
  /**
   * Keys that were optional in zod. Strict mode makes every key required, so these became nullable; before the zod
   * check, a null at such a key is removed again. Keyed by the strict schema node that owns the key.
   */
  readonly optionalKeys: WeakMap<JsonObject, ReadonlySet<string>>;
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nullable(node: JsonObject): JsonObject {
  const type = node['type'];
  if (typeof type === 'string' && !Object.hasOwn(node, 'enum') && !Object.hasOwn(node, 'const')) {
    return type === 'null' ? node : { ...node, type: [type, 'null'] };
  }
  if (Array.isArray(type) && !Object.hasOwn(node, 'enum') && !Object.hasOwn(node, 'const')) {
    return type.includes('null') ? node : { ...node, type: [...type, 'null'] };
  }
  return { anyOf: [node, { type: 'null' }] };
}

/**
 * Converts a zod schema to strict JSON Schema: no `$schema`, `oneOf` -> `anyOf`, every object closed
 * (`additionalProperties: false`) with every property required (optional ones become nullable). Then checks it
 * with the ported `assertStrictMetaSchema`. Throws `JuratorError('META_SCHEMA_INVALID', ...)` for schemas Meta
 * strict mode cannot take (records, unions at the root, non-object roots, ...).
 */
export function toStrictJsonSchema(schema: z.ZodType, schemaName = 'schema'): StrictSchema {
  let raw: unknown;
  try {
    raw = JSON.parse(JSON.stringify(z.toJSONSchema(schema, { target: 'draft-7', io: 'output' })));
  } catch {
    throw new JuratorError(
      'META_SCHEMA_INVALID',
      `The schema "${schemaName}" cannot be turned into JSON Schema (transforms, dates or other non-JSON types?).`,
    );
  }
  const optionalKeys = new WeakMap<JsonObject, ReadonlySet<string>>();
  const visit = (value: JsonValue): JsonValue => {
    if (Array.isArray(value)) return value.map(visit);
    if (!isObject(value)) return value;
    const out: JsonObject = {};
    for (const [key, child] of Object.entries(value)) {
      if (key === '$schema') continue;
      out[key === 'oneOf' ? 'anyOf' : key] = visit(child);
    }
    const isObjectNode = out['type'] === 'object' || (Array.isArray(out['type']) && out['type'].includes('object'));
    if (isObjectNode || isObject(out['properties'])) {
      const properties = isObject(out['properties']) ? out['properties'] : {};
      const required = new Set(
        Array.isArray(out['required']) ? out['required'].filter((k): k is string => typeof k === 'string') : [],
      );
      const optional = new Set<string>();
      for (const key of Object.keys(properties)) {
        if (required.has(key)) continue;
        optional.add(key);
        const child = properties[key];
        if (isObject(child)) properties[key] = nullable(child);
      }
      out['properties'] = properties;
      out['required'] = Object.keys(properties);
      // A record (additionalProperties: schema) stays as-is so the strict check below names the problem.
      if (out['additionalProperties'] === undefined || out['additionalProperties'] === true) {
        out['additionalProperties'] = false;
      }
      if (optional.size) optionalKeys.set(out, optional);
    }
    return out;
  };
  const strict = visit(raw as JsonValue);
  if (!isObject(strict) || strict['type'] !== 'object') {
    throw new JuratorError(
      'META_SCHEMA_INVALID',
      `The schema "${schemaName}" must be a zod object at the top level (Meta strict output needs an object).`,
    );
  }
  try {
    assertStrictMetaSchema(strict, 'output');
  } catch (error) {
    if (error instanceof JuratorError) {
      throw new JuratorError(error.code, `${error.message.replace(/\.$/u, '')} (schema "${schemaName}").`);
    }
    throw error;
  }
  return { schema: strict, optionalKeys };
}

/** Removes `null` at keys that were optional in zod, guided by the strict schema, so zod's check passes. */
export function stripOptionalNulls(value: unknown, strict: StrictSchema): unknown {
  const root = strict.schema;
  const resolve = (node: JsonObject): JsonObject => {
    const ref = node['$ref'];
    if (typeof ref !== 'string' || !ref.startsWith('#/')) return node;
    let selected: JsonValue = root;
    for (const part of ref.slice(2).split('/')) {
      const token = part.replace(/~1/gu, '/').replace(/~0/gu, '~');
      if (!isObject(selected) || !Object.hasOwn(selected, token)) return node;
      selected = selected[token] as JsonValue;
    }
    return isObject(selected) ? selected : node;
  };
  const walk = (input: unknown, rawNode: JsonObject, depth: number): unknown => {
    if (depth > 64) return input;
    const node = resolve(rawNode);
    if (Array.isArray(node['anyOf'])) {
      let current = input;
      for (const alt of node['anyOf']) if (isObject(alt)) current = walk(current, alt, depth + 1);
      return current;
    }
    if (Array.isArray(input)) {
      const items = node['items'];
      return isObject(items) ? input.map((item) => walk(item, items, depth + 1)) : input;
    }
    if (input !== null && typeof input === 'object') {
      const properties = node['properties'];
      if (!isObject(properties)) return input;
      const optional = strict.optionalKeys.get(node);
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(input as Record<string, unknown>)) {
        if (child === null && optional?.has(key)) continue;
        const childNode = properties[key];
        out[key] = isObject(childNode) ? walk(child, childNode, depth + 1) : child;
      }
      return out;
    }
    return input;
  };
  return walk(value, root, 0);
}

/** A short, plain summary of zod issues for error messages (paths + messages, no values). */
export function describeIssues(error: z.ZodError, max = 4): string {
  const parts = error.issues.slice(0, max).map((issue) => {
    const path = issue.path.length ? issue.path.map(String).join('.') : '(root)';
    return `${path}: ${issue.message}`;
  });
  const more = error.issues.length > max ? ` (+${error.issues.length - max} more)` : '';
  return `${parts.join('; ')}${more}`;
}
