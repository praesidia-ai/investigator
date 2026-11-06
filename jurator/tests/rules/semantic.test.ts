import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import type { Rule } from '../../src/contracts.js';
import { proveRuleCanFail, removeGuard, runRule } from '../../src/rules/engine.js';
import { getSemanticAdapter, loadSemanticAdapter, registerSemanticAdapter, unregisterSemanticAdapter, type SemanticAdapter, type SemanticAnalysis } from '../../src/rules/semantic.js';

const rule = (over: Partial<NonNullable<Rule['semantic']>> = {}): Rule => ({
  id: 'R-sem.01',
  promiseId: 'security.01',
  description: 'exports need a guard',
  mode: 'semantic',
  pattern: 'guard-before-effect',
  globs: ['src/**/*.ts'],
  provenBy: null,
  status: 'accepted',
  author: 'human',
  createdAt: '2026-11-05T00:00:00.000Z',
  semantic: { adapter: 'ts-export-control', adapterVersion: '1.0.0', control: 'guard-before-effect', config: {}, ...over },
});
const files = [{ path: 'src/a.ts', text: 'line1\nexportData(x);\n' }];
const fake = (out: Partial<SemanticAnalysis>, version = '1.0.0'): SemanticAdapter => ({
  id: 'ts-export-control',
  version,
  analyze: () => ({ control: 'guard-before-effect', findings: [], gaps: [], assessedRoutes: 1, ...out }),
});

afterEach(() => unregisterSemanticAdapter('ts-export-control'));

describe('semantic rules', () => {
  it('no adapter: not assessed, never pass', () => {
    const r = runRule(rule(), files, 'abc1234');
    expect(r.outcome).toBe('error');
    expect(r.message).toContain('not assessed');
    expect(r.coverageGaps?.[0]?.kind).toBe('analyzer-unavailable');
  });
  it('version mismatch: not assessed', () => {
    registerSemanticAdapter(fake({}, '2.0.0'));
    const r = runRule(rule(), files, 'abc1234');
    expect(r.outcome).toBe('error');
    expect(r.coverageGaps?.[0]?.kind).toBe('analyzer-unavailable');
    expect(r.coverageGaps?.[0]?.detail).toContain('version mismatch');
  });
  it('findings fail with citations copied from the files', () => {
    registerSemanticAdapter(fake({ findings: [{ path: 'src/a.ts', line: 2, detail: 'effect without guard', route: 'GET /x' }] }));
    const r = runRule(rule(), files, 'abc1234');
    expect(r.outcome).toBe('fail');
    expect(r.hits[0]).toMatchObject({ path: 'src/a.ts', startLine: 2, quote: 'exportData(x);', commit: 'abc1234' });
  });
  it('gaps without findings: error with coverageGaps', () => {
    registerSemanticAdapter(fake({ gaps: [{ kind: 'dynamic-registration', detail: 'x', path: 'src/a.ts', line: 1 }] }));
    const r = runRule(rule(), files, 'abc1234');
    expect(r.outcome).toBe('error');
    expect(r.coverageGaps).toHaveLength(1);
  });
  it('clean: pass; zero assessed routes: not assessed', () => {
    registerSemanticAdapter(fake({}));
    expect(runRule(rule(), files, 'abc1234').outcome).toBe('pass');
    registerSemanticAdapter(fake({ assessedRoutes: 0 }));
    expect(runRule(rule(), files, 'abc1234').outcome).toBe('error');
  });
  it('analyzer throw: error', () => {
    registerSemanticAdapter({ id: 'ts-export-control', version: '1.0.0', analyze: () => { throw new Error('bad config'); } });
    expect(runRule(rule(), files, 'abc1234').outcome).toBe('error');
  });
  it('proof and removeGuard handle the mode without crashing', () => {
    registerSemanticAdapter(fake({}));
    expect(proveRuleCanFail(rule(), files, 'abc1234').ok).toBe(false);
    expect(() => removeGuard(rule(), files)).toThrow(/mutants/u);
  });
  it('loader only knows the allowlist', async () => {
    expect(await loadSemanticAdapter('../../evil')).toBeNull();
    expect(await loadSemanticAdapter('nope')).toBeNull();
    expect(getSemanticAdapter('nope')).toBeUndefined();
  });
  it('src/rules/semantic.ts imports only zod-free relative modules, and the dynamic specifiers are fixed', () => {
    const src = readFileSync(new URL('../../src/rules/semantic.ts', import.meta.url), 'utf8');
    const statics = [...src.matchAll(/^import[^'"]*from\s+['"]([^'"]+)['"]/gmu)].map((m) => m[1]);
    expect(statics.every((s) => s?.startsWith('.'))).toBe(true);
    expect([...src.matchAll(/import\(\s*([^)]*)\)/gu)].map((m) => m[1])).toEqual(['spec']);
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { dependencies: Record<string, string> };
    expect(Object.keys(pkg.dependencies)).toEqual(['zod']);
  });
});

describe('real ts-export-control analyzer (when built)', () => {
  it('loads from the checkout build and fails an unguarded export route', async () => {
    const a = await loadSemanticAdapter('ts-export-control');
    if (!a) return; // analyzers/ts-export-control not built here: core stays usable
    const config = { guards: [{ module: 'src/auth', symbol: 'requireAdmin', subjectArg: null, style: 'throws', async: false }], effects: [{ module: 'src/exp', symbol: 'exportAll' }], routeRegistrars: ['get'], routeObjects: ['router'] };
    const text = "import { exportAll } from './exp';\nrouter.get('/export.csv', (req, res) => {\n  exportAll();\n});\n";
    const r = runRule(rule({ adapterVersion: a.version, config }), [{ path: 'src/r.ts', text }], 'abc1234');
    expect(r.outcome).toBe('fail');
    expect(r.hits[0]?.startLine).toBe(3);
  });
});
