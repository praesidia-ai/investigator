import { z } from 'zod';
import type { JsonValue } from './json.js';

/** Validate data without cloning away reserved JSON keys that a commitment must retain. */
export const boundedJsonValueSchema = z.custom<JsonValue>(
  (input: unknown) => {
    const pending = [{ value: input, depth: 0 }];
    let nodes = 0;
    while (pending.length) {
      const { value, depth } = pending.pop()!;
      nodes += 1;
      if (nodes > 20_000 || depth > 32) return false;
      if (value === null || typeof value === 'string' || typeof value === 'boolean') continue;
      if (typeof value === 'number') {
        if (!Number.isFinite(value)) return false;
        continue;
      }
      if (!value || typeof value !== 'object') return false;
      if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
        return false;
      if (Reflect.ownKeys(value).some((key) => typeof key !== 'string')) return false;
      if (
        Array.isArray(value) &&
        (Object.keys(value).length !== value.length ||
          Object.keys(value).some(
            (key) => !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length,
          ))
      )
        return false;
      for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
        if (Array.isArray(value) && key === 'length') continue;
        if (
          !descriptor.enumerable ||
          descriptor.get ||
          descriptor.set ||
          !Object.hasOwn(descriptor, 'value')
        )
          return false;
        if (pending.length + nodes >= 20_000) return false;
        pending.push({ value: descriptor.value as unknown, depth: depth + 1 });
      }
    }
    return true;
  },
  { message: 'Expected bounded finite plain JSON data' },
);
