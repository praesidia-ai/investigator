import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assessmentPath, assuranceFor, bundleDigest, buildBundle, readSetOf, loadEvasions, readBundle, saveAssessment, verifyBundle, writeBundle } from '../../src/rules/assessment.js';
import { mutantsPath, testMutants } from '../../src/rules/mutants.js';
import { FakeRepo, FILES, HEAD, promise, rule } from '../check/fakes.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'kw-bundle-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const r = rule('R-security.01', 'security.01', ['src/routes/**']);
const p = promise('security.01');
const ev = (closed: boolean) => ({ path: 'src/routes/export.ts', find: 'requireAdmin(req);', replace: 'try { requireAdmin(req); } catch {}', why: 'swallowed', judgeNote: 'n', round: 0, closed });
const at = '2026-11-05T00:00:00.000Z';

describe('assessment bundle', () => {
  it('roundtrips, is sorted and pretty, and a tampered digest or edited rule is rejected', async () => {
    const b = buildBundle({ rule: r, promise: p, commit: HEAD, readSet: [{ path: 'b', blob: '1' }, { path: 'a', blob: '2' }], mutants: [ev(false)], createdAt: at });
    expect(b.readSet.map((x) => x.path)).toEqual(['a', 'b']);
    expect(b.coverage).toBe('limited-detector');
    expect(await writeBundle(dir, b)).toBe(true);
    const raw = await readFile(assessmentPath(dir, r.id), 'utf8');
    expect(raw).toContain('\n  "ruleId"');
    expect(assessmentPath(dir, r.id)).not.toContain('local');
    const back = await readBundle(dir, r.id);
    expect(back).toEqual(b);
    expect(verifyBundle(back, { rule: r, promise: p })).toEqual({ ok: true, problems: [] });
    expect(verifyBundle({ ...b, mutants: [ev(true)] }).ok).toBe(false);
    expect(verifyBundle(b, { rule: { ...r, pattern: 'other' } }).problems[0]).toContain('older version of the rule');
  });

  it('strong-control only for a semantic rule with no open case and passing harmless controls', () => {
    const sem = { ...r, mode: 'semantic' as const, semantic: { adapter: 'a', adapterVersion: '1', control: 'c', config: {} } };
    const control = [{ path: 'x', find: 'a', replace: 'b', why: 'w', passed: true }];
    expect(buildBundle({ rule: sem, promise: p, commit: HEAD, readSet: [], mutants: [ev(true)], harmlessControls: control, createdAt: at }).coverage).toBe('strong-control');
    expect(buildBundle({ rule: sem, promise: p, commit: HEAD, readSet: [], mutants: [ev(false)], harmlessControls: control, createdAt: at }).coverage).toBe('limited-detector');
    expect(buildBundle({ rule: sem, promise: p, commit: HEAD, readSet: [], mutants: [ev(true)], createdAt: at }).coverage).toBe('limited-detector');
    expect(buildBundle({ rule: r, promise: p, commit: HEAD, readSet: [], mutants: [ev(true)], harmlessControls: control, createdAt: at }).coverage).toBe('limited-detector');
  });

  it('legacy local/rule-mutants.json is still read, imported into a bundle, never deleted, and still reproducible', async () => {
    const legacy = { version: 1, rules: { [r.id]: { promiseId: 'security.01', commit: HEAD, evasions: [ev(true)] } } };
    await mkdir(join(dir, 'local'), { recursive: true });
    await writeFile(mutantsPath(dir), JSON.stringify(legacy), 'utf8');
    expect((await loadEvasions(dir, r.id)).source).toBe('legacy');
    const repo = new FakeRepo();
    const saved = await saveAssessment(dir, repo, { rule: r, promise: p, commit: HEAD, createdAt: at });
    expect(saved?.mutants).toHaveLength(1);
    expect((await loadEvasions(dir, r.id)).source).toBe('bundle');
    await stat(mutantsPath(dir)); // still there
    const { evasions } = await loadEvasions(dir, r.id);
    const files = async (g: readonly string[]) => (await repo.listFiles(HEAD, g)).map((path) => ({ path, text: FILES_TEXT(path) }));
    const res = await testMutants(r, p, evasions, HEAD, files);
    expect(res[0]?.outcome).toMatch(/caught|missed|not-applied|error/u);
    expect(await assuranceFor(dir, [r])).toMatchObject({ coverage: 'limited-detector', openCounterexamples: 0 });
  });
});

const FILES_TEXT = (path: string): string => FILES[path] ?? '';

describe('review fixes', () => {
  const sem = { ...r, mode: 'semantic' as const, semantic: { adapter: 'a', adapterVersion: '1', control: 'c', config: {} } };
  const control = [{ path: 'x', find: 'a', replace: 'b', why: 'w', passed: true }];

  it('a recomputed digest cannot smuggle in a coverage the content does not support', () => {
    const b = buildBundle({ rule: sem, promise: p, commit: HEAD, readSet: [], mutants: [ev(false)], harmlessControls: control, createdAt: at });
    const { digest: _d, ...body } = { ...b, coverage: 'strong-control' as const };
    void _d;
    const forged = { ...body, digest: bundleDigest(body) };
    expect(verifyBundle(forged, { rule: sem }).problems.join()).toContain('coverage does not follow');
    const empty = buildBundle({ rule: sem, promise: p, commit: HEAD, readSet: [], mutants: [], harmlessControls: [{ ...control[0]!, passed: false }], createdAt: at });
    const { digest: _e, ...b2 } = { ...empty, coverage: 'strong-control' as const };
    void _e;
    expect(verifyBundle({ ...b2, digest: bundleDigest(b2) }).ok).toBe(false);
  });

  it('strong-control drops to limited-detector when the promise was reworded or the read set changed', async () => {
    const repo = new FakeRepo();
    const rs = await readSetOf(repo, HEAD, sem);
    await writeBundle(dir, buildBundle({ rule: sem, promise: p, commit: HEAD, readSet: rs, mutants: [ev(true)], harmlessControls: control, createdAt: at }));
    expect((await assuranceFor(dir, [sem], { promise: p, repo, commit: HEAD }))?.coverage).toBe('strong-control');
    expect((await assuranceFor(dir, [sem], { promise: { ...p, wording: 'Reworded.' }, repo, commit: HEAD }))?.coverage).not.toBe('strong-control');
    const changed = new FakeRepo({ [HEAD]: { ...FILES, 'src/routes/export.ts': 'changed\n' } });
    expect((await assuranceFor(dir, [sem], { promise: p, repo: changed, commit: HEAD }))?.coverage).toBe('limited-detector');
  });
});
