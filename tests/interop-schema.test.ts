import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseInvestigationRequest, parseInvestigationResult } from '../src/index.js';

const dir = fileURLToPath(new URL('../schemas/interop/v1/', import.meta.url));
const load = (n: string): unknown => JSON.parse(readFileSync(dir + n, 'utf8'));
const files = readdirSync(dir);

describe('interop v1 fixtures (shared with Jurator)', () => {
  it('accepts the valid pair', () => {
    expect(parseInvestigationRequest(load('request.valid.json')).promise.id).toBe('security.01');
    expect(parseInvestigationResult(load('result.valid.json')).mismatch?.kind).toBe(
      'static-pass-runtime-contradicted',
    );
  });
  for (const f of files.filter((n) => n.includes('.invalid.')))
    it(`refuses ${f}`, () => {
      const parse = f.startsWith('request') ? parseInvestigationRequest : parseInvestigationResult;
      expect(() => parse(load(f))).toThrow();
    });
  it('refuses key-like and URL material with a clear code', () => {
    expect(() => parseInvestigationRequest(load('request.invalid.credential-field.json'))).toThrow(
      /not allowed/,
    );
    expect(() => parseInvestigationRequest(load('request.invalid.execution-url.json'))).toThrow(
      /credential or an execution URL/,
    );
  });
});
