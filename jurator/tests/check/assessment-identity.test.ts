// P0: known-open scope stays visible; reader identity invalidates the zero-work fast path.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCheck } from '../../src/check/index.js';
import type { CheckRun } from '../../src/contracts.js';
import { renderRunMarkdown, renderRunText } from '../../src/render/index.js';
import { makeStyle } from '../../src/util/term.js';
import { FakeModel, FakeRepo, FakeStore, FILES, HEAD, fakeRunRule, fixedNow, promise, rule } from './fakes.js';

class DiskStore extends FakeStore {
  constructor(root: string, ...rest: ConstructorParameters<typeof FakeStore>) {
    super(...rest);
    Object.defineProperty(this, 'dir', { value: join(root, '.jurator') });
  }
  override async writeRun(run: CheckRun) {
    const path = join(this.dir, 'local', 'runs', run.id, 'run.json');
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, JSON.stringify(run), 'utf8');
    return path;
  }
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'kw-assess-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const P = [promise('security.01', { scope: ['src/routes/**'] }), promise('privacy.02', { scope: ['src/export/**'] })];
const R = [rule('R-security.01', 'security.01', ['src/routes/**'])];
const ANSWERS = {
  'ai-read:privacy.02': { verdict: 'kept', explanation: 'Filters.', citations: [{ path: 'src/export/query.ts', startLine: 2, endLine: 2 }] },
};
const rr = () => fakeRunRule({ 'R-security.01': { outcome: 'pass', hits: [['src/routes/export.ts', 5]] } });

describe('assurance on check results', () => {
  it('an open counterexample keeps HOLDS but is never an unqualified green; a reused answer carries it', async () => {
    const store = new DiskStore(dir, P, R);
    await mkdir(join(store.dir, 'local'), { recursive: true });
    const legacy = { version: 1, rules: { 'R-security.01': { promiseId: 'security.01', commit: HEAD, evasions: [{ path: 'src/routes/export.ts', find: 'a', replace: 'b', why: 'wrapped guard', judgeNote: 'n', round: 0, closed: false }] } } };
    await writeFile(join(store.dir, 'local', 'rule-mutants.json'), JSON.stringify(legacy), 'utf8');
    const repo = new FakeRepo();
    const run = await runCheck({ repo, store, model: new FakeModel(ANSWERS), target: { kind: 'repo', head: 'HEAD' }, aiRead: true, now: fixedNow }, { runRule: rr().fn });
    await store.writeRun(run);
    const r = run.results.find((x) => x.promiseId === 'security.01');
    expect(r?.verdict).toBe('holds');
    expect(r?.assurance).toMatchObject({ coverage: 'limited-detector', openCounterexamples: 1 });
    expect(r?.assurance?.warning).toContain('wrapped guard');
    expect(run.results.find((x) => x.promiseId === 'privacy.02')?.assurance).toBeUndefined();
    expect(renderRunText(run, makeStyle(false))).toContain('limited: 1 known miss');
    expect(renderRunMarkdown(run)).toContain('limited: 1 known miss');
    // Second run: zero-work fast path copies the answer and still carries the assurance.
    const again = await runCheck({ repo, store, model: new FakeModel(ANSWERS), target: { kind: 'repo', head: 'HEAD' }, aiRead: true, now: fixedNow }, { runRule: rr().fn });
    expect(again.incremental?.skippedUnchanged).toBe(true);
    expect(again.results.find((x) => x.promiseId === 'security.01')?.assurance?.openCounterexamples).toBe(1);
  });

  it('a rule with no assessment is unassessed and has no warning', async () => {
    const store = new DiskStore(dir, P, R);
    const run = await runCheck({ repo: new FakeRepo(), store, model: null as never, target: { kind: 'repo', head: 'HEAD' }, aiRead: false, now: fixedNow }, { runRule: rr().fn });
    expect(run.results.find((x) => x.promiseId === 'security.01')?.assurance).toEqual({ coverage: 'unassessed', openCounterexamples: 0 });
    expect(renderRunText(run, makeStyle(false))).not.toContain('limited');
  });
});

describe('fast path identity', () => {
  it('a different reader model at unchanged HEAD rechecks the AI read; the rule answer is unaffected', async () => {
    const store = new DiskStore(dir, P, R);
    const repo = new FakeRepo({ [HEAD]: { ...FILES } });
    const go = async (id: string) => {
      const model = new FakeModel(ANSWERS);
      Object.defineProperty(model, 'id', { value: id });
      const run = await runCheck({ repo, store, model, target: { kind: 'repo', head: 'HEAD' }, aiRead: true, now: fixedNow }, { runRule: rr().fn });
      await store.writeRun(run);
      return { run, model };
    };
    await go('m1');
    const same = await go('m1');
    expect(same.run.incremental?.skippedUnchanged).toBe(true);
    const other = await go('m2');
    expect(other.run.incremental?.skippedUnchanged).toBe(false);
    expect(other.model.requests.length).toBeGreaterThan(0);
    expect(other.run.results.find((x) => x.promiseId === 'security.01')?.reused).toBeDefined();
  });
});

describe('review fixes', () => {
  it('editing a binding on a clean tree invalidates the zero-work fast path', async () => {
    const store = new DiskStore(dir, P, R);
    const repo = new FakeRepo({ [HEAD]: { ...FILES } });
    const binding = (value: string) => ({
      id: 'B-security.01-1', promiseId: 'security.01', path: 'src/routes/export.ts', symbol: null, kind: 'guard' as const, startLine: 5, endLine: 5,
      quote: '  requireAdmin(req);', quoteSha256: '0'.repeat(64), anchoredAt: HEAD, expected: { op: '<=' as const, value, unit: 'days' }, foundBy: 'human' as const,
    });
    const go = async (value: string) => {
      const run = await runCheck({ repo, store, model: new FakeModel(ANSWERS), target: { kind: 'repo', head: 'HEAD' }, aiRead: true, now: fixedNow }, {
        runRule: rr().fn, readBindings: async () => [binding(value)], reanchor: async (b) => ({ startLine: 5, endLine: 5, quote: b.quote, status: 'same' }),
      });
      await store.writeRun(run);
      return run;
    };
    await go('30');
    expect((await go('30')).incremental?.skippedUnchanged).toBe(true);
    expect((await go('60')).incremental?.skippedUnchanged).toBe(false);
  });

  it('check-screen: a limited HOLDS shows the note and does not count as an unqualified hold', async () => {
    const { renderRunScreen } = await import('../../src/render/check-screen.js');
    const { createUi } = await import('../../src/ui/index.js');
    const store = new DiskStore(dir, P, R);
    const legacy = { version: 1, rules: { 'R-security.01': { promiseId: 'security.01', commit: HEAD, evasions: [{ path: 'p', find: 'a', replace: 'b', why: 'wrapped guard', judgeNote: 'n', round: 0, closed: false }] } } };
    await mkdir(join(store.dir, 'local'), { recursive: true });
    await writeFile(join(store.dir, 'local', 'rule-mutants.json'), JSON.stringify(legacy), 'utf8');
    const run = await runCheck({ repo: new FakeRepo(), store, model: new FakeModel(ANSWERS), target: { kind: 'repo', head: 'HEAD' }, aiRead: true, now: fixedNow }, { runRule: rr().fn });
    const text = renderRunScreen(run, createUi({ env: {}, caps: { color: 'none', width: 100, unicode: true } })).join('\n');
    expect(text).toContain('limited: 1 known miss');
    expect(text).toContain('hold, limited (known misses)');
  });
});
