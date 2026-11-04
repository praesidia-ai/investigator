import { describe, expect, it } from 'vitest';
import { configSchema, DEFAULT_CONFIG } from '../src/contracts.js';
import { COMMANDS } from '../src/cli/registry.js';
import { globToRegExp } from '../src/util/glob.js';
import { stableJson } from '../src/util/json.js';

describe('skeleton', () => {
  it('has a valid default config', () => {
    expect(configSchema.parse(DEFAULT_CONFIG)).toEqual(DEFAULT_CONFIG);
  });
  it('registers unique commands', () => {
    const names = COMMANDS.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
  });
  it('matches globs', () => {
    expect(globToRegExp('src/**').test('src/a/b.ts')).toBe(true);
    expect(globToRegExp('src/**/*.ts').test('src/b.ts')).toBe(true);
    expect(globToRegExp('src/*.ts').test('src/a/b.ts')).toBe(false);
  });
  it('stable json sorts keys', () => {
    expect(stableJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });
});
