import { describe, expect, it } from 'vitest';
import { ruleSchema } from '../../src/contracts.js';
import { buildRulePrompt, proposeRule, runRule } from '../../src/rules/index.js';
import { ACME_PROMISES, acmeFiles, COMMIT, fixedModel, hasAcme, promise, SCRIPTED_ACME, scriptedModel } from './helpers.js';

const NOW = new Date('2026-11-04T04:00:00.000Z');
const files = [
  { path: 'src/agent/chats.ts', text: 'export const CHAT_TTL_DAYS = 30;\n' },
  { path: 'src/log.ts', text: "export function log(event: string) {}\nlog('login', { user });\n" },
];
const p = promise('privacy.01', 'Support chats are deleted after 30 days.', ['src/agent/**']);
const answer = {
  feasible: true,
  reason: 'the constant sets the lifetime',
  mode: 'must-match',
  pattern: 'CHAT_TTL_DAYS\\s*=\\s*30\\b',
  flags: null,
  anchor: null,
  within: null,
  globs: ['src/agent/**'],
  description: 'CHAT_TTL_DAYS is 30.',
  violationExamples: [],
  keptExamples: [],
};

describe('proposeRule (program decides)', () => {
  it('keeps a rule that passes now and is shown able to fail', async () => {
    const res = await proposeRule(p, files, COMMIT, fixedModel(answer), NOW);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(ruleSchema.parse(res.rule)).toEqual(res.rule);
    expect(res.rule).toMatchObject({ id: 'R-privacy.01-1', status: 'proposed', author: 'model', createdAt: NOW.toISOString() });
    expect(res.rule.provenBy).toEqual({ mutation: expect.stringContaining('the rule then failed'), failedAsExpected: true, at: NOW.toISOString() });
    expect('flags' in res.rule).toBe(false);
  });
  it('numbers the rule after existing ones', async () => {
    const res = await proposeRule(p, files, COMMIT, fixedModel(answer), NOW, {
      existing: [{ ...ruleSchema.parse({ id: 'R-privacy.01-4', promiseId: 'privacy.01', description: 'x x x', mode: 'must-match', pattern: 'x', globs: ['src/**'], provenBy: null, status: 'accepted', author: 'human', createdAt: NOW.toISOString() }) }],
    });
    expect(res.ok && res.rule.id).toBe('R-privacy.01-5');
  });
  it('rejects: infeasible, fails on current code, cannot fail, unsafe, missing anchor, non-code promise', async () => {
    const cases: Array<[unknown, RegExp]> = [
      [{ ...answer, feasible: false, reason: 'about people, not code', mode: null, pattern: null }, /^about people, not code$/u],
      [{ ...answer, pattern: 'CHAT_TTL_DAYS\\s*=\\s*90' }, /fails on the current code/u],
      [{ ...answer, pattern: 'Z*' }, /could not be shown to fail/u],
      [{ ...answer, pattern: '(a+)+' }, /not safe to run/u],
      [{ ...answer, pattern: '(x)\\1' }, /back-reference/u],
      [{ ...answer, mode: 'each-near', anchor: null }, /needs an anchor/u],
      [{ ...answer, mode: 'must-not-match', pattern: 'password' }, /needs an example/u],
      [{ ...answer, globs: ['../secrets/**'] }, /outside the repo/u],
      [{ ...answer, flags: 'x' }, /flags/u],
    ];
    for (const [a, why] of cases) {
      const res = await proposeRule(p, files, COMMIT, fixedModel(a), NOW);
      expect(res.ok, JSON.stringify(a)).toBe(false);
      if (!res.ok) expect(res.reason).toMatch(why);
    }
    const proc = await proposeRule({ ...p, checkable: 'process' }, files, COMMIT, fixedModel(answer), NOW);
    expect(proc).toEqual({ ok: false, reason: 'privacy.01 is a process promise; rules only check code promises' });
  });
  it('turns a failing model call into a reason, not a crash', async () => {
    const res = await proposeRule(promise('nope.01', 'x x x'), files, COMMIT, scriptedModel(SCRIPTED_ACME), NOW);
    expect(res).toMatchObject({ ok: false, reason: expect.stringContaining('the model call failed') });
  });
  it('builds a prompt with line numbers, in-scope files first, capped', () => {
    const big = [{ path: 'a/other.ts', text: 'y\n'.repeat(5000) }, ...files];
    const prompt = buildRulePrompt(p, big, COMMIT, 2000);
    expect(prompt.indexOf('=== src/agent/chats.ts')).toBeLessThan(prompt.indexOf('Other files not shown'));
    expect(prompt).toContain('1| export const CHAT_TTL_DAYS = 30;');
    expect(prompt).toContain('Other files not shown: a/other.ts');
    expect(prompt).toContain('"Support chats are deleted after 30 days."');
  });
});

describe.skipIf(!hasAcme)('acme-notes scripted rules', () => {
  const main = hasAcme ? acmeFiles('main') : [];
  const ids = ['security.01', 'privacy.01', 'security.03', 'privacy.02', 'praesidia.03'];

  it('every scripted rule is kept on main (passes, proven able to fail)', async () => {
    const calls: string[] = [];
    const model = scriptedModel(SCRIPTED_ACME, calls);
    for (const id of ids) {
      const res = await proposeRule(ACME_PROMISES[id]!, main, COMMIT, model, NOW);
      expect(res.ok, `${id}: ${res.ok ? '' : res.reason}`).toBe(true);
      if (res.ok) expect(runRule(res.rule, main, COMMIT).outcome).toBe('pass');
    }
    expect(calls).toEqual(ids.map((id) => `rule-propose:${id}`));
  });

  it('privacy.03 has no rule: it stays on AI reads', async () => {
    const res = await proposeRule(ACME_PROMISES['privacy.03']!, main, COMMIT, scriptedModel(SCRIPTED_ACME), NOW);
    expect(res).toMatchObject({ ok: false, reason: expect.stringContaining('business decision') });
  });

  it('security.01 fails on feature/csv-export; privacy.01 fails on agent/retention; others hold', async () => {
    const model = scriptedModel(SCRIPTED_ACME);
    const rules = new Map<string, import('../../src/contracts.js').Rule>();
    for (const id of ids) {
      const res = await proposeRule(ACME_PROMISES[id]!, main, COMMIT, model, NOW);
      if (res.ok) rules.set(id, { ...res.rule, status: 'accepted' });
    }
    const csv = acmeFiles('feature/csv-export');
    const sec = runRule(rules.get('security.01')!, csv, 'def5678');
    expect(sec.outcome).toBe('fail');
    expect(sec.message).toBe("src/routes/export.ts:15 has router.get('/export with no requireAdmin( within 3 lines");
    expect(sec.hits).toEqual([
      { path: 'src/routes/export.ts', commit: 'def5678', startLine: 15, endLine: 15, quote: "router.get('/export.csv', async (req, res) => {" },
    ]);
    for (const id of ids.filter((i) => i !== 'security.01')) expect(runRule(rules.get(id)!, csv, 'def5678').outcome, id).toBe('pass');

    const retention = acmeFiles('agent/retention');
    const ttl = runRule(rules.get('privacy.01')!, retention, 'aaa1111');
    expect(ttl.outcome).toBe('fail');
    expect(ttl.message).toContain('src/agent/**');
    expect(runRule(rules.get('security.01')!, retention, 'aaa1111').outcome).toBe('pass');
  });
});
