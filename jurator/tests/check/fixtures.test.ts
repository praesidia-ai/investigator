import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { aiReadSchema } from '../../src/check/prompts.js';

const dir = join(import.meta.dirname, '../../fixtures/scripted/acme');

describe('scripted AI-read answers for the acme demo', () => {
  const files = readdirSync(dir).filter((f) => f.startsWith('ai-read__') && f.endsWith('.json'));
  it('exist', () => {
    expect(files.length).toBeGreaterThan(0);
  });
  it.each(files)('%s matches the AI-read schema', (file) => {
    const value = aiReadSchema.parse(JSON.parse(readFileSync(join(dir, file), 'utf8')));
    expect(value.explanation.length).toBeGreaterThan(10);
  });
});
