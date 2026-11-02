import { InvestigatorError } from '../core/errors.js';
import type { JsonObject, JsonValue } from '../core/json.js';

const MAX_DEPTH = 10;
const MAX_PROPERTIES = 5_000;
const MAX_ENUM_VALUES = 1_000;
const MAX_NAME_CHARACTERS = 120_000;
const MAX_EXPANDED_NODES = 200_000;
const TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);
const UNSUPPORTED = [
  'oneOf',
  'allOf',
  'not',
  'if',
  'then',
  'else',
  '$dynamicRef',
  '$recursiveRef',
  'patternProperties',
  'prefixItems',
];

function invalid(rule: string): never {
  throw new InvestigatorError(
    'META_SCHEMA_INVALID',
    `The schema is incompatible with Meta strict mode: ${rule}.`,
  );
}

function object(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Do not recurse into hostile objects, accessors, nonfinite values or cyclic input. */
function validateJson(root: JsonObject): void {
  const ancestors = new WeakSet<object>();
  const pending: ({ value: unknown; exit?: false } | { value: object; exit: true })[] = [
    { value: root },
  ];
  let count = 0;
  while (pending.length) {
    const frame = pending.pop()!;
    if (frame.exit) {
      ancestors.delete(frame.value);
      continue;
    }
    const value = frame.value;
    count += 1;
    if (count > MAX_EXPANDED_NODES) invalid('the schema exceeds the supported node budget');
    if (value === null || typeof value === 'string' || typeof value === 'boolean') continue;
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) invalid('numbers must be finite');
      continue;
    }
    if (
      !value ||
      typeof value !== 'object' ||
      (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
    )
      invalid('only plain JSON data is supported');
    if (ancestors.has(value)) invalid('cyclic schema data is unsupported');
    if (Reflect.ownKeys(value).some((key) => typeof key !== 'string'))
      invalid('only string JSON keys are supported');
    if (
      Array.isArray(value) &&
      (Object.keys(value).length !== value.length ||
        Object.keys(value).some(
          (key) => !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length,
        ))
    )
      invalid('arrays must contain ordinary JSON entries');
    ancestors.add(value);
    pending.push({ value, exit: true });
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
      if (Array.isArray(value) && key === 'length') continue;
      if (
        !descriptor.enumerable ||
        descriptor.get ||
        descriptor.set ||
        !Object.hasOwn(descriptor, 'value')
      )
        invalid('only ordinary JSON properties are supported');
      if (pending.length + count >= MAX_EXPANDED_NODES)
        invalid('the schema exceeds the supported node budget');
      pending.push({ value: descriptor.value as unknown });
    }
  }
}

function reference(root: JsonObject, ref: unknown): JsonObject {
  if (
    typeof ref !== 'string' ||
    !/^#\/(?:\$defs|definitions)\//.test(ref) ||
    /~(?:[^01]|$)/.test(ref)
  )
    invalid('only defined local schema references are supported');
  let selected: JsonValue = root;
  for (const encoded of ref.slice(2).split('/')) {
    const token = encoded.replace(/~1/g, '/').replace(/~0/g, '~');
    if (!object(selected) || !Object.hasOwn(selected, token))
      invalid('a local schema reference is unresolved');
    selected = selected[token]!;
  }
  if (!object(selected)) invalid('a local reference must resolve to a schema object');
  return selected;
}

function primitive(value: JsonValue | undefined): boolean {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    typeof value === 'number'
  );
}

/**
 * Checks the supported strict structural subset and conservative API budgets.
 * It never resolves remote schemas. Ordinary validation keywords remain subject
 * to the API's JSON Schema implementation; this is not a general schema engine.
 */
export function assertStrictMetaSchema(schema: JsonObject, _label?: string): void {
  validateJson(schema);
  if (
    !object(schema) ||
    schema['type'] !== 'object' ||
    ['anyOf', 'oneOf', 'allOf', 'enum', 'not', '$ref'].some((key) => Object.hasOwn(schema, key))
  )
    invalid('the root must be a plain object schema');
  const pending: JsonObject[] = [schema];
  const definitions: JsonObject[] = [];
  let propertyCount = 0,
    enumCount = 0,
    nameCharacters = 0;
  while (pending.length) {
    const node = pending.pop()!;
    if (UNSUPPORTED.some((key) => Object.hasOwn(node, key)))
      invalid('unsupported composition or dynamic schema keywords are present');
    const type = node['type'];
    const types =
      typeof type === 'string'
        ? [type]
        : Array.isArray(type) && type.every((item) => typeof item === 'string')
          ? (type as string[])
          : [];
    if (
      (type !== undefined &&
        (!types.length ||
          new Set(types).size !== types.length ||
          types.some((item) => !TYPES.has(item)))) ||
      (type === undefined &&
        !['anyOf', '$ref', 'enum', 'const'].some((key) => Object.hasOwn(node, key)))
    )
      invalid('a schema must declare a supported type, literal, alternative or reference');
    if (Object.hasOwn(node, '$ref')) reference(schema, node['$ref']);
    if (types.includes('object') || Object.hasOwn(node, 'properties')) {
      if (!types.includes('object') || node['additionalProperties'] !== false)
        invalid('every object must set additionalProperties to false');
      const properties = node['properties'] ?? {};
      if (!object(properties)) invalid('object properties must be a schema map');
      const keys = Object.keys(properties);
      const required = node['required'] ?? [];
      if (
        !Array.isArray(required) ||
        required.some((key) => typeof key !== 'string') ||
        new Set(required).size !== required.length ||
        required.length !== keys.length ||
        keys.some((key) => !required.includes(key))
      )
        invalid('every object property must be required exactly once');
      propertyCount += keys.length;
      nameCharacters += keys.reduce((total, key) => total + key.length, 0);
      for (const child of Object.values(properties)) {
        if (!object(child)) invalid('property schemas must be objects');
        pending.push(child);
      }
    }
    if (types.includes('array') || Object.hasOwn(node, 'items')) {
      if (!types.includes('array') || !object(node['items']))
        invalid('arrays require one supported items schema');
      pending.push(node['items']);
    }
    if (Object.hasOwn(node, 'anyOf')) {
      const alternatives = node['anyOf'];
      if (
        !Array.isArray(alternatives) ||
        !alternatives.length ||
        alternatives.some((child) => !object(child))
      )
        invalid('alternatives must contain schema objects');
      pending.push(...(alternatives as JsonObject[]));
    }
    if (Object.hasOwn(node, 'enum')) {
      const values = node['enum'];
      if (!Array.isArray(values) || !values.length || values.some((value) => !primitive(value)))
        invalid('enum values must be primitive JSON literals');
      if (new Set(values.map((value) => JSON.stringify(value))).size !== values.length)
        invalid('enum values must be unique');
      enumCount += values.length;
      const characters = values.reduce<number>(
        (total, value) => total + (typeof value === 'string' ? value.length : 0),
        0,
      );
      nameCharacters += characters;
      if (
        values.length > 250 &&
        values.every((value) => typeof value === 'string') &&
        characters > 15_000
      )
        invalid('a large string enum exceeds its character limit');
    }
    if (Object.hasOwn(node, 'const')) {
      if (!primitive(node['const'])) invalid('constant values must be primitive JSON literals');
      if (typeof node['const'] === 'string') nameCharacters += node['const'].length;
    }
    for (const key of ['$defs', 'definitions']) {
      if (!Object.hasOwn(node, key)) continue;
      const entries = node[key];
      if (!object(entries)) invalid('definitions must be a schema map');
      for (const [name, child] of Object.entries(entries)) {
        nameCharacters += name.length;
        if (!object(child)) invalid('definitions must contain schema objects');
        definitions.push(child);
        pending.push(child);
      }
    }
    if (
      propertyCount > MAX_PROPERTIES ||
      enumCount > MAX_ENUM_VALUES ||
      nameCharacters > MAX_NAME_CHARACTERS
    )
      invalid('the property, enum or schema-name limit was exceeded');
  }

  type Frame =
    | { kind: 'schema'; node: JsonObject; depth: number }
    | { kind: 'literal'; value: JsonValue }
    | { kind: 'reference'; ref: string; depth: number }
    | { kind: 'release'; ref: string };
  const frames: Frame[] = [
    ...definitions.map((node): Frame => ({ kind: 'schema', node, depth: 1 })),
    { kind: 'schema', node: schema, depth: 1 },
  ];
  const activeReferences = new Set<string>();
  let expandedNodes = 0;
  while (frames.length) {
    const frame = frames.pop()!;
    if (frame.kind === 'release') {
      activeReferences.delete(frame.ref);
      continue;
    }
    if (frame.kind === 'reference') {
      if (activeReferences.has(frame.ref)) invalid('recursive schema references are unsupported');
      activeReferences.add(frame.ref);
      frames.push(
        { kind: 'release', ref: frame.ref },
        { kind: 'schema', node: reference(schema, frame.ref), depth: frame.depth },
      );
      continue;
    }
    expandedNodes += 1;
    if (expandedNodes > MAX_EXPANDED_NODES)
      invalid('reference expansion exceeds the supported node budget');
    if (frame.kind === 'literal') {
      if (Array.isArray(frame.value))
        for (const value of frame.value) frames.push({ kind: 'literal', value });
      else if (object(frame.value))
        for (const value of Object.values(frame.value)) frames.push({ kind: 'literal', value });
      continue;
    }
    if (frame.depth > MAX_DEPTH) invalid('the expanded data nesting exceeds ten levels');
    for (const [key, value] of Object.entries(frame.node)) {
      if (key === '$defs' || key === 'definitions') continue;
      if (key === '$ref')
        frames.push({ kind: 'reference', ref: value as string, depth: frame.depth });
      else if (key === 'properties') {
        expandedNodes += 1;
        for (const child of Object.values(value as JsonObject))
          frames.push({ kind: 'schema', node: child as JsonObject, depth: frame.depth + 1 });
      } else if (key === 'items')
        frames.push({ kind: 'schema', node: value as JsonObject, depth: frame.depth + 1 });
      else if (key === 'anyOf') {
        expandedNodes += 1;
        for (const node of value as JsonObject[])
          frames.push({ kind: 'schema', node, depth: frame.depth });
      } else frames.push({ kind: 'literal', value });
    }
  }
}
