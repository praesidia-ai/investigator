import type { z } from 'zod';
import { InvestigatorError } from './errors.js';

export function parseInput<T>(
  schema: z.ZodType<T>,
  input: unknown,
  code: string,
  label: string,
): T {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  const paths = [
    ...new Set(result.error.issues.slice(0, 8).map((issue) => issue.path.join('.') || '<root>')),
  ];
  throw new InvestigatorError(code, `${label} is invalid at: ${paths.join(', ')}`);
}

export function parseJson(text: string, code = 'INVALID_JSON'): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new InvestigatorError(code, 'Expected a valid JSON document.');
  }
}
