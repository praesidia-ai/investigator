// FX-1: the check never says HOLDS for the E-1/E-2 probes, value bindings enforce what the policy expects, a rule
// that finds nothing falls back honestly, and `verify` re-runs the rules so a forged record fails.
import { describe, expect, it } from 'vitest';
import { digestOf, runCheck, verifyRun } from '../../src/check/index.js';
import type { Binding, CheckRun, PromiseRecord } from '../../src/contracts.js';
import { sha256 } from '../../src/util/json.js';
import { BASE, FakeModel, FakeRepo, FakeStore, FILES, fixedNow, HEAD, promise, rule } from './fakes.js';

const repoTarget = { kind: 'repo' as const, head: 'HEAD' };
const facets: PromiseRecord['facets'] = {
  subject: 'support chats',
  action: 'delete',
  constraint: { name: 'retention', op: '<=', value: '30', unit: 'days' },
};
const privacy01 = (over: Partial<PromiseRecord> = {}) => promise('privacy.01', { scope: ['src/agent/**'], facets, ...over });
const ttlRule = (pattern = 'CHAT_TTL_DAYS\\s*=\\s*30\\b') =>
  rule('R-privacy.01-1', 'privacy.01', ['src/agent/**'], { mode: 'must-match', pattern, anchor: undefined, within: undefined });
const repoWith = (chats: string, extra: Record<string, string> = {}) =>
  new FakeRepo({ [HEAD]: { ...FILES, 'src/agent/chats.ts': chats, ...extra }, [BASE]: { ...FILES } });
const quote = 'export const CHAT_TTL_DAYS = 30;';
const binding: Binding = {
  id: 'B-privacy.01-1',
  promiseId: 'privacy.01',
  path: 'src/agent/chats.ts',
  symbol: 'CHAT_TTL_DAYS',
  kind: 'constant',
  startLine: 1,
  endLine: 1,
  quote,
  quoteSha256: sha256(quote),
  anchoredAt: BASE,
  expected: { op: '<=', value: '30', unit: 'days' },
  foundBy: 'rule',
};
const check = (repo: FakeRepo, store: FakeStore, bindings: Binding[] = [], model: FakeModel | null = null) =>
  runCheck({ repo, store, model, target: repoTarget, aiRead: model !== null, now: fixedNow }, { readBindings: async () => bindings });

describe('E-1 probes through the whole check (real rules engine)', () => {
  it('`CHAT_TTL_DAYS = 30 * 3` is BROKEN, not HOLDS, and the exit code would block', async () => {
    const run = await check(repoWith('export const CHAT_TTL_DAYS = 30 * 3;\n'), new FakeStore([privacy01()], [ttlRule()]));
    expect(run.results[0]).toMatchObject({ verdict: 'broken', level: 'rule' });
    expect(run.results[0]?.explanation).toContain('CHAT_TTL_DAYS is 90 (30 * 3); the policy allows at most 30 days');
  });
  it('the old value in a comment above the new one is BROKEN, and cites the real line', async () => {
    const run = await check(repoWith('// was: CHAT_TTL_DAYS = 30\nexport const CHAT_TTL_DAYS = 90;\n'), new FakeStore([privacy01()], [ttlRule()]));
    expect(run.results[0]).toMatchObject({ verdict: 'broken', level: 'rule' });
    expect(run.results[0]?.citations[0]).toMatchObject({ startLine: 2, quote: 'export const CHAT_TTL_DAYS = 90;' });
  });
});

describe('bindings enforce what the policy expects', () => {
  it('a weak rule (the name only) passes, but the bound constant is 90: BROKEN at level rule, with the binding as evidence', async () => {
    const store = new FakeStore([privacy01({ facets: undefined })], [ttlRule('CHAT_TTL_DAYS')]);
    const run = await check(repoWith('export const CHAT_TTL_DAYS = 90;\n'), store, [binding]);
    const r = run.results[0];
    expect(r).toMatchObject({ verdict: 'broken', level: 'rule' });
    expect(r?.explanation).toBe('src/agent/chats.ts:1: CHAT_TTL_DAYS is 90; the policy allows at most 30 days (binding B-privacy.01-1)');
    expect(r?.ruleResults?.map((x) => [x.ruleId, x.outcome])).toEqual([
      ['R-privacy.01-1', 'pass'],
      ['B-privacy.01-1', 'fail'],
    ]);
    expect(r?.citations).toEqual([{ path: 'src/agent/chats.ts', commit: HEAD, startLine: 1, endLine: 1, quote: 'export const CHAT_TTL_DAYS = 90;' }]);
  });
  it('with no rule at all, a bound literal that breaks the number is still BROKEN (no AI)', async () => {
    const run = await check(repoWith('export const CHAT_TTL_DAYS = 30 * 3;\n'), new FakeStore([privacy01()]), [binding]);
    expect(run.results[0]).toMatchObject({ verdict: 'broken', level: 'rule' });
    expect(run.results[0]?.explanation).toContain('CHAT_TTL_DAYS is 90 (30 * 3)');
  });
  it('a bound literal that keeps the number adds evidence but never makes HOLDS on its own', async () => {
    const run = await check(repoWith('export const CHAT_TTL_DAYS = 30;\n'), new FakeStore([privacy01()]), [binding]);
    expect(run.results[0]).toMatchObject({ verdict: 'not-checked', level: 'quick' });
    const withRule = await check(repoWith('export const CHAT_TTL_DAYS = 30;\n'), new FakeStore([privacy01()], [ttlRule()]), [binding]);
    expect(withRule.results[0]).toMatchObject({ verdict: 'holds', level: 'rule' });
    expect(withRule.results[0]?.ruleResults?.map((x) => x.outcome)).toEqual(['pass', 'pass']);
  });
});

describe('a rule that finds nothing to check is never HOLDS', () => {
  const routeRule = rule('R-security.01-1', 'security.01', ['src/routes/**'], {
    anchor: "router\\.(?:get|post)\\(\\s*['\"]/export",
  });
  const appRoutes = { 'src/routes/export.ts': "app.get('/export.csv', handler);\n" };
  it('without AI: NOT CHECKED with the reason, and the run is still complete (it is an answer, not a crash)', async () => {
    const run = await check(repoWith('export const CHAT_TTL_DAYS = 30;\n', appRoutes), new FakeStore([promise('security.01')], [routeRule]));
    expect(run.results[0]).toMatchObject({ verdict: 'not-checked', level: 'quick' });
    expect(run.results[0]?.reason).toMatch(/^rule found nothing to check: /u);
    expect(run.status).toBe('completed');
  });
  it('with AI: falls back to an AI read, which can only say LOOKS ..., and keeps the reason', async () => {
    const model = new FakeModel({ 'ai-read:security.01': { verdict: 'broken', explanation: 'No admin check.', citations: [{ path: 'src/routes/export.ts', startLine: 1, endLine: 1 }] } });
    const run = await check(repoWith('export const CHAT_TTL_DAYS = 30;\n', appRoutes), new FakeStore([promise('security.01')], [routeRule]), [], model);
    expect(run.results[0]).toMatchObject({ verdict: 'looks-broken', level: 'ai-read' });
    expect(run.results[0]?.reason).toMatch(/^rule found nothing to check/u);
    expect(run.results[0]?.ruleResults?.[0]?.outcome).toBe('error');
  });
});

describe('verify re-runs the rules: a forged record fails', () => {
  /** E-2's forge: every BROKEN becomes HOLDS, rule outcomes become pass, the digest is recomputed. */
  function forge(run: CheckRun): CheckRun {
    const copy = JSON.parse(JSON.stringify(run)) as CheckRun;
    const results = copy.results.map((r) =>
      r.verdict === 'broken'
        ? { ...r, verdict: 'holds' as const, citations: [], ruleResults: (r.ruleResults ?? []).map((x) => ({ ...x, outcome: 'pass' as const, hits: [] })) }
        : r,
    );
    const forged = { ...copy, results, summary: { ...copy.summary, holds: copy.summary.holds + copy.summary.broken, broken: 0 } };
    return { ...forged, digest: digestOf(forged) };
  }

  it('the honest record verifies; the forged one does not, and says which rule disagrees', async () => {
    const store = new FakeStore([privacy01()], [ttlRule()]);
    const repo = repoWith('export const CHAT_TTL_DAYS = 30 * 3;\n');
    const run = await check(repo, store);
    expect((await verifyRun(run, repo, { store })).ok).toBe(true);
    const report = await verifyRun(forge(run), repo, { store });
    expect(report.ok).toBe(false);
    expect(report.problems).toEqual([
      `privacy.01: R-privacy.01-1 fails when re-run at ${HEAD.slice(0, 7)}, but the record says pass.`,
      `privacy.01: the record says holds, but its rules say broken at ${HEAD.slice(0, 7)}.`,
    ]);
  });
  it('rules and bindings are read from git at the record commit when the workspace has none', async () => {
    const store = new FakeStore([privacy01({ facets: undefined })], [ttlRule('CHAT_TTL_DAYS')]);
    const files = { '.jurator/rules.json': JSON.stringify({ schemaVersion: 1, items: store.rules }), '.jurator/bindings.json': JSON.stringify({ schemaVersion: 1, items: [binding] }) };
    const repo = repoWith('export const CHAT_TTL_DAYS = 90;\n', files);
    const run = await check(repo, store, [binding]);
    expect(run.results[0]?.verdict).toBe('broken');
    const report = await verifyRun(forge(run), repo); // no store: git only
    expect(report.ok).toBe(false);
    expect(report.problems).toContain(`privacy.01: B-privacy.01-1 fails when re-run at ${HEAD.slice(0, 7)}, but the record says pass.`);
    expect((await verifyRun(run, repo)).ok).toBe(true);
  });
  it('a rule the record names that exists nowhere cannot be confirmed', async () => {
    const store = new FakeStore([privacy01()], [ttlRule()]);
    const repo = repoWith('export const CHAT_TTL_DAYS = 30;\n');
    const run = await check(repo, store);
    const report = await verifyRun(run, repo, { store: new FakeStore([]) });
    expect(report.ok).toBe(false);
    expect(report.problems[0]).toMatch(/R-privacy\.01-1 is not in \.jurator\/rules\.json at .* or here/u);
  });
});
