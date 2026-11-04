import { createHash } from 'node:crypto';

/** Stable JSON: object keys sorted recursively, no whitespace. Used for digests. */
export function stableJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sortKeys(v);
    }
    return out;
  }
  return value;
}
export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
/** Pretty JSON for files people review in git. */
export function prettyJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
