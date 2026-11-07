import { createHash } from 'node:crypto';

export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

/** Rename every `oneOf` key to `anyOf`: the strict provider subset accepts the nested anyOf form of Zod's disjoint branches. */
export function oneOfToAnyOf(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(oneOfToAnyOf);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key === 'oneOf' ? 'anyOf' : key,
      oneOfToAnyOf(child),
    ]),
  );
}

/** Stable serialization for this application's manifests; not a claim of RFC 8785 conformance. */
export function stableJson(value: JsonValue): string {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value))
      throw new TypeError('Expected finite JSON number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(value[key]!)}`)
    .join(',')}}`;
}

export function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

export function jsonDigest(value: JsonValue): string {
  return sha256(stableJson(value));
}

/** True when an own property is a plain enumerable data property (array `length` is skipped by callers). */
export function isOrdinaryDataProperty(descriptor: PropertyDescriptor): boolean {
  return (
    Boolean(descriptor.enumerable) &&
    !descriptor.get &&
    !descriptor.set &&
    Object.hasOwn(descriptor, 'value')
  );
}

/** True when an array has only dense, canonical index keys. */
export function hasOrdinaryArrayKeys(value: unknown[]): boolean {
  const keys = Object.keys(value);
  return (
    keys.length === value.length &&
    keys.every((key) => /^(0|[1-9]\d*)$/.test(key) && Number(key) < value.length)
  );
}
