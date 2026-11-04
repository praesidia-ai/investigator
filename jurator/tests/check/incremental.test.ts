// WP-C: the four cases of incremental checks , with fakes on a temp .jurator dir.
//  1. policies same + code same      -> nothing rechecked (fast path, zero work)
//  2. code changed, policies same     -> only promises whose code changed are rechecked
//  3. policies changed, code same     -> only promises that changed are rechecked
//  4. --full                          -> everything rechecked
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { lastVerified } from '../../src/cache/index.js';
import { runCheck, verifyRun, type CheckDeps } from '../../src/check/index.js';
import { checkRunSchema, type Binding, type CheckOptions, type CheckRun, type GitRepo, type PromiseRecord, type Rule } from '../../src/contracts.js';
import type { LineChange } from '../../src/bindings/index.js';
import { matchesAny } from '../../src/util/glob.js';
import { FakeModel, FakeStore, FILES, fakeRunRule, promise, rule } from './fakes.js';

const C1 = '1'.repeat(40);
const C2 = '2'.repeat(40);

/** A repo whose HEAD can move between commits. */
class Repo implements GitRepo {
  readonly root = '/nonexistent/wp-c-fake';
  head = C1;
  dirty = false;
  reads = 0;
  constructor(readonly commits: Record<string, Record<string, string>>) {}
  async snapshot() {
    return { repo: 'acme-notes', branch: 'main', commit: this.head, dirty: this.dirty };
  }
  async resolve(ref: string) {
    if (ref === 'HEAD') return this.head;
    if (ref === 'main') return C1;
    if (this.commits[ref]) return ref;
    throw new Error(`unknown ref ${ref}`);
  }
  async listFiles(commit: string, globs: readonly string[]) {
    return Object.keys(this.commits[commit] ?? {})
      .filter((p) => matchesAny(p, globs))
      .sort();
  }
  async readFile(commit: string, path: string) {
    this.reads += 1;
    const text = this.commits[commit]?.[path];
    if (text === undefined) throw new Error(`no ${path} at ${commit}`);
    return text;
  }
  async changedFiles(base: string, head: string) {
    const a = this.commits[await this.resolve(base)] ?? {};
    const b = this.commits[await this.resolve(head)] ?? {};
    return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((p) => a[p] !== b[p]).sort();
  }
}

class DiskStore extends FakeStore {
  constructor(
    readonly root: string,
    promises: PromiseRecord[],
    rules: Rule[],
  ) {
    super(promises, rules);
    Object.defineProperty(this, 'dir', { value: join(root, '.jurator') });
  }
  override async writeRun(run: CheckRun) {
    const path = join(this.dir, 'local', 'runs', run.id, 'run.json');
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, JSON.stringify(run), 'utf8');
    this.runs.push(run);
    return path;
  }
}

const PROMISES = [
  promise('security.01', { scope: ['src/routes/**'] }),
  promise('privacy.01', { scope: ['src/agent/**'] }),
  promise('privacy.02', { scope: ['src/export/**'] }), // no rule: read by AI
];
const RULES = [rule('R-security.01', 'security.01', ['src/routes/**']), rule('R-privacy.01', 'privacy.01', ['src/agent/**'])];
const ANSWERS = {
  'ai-read:privacy.02': { verdict: 'kept', explanation: 'Filters deleted and archived.', citations: [{ path: 'src/export/query.ts', startLine: 2, endLine: 2 }] },
};

let dir: string;
let tick = 0;
const now = () => new Date(Date.UTC(2026, 10, 4, 4, 30, tick++));
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'kw-incr-'));
  tick = 0;
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function setup(commits: Record<string, Record<string, string>> = { [C1]: { ...FILES } }) {
  const repo = new Repo(commits);
  const store = new DiskStore(dir, PROMISES.map((p) => ({ ...p })), RULES.map((r) => ({ ...r })));
  const model = new FakeModel(ANSWERS, 0.02);
  const rr = fakeRunRule({ 'R-security.01': { outcome: 'pass', hits: [['src/routes/export.ts', 5]] }, 'R-privacy.01': { outcome: 'pass', hits: [['src/agent/chats.ts', 1]] } });
  const check = async (target: CheckOptions['target'] = { kind: 'repo', head: 'HEAD' }, extra: CheckDeps = {}) => {
    const run = await runCheck({ repo, store, model, target, aiRead: true, now }, { runRule: rr.fn, ...extra });
    await store.writeRun(run);
    return run;
  };
  return { repo, store, model, rr, check };
}
const reusedIds = (run: CheckRun) => run.results.filter((r) => r.reused).map((r) => r.promiseId);

describe('incremental checks: the four cases', () => {
  it('first run checks everything and records the verified pair', async () => {
    const { store, model, rr, check } = setup();
    const run = await check();
    expect(checkRunSchema.parse(run)).toBeTruthy();
    expect(run.incremental).toEqual({ rechecked: 3, reused: 0, skippedUnchanged: false });
    expect(run.policyState).toMatch(/^[0-9a-f]{64}$/u);
    expect(run.results.every((r) => typeof r.cacheKey === 'string' && !r.reused)).toBe(true);
    expect(rr.calls).toHaveLength(2);
    expect(model.requests).toHaveLength(1);
    expect(await lastVerified(store)).toMatchObject({ commit: C1, policyState: run.policyState, runId: run.id });
  });

  it('1. policies same + code same: nothing rechecked, answers copied from the verified run, no rule and no AI', async () => {
    const { model, rr, check, repo, store } = setup();
    const first = await check();
    const readsBefore = repo.reads;
    const second = await check();
    expect(second.incremental).toEqual({ rechecked: 0, reused: 3, skippedUnchanged: true });
    expect(second.results.map((r) => r.reused)).toEqual(first.results.map(() => ({ fromRun: first.id, fromCommit: C1 })));
    expect(second.results.map((r) => r.verdict)).toEqual(first.results.map((r) => r.verdict));
    expect(rr.calls).toHaveLength(2); // only the first run's
    expect(model.requests).toHaveLength(1);
    expect(repo.reads).toBe(readsBefore); // zero work: not one file read
    expect(second.costUsd).toBe(0);
    expect(second.policyState).toBe(first.policyState);
    expect((await verifyRun(second, repo, { store, runRule: rr.fn })).ok).toBe(true);
  });

  it('2. code changed, policies same: only the promise whose files changed is rechecked; the AI read is reused', async () => {
    const changedRoutes = { ...FILES, 'src/routes/export.ts': FILES['src/routes/export.ts']?.replace("res.send('csv')", "res.send('csv2')") ?? '' };
    const { repo, model, rr, check, store } = setup({ [C1]: { ...FILES }, [C2]: changedRoutes });
    await check();
    repo.head = C2;
    const second = await check({ kind: 'repo', head: 'HEAD' });
    expect(second.incremental).toEqual({ rechecked: 1, reused: 2, skippedUnchanged: false });
    expect(reusedIds(second).sort()).toEqual(['privacy.01', 'privacy.02']);
    expect(rr.calls.map((c) => `${c.ruleId}@${c.commit.slice(0, 1)}`).sort()).toEqual(['R-privacy.01@1', 'R-security.01@1', 'R-security.01@2']);
    expect(model.requests).toHaveLength(1); // the AI read was not paid for again
    // Reused evidence is re-copied at the new head, so verify reads it at C2.
    const p2 = second.results.find((r) => r.promiseId === 'privacy.02');
    expect(p2?.citations[0]?.commit).toBe(C2);
    expect(p2?.reused?.fromCommit).toBe(C1);
    expect((await verifyRun(second, repo, { store, runRule: rr.fn })).ok).toBe(true);
    expect(second.costUsd).toBe(0);

    // A diff only selects touched promises; the cached answers still apply.
    const diff = await check({ kind: 'diff', base: 'main', head: 'HEAD' });
    expect(diff.results.map((r) => r.promiseId)).toEqual(['security.01']);
  });

  it('3. policies changed, code same: only the changed promise is rechecked, against the same code', async () => {
    const { store, model, rr, check } = setup();
    const first = await check();
    store.promises = store.promises.map((p) =>
      p.id === 'privacy.02' ? { ...p, wording: 'Exports leave out deleted and archived notes.' } : { ...p, quote: { ...p.quote, line: 9 } },
    );
    const second = await check();
    expect(second.policyState).not.toBe(first.policyState);
    expect(second.incremental).toEqual({ rechecked: 1, reused: 2, skippedUnchanged: false });
    expect(reusedIds(second).sort()).toEqual(['privacy.01', 'security.01']);
    expect(model.requests.map((r) => r.task)).toEqual(['ai-read:privacy.02', 'ai-read:privacy.02']);
    expect(rr.calls).toHaveLength(2); // rules not rerun: their promises and files are the same
    // The reused result carries the current promise's words and quote.
    expect(second.results.find((r) => r.promiseId === 'security.01')?.policyQuote.line).toBe(9);

    // A changed rule rechecks its promise only.
    store.rules = store.rules.map((r) => (r.id === 'R-privacy.01' ? { ...r, pattern: 'CHAT_TTL_DAYS = 30' } : r));
    const third = await check();
    expect(third.incremental).toEqual({ rechecked: 1, reused: 2, skippedUnchanged: false });
    expect(reusedIds(third).sort()).toEqual(['privacy.02', 'security.01']);
  });

  it('4. --full rechecks everything and still records the pair', async () => {
    const { model, rr, check, store } = setup();
    await check();
    const full = await check({ kind: 'repo', head: 'HEAD' }, { full: true });
    expect(full.incremental).toEqual({ rechecked: 3, reused: 0, skippedUnchanged: false });
    expect(rr.calls).toHaveLength(4);
    expect(model.requests).toHaveLength(2);
    expect((await lastVerified(store))?.runId).toBe(full.id);
  });
});

describe('incremental checks: edges', () => {
  it('a dirty tree skips the fast path, but unchanged answers are still reused by content', async () => {
    const { repo, check, model } = setup();
    await check();
    repo.dirty = true;
    const second = await check();
    expect(second.incremental).toEqual({ rechecked: 0, reused: 3, skippedUnchanged: false });
    expect(model.requests).toHaveLength(1);
  });

  it('a run without AI (a hook) never stands in for an AI read', async () => {
    const { repo, store, check, model } = setup();
    const hook = await runCheck({ repo, store, model: null, target: { kind: 'repo', head: 'HEAD' }, aiRead: false, now }, { runRule: fakeRunRule({}).fn });
    await store.writeRun(hook);
    expect(hook.results.find((r) => r.promiseId === 'privacy.02')?.verdict).toBe('not-checked');
    const withAi = await check();
    expect(withAi.incremental?.skippedUnchanged).toBe(false);
    expect(withAi.results.find((r) => r.promiseId === 'privacy.02')).toMatchObject({ verdict: 'looks-kept' });
    expect(model.requests).toHaveLength(1);
    expect(withAi.incremental).toEqual({ rechecked: 1, reused: 2, skippedUnchanged: false });
  });

  it('a cached answer whose cited lines are no longer there is not reused', async () => {
    // Bound AI read: the key only sees the bound line, so the safety net (re-copy every cited line) must catch it.
    const shifted = { ...FILES, 'src/export/query.ts': `// moved down\n${FILES['src/export/query.ts']}` };
    const { repo, store, model, check, rr } = setup({ [C1]: { ...FILES }, [C2]: shifted });
    const binding: Binding = {
      id: 'B-privacy.02-1',
      promiseId: 'privacy.02',
      path: 'src/export/query.ts',
      symbol: 'exportableNotes',
      kind: 'other',
      startLine: 1,
      endLine: 1,
      quote: 'export function exportableNotes(all, ws) {',
      quoteSha256: '0'.repeat(64),
      anchoredAt: C1,
      expected: null,
      foundBy: 'model',
    };
    const deps: CheckDeps = {
      readBindings: async () => [binding],
      reanchor: async (b) => ({ startLine: b.startLine, endLine: b.endLine, quote: b.quote, status: 'same' }),
    };
    void store;
    await check({ kind: 'repo', head: 'HEAD' }, deps);
    repo.head = C2;
    const second = await check({ kind: 'repo', head: 'HEAD' }, deps);
    expect(second.results.find((r) => r.promiseId === 'privacy.02')?.reused).toBeUndefined();
    expect(model.requests).toHaveLength(2);
    expect((await verifyRun(second, repo, { store, runRule: rr.fn })).ok).toBe(true);
  });

  it('a diff selects promises whose bound lines were touched, with the reason as the trigger', async () => {
    const changed = { ...FILES, 'src/log.ts': "const SECRET_KEYS = ['password'];\nexport function log() {}\n" };
    const { repo, check } = setup({ [C1]: { ...FILES }, [C2]: changed });
    repo.head = C2;
    const binding: Binding = {
      id: 'B-privacy.01-1',
      promiseId: 'privacy.01',
      path: 'src/log.ts',
      symbol: 'SECRET_KEYS',
      kind: 'allowlist',
      startLine: 1,
      endLine: 1,
      quote: "const SECRET_KEYS = ['password', 'cardNumber'];",
      quoteSha256: '0'.repeat(64),
      anchoredAt: C1,
      expected: null,
      foundBy: 'human',
    };
    const change: LineChange = { path: 'src/log.ts', oldStart: 1, oldLines: 1, newStart: 1, newLines: 1 };
    const run = await check(
      { kind: 'diff', base: 'main', head: 'HEAD' },
      {
        readBindings: async () => [binding],
        changedLines: async () => [change],
        touchedBindings: (bs) => bs.map((b) => ({ binding: b, reason: `touched ${b.symbol ?? b.path} (bound to ${b.promiseId})` })),
      },
    );
    // privacy.01's scope (src/agent/**) did not change; only its binding in src/log.ts did.
    expect(run.results.map((r) => [r.promiseId, r.trigger])).toEqual([['privacy.01', 'touched SECRET_KEYS (bound to privacy.01)']]);
  });

  it('a broken rule with a "Was" line at the base is not cached by content (only the same pair copies it)', async () => {
    const ninety = { ...FILES, 'src/agent/chats.ts': 'export const CHAT_TTL_DAYS = 90;\n' };
    const { repo, store, check } = setup({ [C1]: { ...FILES }, [C2]: ninety });
    repo.head = C2;
    let calls = 0;
    const runRule: CheckDeps['runRule'] = (r, files, commit) => {
      calls += 1;
      const f = files.find((x) => /= 30;/u.test(x.text));
      return f
        ? { ruleId: r.id, promiseId: r.promiseId, outcome: 'pass', hits: [{ path: f.path, commit, startLine: 1, endLine: 1, quote: f.text.trim() }], message: 'found' }
        : { ruleId: r.id, promiseId: r.promiseId, outcome: r.promiseId === 'privacy.01' ? 'fail' : 'pass', hits: [], message: 'no = 30' };
    };
    store.promises = [store.promises[1] as PromiseRecord];
    store.rules = [store.rules[1] as Rule];
    const a = await check({ kind: 'diff', base: 'main', head: 'HEAD' }, { runRule });
    const b = await check({ kind: 'diff', base: 'main', head: 'HEAD' }, { runRule });
    expect(a.results[0]?.verdict).toBe('broken');
    expect(b.results[0]).toMatchObject({ verdict: 'broken' });
    expect(b.results[0]?.citations.map((c) => c.commit)).toEqual([C2, C1]);
    expect(b.incremental?.skippedUnchanged).toBe(true); // same pair: copied from the verified run, Was line kept
    expect(calls).toBe(2); // run 1: at the head + at the base; run 2 is the fast path
    expect((await verifyRun(b, repo, { store, runRule })).ok).toBe(true); // verify re-runs the rule once at the head
    repo.dirty = true; // no fast path: the content cache has no entry for it, so the rule runs again
    const c = await check({ kind: 'diff', base: 'main', head: 'HEAD' }, { runRule });
    expect(c.incremental).toEqual({ rechecked: 1, reused: 0, skippedUnchanged: false });
    expect(calls).toBe(5);
  });
});
