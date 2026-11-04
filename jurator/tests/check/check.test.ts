import { describe, expect, it } from 'vitest';
import { copyCitations, digestOf, exitCodeFor, runCheck, verifyRun } from '../../src/check/index.js';
import { checkRunSchema, type CheckRun } from '../../src/contracts.js';
import { BASE, FakeModel, FakeRepo, FakeStore, FILES, fakeRunRule, fixedNow, HEAD, promise, rule } from './fakes.js';

const repoTarget = { kind: 'repo' as const, head: 'HEAD' };

describe('rule first', () => {
  it('a failing rule makes the promise BROKEN at level rule, with quotes copied from git', async () => {
    const repo = new FakeRepo();
    const store = new FakeStore([promise('security.01', { scope: ['src/routes/**'] })], [rule('R-security.01', 'security.01', ['src/routes/**'])]);
    const rr = fakeRunRule({ 'R-security.01': { outcome: 'fail', hits: [['src/routes/export.ts', 9]] } });
    const model = new FakeModel({});
    const run = await runCheck({ repo, store, model, target: repoTarget, aiRead: true, now: fixedNow }, { runRule: rr.fn });

    expect(checkRunSchema.parse(run)).toBeTruthy();
    const [r] = run.results;
    expect(r?.verdict).toBe('broken');
    expect(r?.level).toBe('rule');
    expect(r?.explanation).toBe('R-security.01: fail');
    expect(r?.citations).toEqual([
      { path: 'src/routes/export.ts', commit: HEAD, startLine: 9, endLine: 9, quote: "router.get('/export.csv', async (req, res) => {" },
    ]);
    expect(rr.calls).toEqual([{ ruleId: 'R-security.01', files: ['src/routes/export.ts'], commit: HEAD }]);
    expect(model.requests).toHaveLength(0);
    expect(run.summary).toMatchObject({ broken: 1, holds: 0, coveredByRules: 1, codePromises: 1, checked: 1 });
  });

  it('a must-match rule broken by a diff cites the line it matched at the base and the line that replaced it', async () => {
    const head = { ...FILES, 'src/agent/chats.ts': ['export const CHAT_TTL_DAYS = 90;', ''].join('\n') };
    const repo = new FakeRepo({ [HEAD]: head, [BASE]: { ...FILES } }, ['src/agent/chats.ts']);
    const store = new FakeStore([promise('privacy.01', { scope: ['src/agent/**'] })], [rule('R-privacy.01', 'privacy.01', ['src/agent/**'])]);
    // Passes where a line has "= 30", fails with no hits elsewhere (a must-match rule).
    const runRule = (r: { id: string; promiseId: string }, files: readonly { path: string; text: string }[], commit: string) => {
      const hit = files.flatMap((f) => f.text.split('\n').map((t, i) => ({ path: f.path, t, i }))).find((x) => /= 30;/u.test(x.t));
      return hit
        ? { ruleId: r.id, promiseId: r.promiseId, outcome: 'pass' as const, hits: [{ path: hit.path, commit, startLine: hit.i + 1, endLine: hit.i + 1, quote: hit.t }], message: 'found' }
        : { ruleId: r.id, promiseId: r.promiseId, outcome: 'fail' as const, hits: [], message: 'no line has = 30' };
    };
    const run = await runCheck({ repo, store, model: null, target: { kind: 'diff', base: 'main', head: 'HEAD' }, aiRead: false, now: fixedNow }, { runRule });
    expect(run.results[0]).toMatchObject({ verdict: 'broken', level: 'rule' });
    expect(run.results[0]?.citations).toEqual([
      { path: 'src/agent/chats.ts', commit: HEAD, startLine: 1, endLine: 1, quote: 'export const CHAT_TTL_DAYS = 90;' },
      { path: 'src/agent/chats.ts', commit: BASE, startLine: 1, endLine: 1, quote: 'export const CHAT_TTL_DAYS = 30;' },
    ]);
    expect((await verifyRun(run, repo, { store, runRule })).ok).toBe(true);
  });

  it('all rules passing makes it HOLDS; a rule error leaves it NOT CHECKED and the run incomplete', async () => {
    const store = new FakeStore(
      [promise('security.01'), promise('privacy.01')],
      [rule('R-security.01', 'security.01', ['src/routes/**']), rule('R-privacy.01', 'privacy.01', ['src/agent/**'])],
    );
    const rr = fakeRunRule({ 'R-security.01': { outcome: 'pass', hits: [['src/routes/export.ts', 5]] }, 'R-privacy.01': { outcome: 'error' } });
    const run = await runCheck({ repo: new FakeRepo(), store, model: null, target: repoTarget, aiRead: false, now: fixedNow }, { runRule: rr.fn });
    const byId = Object.fromEntries(run.results.map((r) => [r.promiseId, r]));
    expect(byId['security.01']).toMatchObject({ verdict: 'holds', level: 'rule' });
    expect(byId['security.01']?.citations[0]?.quote).toBe('  requireAdmin(req);');
    expect(byId['privacy.01']).toMatchObject({ verdict: 'not-checked', level: 'quick' });
    expect(run.status).toBe('incomplete');
  });

  it('ignores proposed rules', async () => {
    const store = new FakeStore([promise('security.01')], [rule('R-security.01', 'security.01', ['src/routes/**'], { status: 'proposed' })]);
    const rr = fakeRunRule({ 'R-security.01': { outcome: 'fail' } });
    const run = await runCheck({ repo: new FakeRepo(), store, model: null, target: repoTarget, aiRead: false, now: fixedNow }, { runRule: rr.fn });
    expect(run.results[0]).toMatchObject({ verdict: 'not-checked', level: 'quick', reason: 'no rule yet; AI off' });
    expect(run.summary.coveredByRules).toBe(0);
  });
});

describe('AI read fallback', () => {
  const answers = {
    'ai-read:privacy.01': { verdict: 'kept', explanation: 'TTL is 30 days.', citations: [{ path: 'src/agent/chats.ts', startLine: 1, endLine: 1 }] },
    'ai-read:privacy.02': {
      verdict: 'broken',
      explanation: 'Filter misses archived.',
      citations: [{ path: 'src/export/query.ts', startLine: 2, endLine: 2 }],
    },
    'ai-read:privacy.03': { verdict: 'cant-tell', explanation: 'Nothing about selling.', citations: [] },
  };
  const promises = [
    promise('privacy.01', { scope: ['src/agent/**'] }),
    promise('privacy.02', { scope: ['src/export/**'] }),
    promise('privacy.03'),
  ];

  it('maps kept/broken/cant-tell to LOOKS KEPT / LOOKS BROKEN / CANT TELL at level ai-read', async () => {
    const model = new FakeModel(answers, 0.02);
    const run = await runCheck({ repo: new FakeRepo(), store: new FakeStore(promises), model, target: repoTarget, aiRead: true, now: fixedNow });
    expect(run.results.map((r) => [r.promiseId, r.verdict, r.level])).toEqual([
      ['privacy.01', 'looks-kept', 'ai-read'],
      ['privacy.02', 'looks-broken', 'ai-read'],
      ['privacy.03', 'cant-tell', 'ai-read'],
    ]);
    expect(run.results[0]?.model?.usd).toBe(0.02);
    expect(run.costUsd).toBe(0.06);
    expect(run.summary).toMatchObject({ looksKept: 1, looksBroken: 1, cantTell: 1, broken: 0, coveredByRules: 0 });
    expect(exitCodeFor(run)).toBe(0); // an AI read alone never fails the check
    const req = model.requests.find((r) => r.task === 'ai-read:privacy.02');
    expect(req?.input).toContain('=== src/export/query.ts');
    expect(req?.input).toContain('   2    return all.filter');
    expect(req?.input).not.toContain('src/agent/chats.ts');
  });

  it('a failed model call becomes CANT TELL with a reason and marks the run incomplete', async () => {
    const model = new FakeModel({ ...answers, 'ai-read:privacy.02': new Error('Meta is down') });
    const run = await runCheck({ repo: new FakeRepo(), store: new FakeStore(promises), model, target: repoTarget, aiRead: true, now: fixedNow });
    expect(run.results[1]).toMatchObject({ verdict: 'cant-tell', level: 'ai-read', reason: 'AI read failed: Meta is down' });
    expect(run.status).toBe('incomplete');
  });

  it('with AI off, promises without a rule are NOT CHECKED (quick)', async () => {
    const model = new FakeModel(answers);
    const run = await runCheck({ repo: new FakeRepo(), store: new FakeStore(promises), model, target: repoTarget, aiRead: false, now: fixedNow });
    expect(run.results.every((r) => r.verdict === 'not-checked' && r.level === 'quick')).toBe(true);
    expect(model.requests).toHaveLength(0);
  });

  it('stops reading by AI once the run budget is spent', async () => {
    const ids = ['privacy.01', 'privacy.02', 'privacy.03', 'privacy.04', 'privacy.05'];
    const store = new FakeStore(ids.map((id) => promise(id)));
    store.config = { ...store.config, budgetUsdPerRun: 0.01 };
    const model = new FakeModel(Object.fromEntries(ids.map((id) => [`ai-read:${id}`, { verdict: 'kept', explanation: 'ok', citations: [] }])), 0.5);
    const run = await runCheck({ repo: new FakeRepo(), store, model, target: repoTarget, aiRead: true, now: fixedNow }, {});
    expect(run.results.some((r) => r.verdict === 'not-checked' && /budget/u.test(r.reason ?? ''))).toBe(true);
  });
});

describe('citations: the program copies, the model only points', () => {
  const sent = new Map([['src/export/query.ts', FILES['src/export/query.ts'] as string]]);

  it('copies quotes from the sent git text and drops citations to unsent files or missing lines', () => {
    const { citations, dropped } = copyCitations(
      [
        { path: 'src/export/query.ts', startLine: 1, endLine: 2 },
        { path: 'src/secret.ts', startLine: 1, endLine: 1 },
        { path: 'src/export/query.ts', startLine: 40, endLine: 41 },
        { path: 'src/export/query.ts', startLine: 0, endLine: 1 },
        { path: 'src/export/query.ts', startLine: 3, endLine: 99 },
      ],
      sent,
      HEAD,
    );
    expect(dropped).toBe(3);
    expect(citations).toEqual([
      {
        path: 'src/export/query.ts',
        commit: HEAD,
        startLine: 1,
        endLine: 2,
        quote: 'export function exportableNotes(all, ws) {\n  return all.filter((n) => n.workspaceId === ws && n.deletedAt === null && n.archivedAt === null);',
      },
      { path: 'src/export/query.ts', commit: HEAD, startLine: 3, endLine: 3, quote: '}' },
    ]);
  });

  it('a "broken" with no valid citation becomes CANT TELL', async () => {
    const model = new FakeModel({
      'ai-read:privacy.02': { verdict: 'broken', explanation: 'Trust me.', citations: [{ path: 'src/nowhere.ts', startLine: 3, endLine: 4 }] },
    });
    const store = new FakeStore([promise('privacy.02', { scope: ['src/export/**'] })]);
    const run = await runCheck({ repo: new FakeRepo(), store, model, target: repoTarget, aiRead: true, now: fixedNow });
    expect(run.results[0]).toMatchObject({ verdict: 'cant-tell', level: 'ai-read', citations: [] });
    expect(run.results[0]?.reason).toMatch(/cited no lines/u);
  });
});

describe('diff selection', () => {
  it('selects promises whose scope (or codeScope, or a rule glob) matches a changed file', async () => {
    const repo = new FakeRepo(undefined, ['src/routes/export.ts']);
    const store = new FakeStore(
      [
        promise('security.01', { scope: ['src/routes/**'] }),
        promise('privacy.01', { scope: ['src/agent/**'] }),
        promise('privacy.02', { scope: ['src/export/**'] }),
        promise('privacy.03'), // empty scope -> config.codeScope (src/**)
        promise('privacy.04', { checkable: 'process', scope: ['src/routes/**'] }),
        promise('praesidia.01', { checkable: 'runtime' }),
        promise('security.02', { status: 'draft', scope: ['src/routes/**'] }),
        promise('security.03', { status: 'retired', scope: ['src/routes/**'] }),
      ],
      [rule('R-privacy.02', 'privacy.02', ['src/routes/**', 'src/export/**'])],
    );
    const rr = fakeRunRule({ 'R-privacy.02': { outcome: 'pass' } });
    const run = await runCheck(
      { repo, store, model: null, target: { kind: 'diff', base: 'main', head: 'HEAD' }, aiRead: false, now: fixedNow },
      { runRule: rr.fn },
    );
    expect(run.results.map((r) => r.promiseId)).toEqual(['privacy.02', 'privacy.03', 'security.01']);
    expect(run.checklist).toEqual([{ promiseId: 'privacy.04', text: 'Before merge: Wording of privacy.04.' }]);
    expect(run.target).toEqual({ kind: 'diff', base: 'main', head: HEAD, changedFiles: ['src/routes/export.ts'] });
    expect(run.summary).toMatchObject({ promises: 6, codePromises: 4, coveredByRules: 1, holds: 1, notChecked: 2 });
  });

  it('sends changed files first in an AI read', async () => {
    const repo = new FakeRepo(undefined, ['src/routes/export.ts']);
    const model = new FakeModel({ 'ai-read:privacy.03': { verdict: 'cant-tell', explanation: 'n/a', citations: [] } });
    await runCheck(
      { repo, store: new FakeStore([promise('privacy.03')]), model, target: { kind: 'diff', base: BASE, head: HEAD }, aiRead: true, now: fixedNow },
    );
    const input = model.requests[0]?.input ?? '';
    expect(input.indexOf('=== src/routes/export.ts')).toBeLessThan(input.indexOf('=== src/agent/chats.ts'));
  });
});

async function brokenRun(
  failMode: CheckRun['failMode'] = 'block',
): Promise<{ run: CheckRun; repo: FakeRepo; deps: Parameters<typeof verifyRun>[2] }> {
  const repo = new FakeRepo();
  const store = new FakeStore([promise('security.01')], [rule('R-security.01', 'security.01', ['src/routes/**'])]);
  store.config = { ...store.config, failMode };
  const rr = fakeRunRule({ 'R-security.01': { outcome: 'fail', hits: [['src/routes/export.ts', 9]] } });
  const run = await runCheck({ repo, store, model: null, target: repoTarget, aiRead: false, now: fixedNow }, { runRule: rr.fn });
  return { run, repo, deps: { store, runRule: rr.fn } };
}

describe('digest and verify', () => {
  it('the digest is sha256 of the run without digest, and survives a JSON round trip', async () => {
    const { run, repo, deps } = await brokenRun();
    const copy = JSON.parse(JSON.stringify(run)) as CheckRun;
    expect(digestOf(copy)).toBe(run.digest);
    const report = await verifyRun(copy, repo, deps);
    expect(report).toEqual({ ok: true, problems: [], checkedQuotes: 1, notes: [`Re-ran 1 rule at ${HEAD.slice(0, 7)} with no AI.`] });
  });

  it('detects a flipped byte in a quote (digest and git re-read)', async () => {
    const { run, repo } = await brokenRun();
    const json = JSON.stringify(run).replace('/export.csv', '/expoRt.csv');
    const tampered = JSON.parse(json) as CheckRun;
    expect(tampered.results[0]?.citations[0]?.quote).toContain('expoRt');
    const report = await verifyRun(tampered, repo);
    expect(report.ok).toBe(false);
    expect(report.problems.some((p) => p.startsWith('Digest does not match'))).toBe(true);
    expect(report.problems.some((p) => p.includes('differs from git'))).toBe(true);
  });

  it('detects a verdict changed to one the level does not allow, and notes when there is no repo', async () => {
    const { run } = await brokenRun();
    const forged = { ...run, results: run.results.map((r) => ({ ...r, verdict: 'looks-kept' as const })) };
    const report = await verifyRun({ ...forged, digest: digestOf(forged) }, null);
    expect(report.ok).toBe(false);
    expect(report.problems).toEqual(['security.01: "looks-kept" is not allowed at level "rule".']);
    expect(report.notes[0]).toMatch(/Quotes not re-checked/u);
  });
});

describe('exit codes', () => {
  it('1 for a broken promise in block mode, 0 in monitor or comment mode', async () => {
    expect(exitCodeFor((await brokenRun('block')).run)).toBe(1);
    expect(exitCodeFor((await brokenRun('monitor')).run)).toBe(0);
    expect(exitCodeFor((await brokenRun('comment')).run)).toBe(0);
  });
});
