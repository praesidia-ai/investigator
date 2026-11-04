// R4-FIX: "breaks now" is a finding. A rule that fails on today's code and passes on a copy the program fixed in memory
// is kept, and the promise is reported BROKEN NOW with evidence copied from the code.
import { describe, expect, it } from 'vitest';
import type { ModelClient, ModelJsonRequest, ModelJsonResult } from '../../src/contracts.js';
import { describeEvidence, proposeRule, runRule } from '../../src/rules/index.js';
import { BREAKS_NOW_FEEDBACK } from '../../src/rules/propose.js';
import { runRuleCommand } from '../../src/cli/commands/rule.js';
import { makeStyle } from '../../src/util/term.js';
import { COMMIT, fixedModel, promise } from './helpers.js';

const NOW = new Date('2026-11-04T04:00:00.000Z');
const base = {
  feasible: true,
  // SC-3 fix 1: a finding names every line that breaks the promise.
  reason: 'Breaks now: src/agent/chats.ts:1 keeps chats longer than the limit',
  flags: null,
  anchor: null,
  within: null,
  description: 'The cache lifetime stays within the limit.',
  violationExamples: [] as string[],
  keptExamples: [] as string[],
};
const facets = (value: string, unit: string) => ({
  facets: { subject: 'cached documents', action: 'keep', constraint: { name: 'retention', op: '<=' as const, value, unit } },
});

describe('breaks now: a value rule on a fixture', () => {
  // The live finding: cache_service.py:19 sets ttl=172800 (2 days) against a 24-hour maximum.
  const files = [
    {
      path: 'app/services/cache_service.py',
      text: [
        'import redis',
        '',
        'class CacheService:',
        '    def put(self, key, doc):',
        '        self.client.set(',
        '            key,',
        '            doc,',
        '            ex=None,',
        '        )',
        '        self.client.expire(key, ttl=172800)',
      ].join('\n'),
    },
  ];
  const p = promise('documents.03', 'Cached documents are deleted within 24 hours.', ['app/**'], facets('24', 'hours'));

  it('keeps the rule, reports BROKEN NOW with file:line, actual vs allowed', async () => {
    const answer = {
      ...base,
      reason: 'Breaks now: cache_service.py:10 keeps documents 2 days',
      mode: 'must-match',
      pattern: 'ttl\\s*=\\s*(?:[0-9]{1,4}|[1-7][0-9]{4}|8[0-5][0-9]{3}|86[0-3][0-9]{2}|86400)\\b',
      globs: ['app/**/*.py'],
      keptExamples: ['ttl=86400', 'ttl = 3600'],
    };
    const res = await proposeRule(p, files, COMMIT, fixedModel(answer), NOW);
    expect(res.ok, JSON.stringify(res)).toBe(true);
    if (!res.ok) return;
    expect(res.brokenNow).toBeDefined();
    const e = res.brokenNow!.evidence[0]!;
    // AC-B (SC-3 fix 6): a ttl with no unit in its name is read as seconds: 172800 is 48 hours.
    expect(e).toMatchObject({ path: 'app/services/cache_service.py', line: 10, actual: '172800 (48 hours)', allowed: 'at most 24 hours' });
    expect(e.quote).toBe('self.client.expire(key, ttl=172800)');
    expect(describeEvidence(e)).toBe('app/services/cache_service.py:10 `self.client.expire(key, ttl=172800)`: 172800 (48 hours), allowed at most 24 hours');
    expect(res.brokenNow!.fix).toMatch(/app\/services\/cache_service\.py:10/u);
    expect(res.rule.provenBy?.mutation).toMatch(/^fails on today's code; passes on a copy fixed in memory/u);
    // check runs the same rule on today's code: BROKEN by that rule.
    expect(runRule(res.rule, files, COMMIT).outcome).toBe('fail');
  });

  it('a constant over the limit (CHAT_TTL_DAYS = 90, at most 30 days) is brought within it in memory', async () => {
    const chat = [{ path: 'src/agent/chats.ts', text: 'export const CHAT_TTL_DAYS = 90;\n' }];
    const q = promise('privacy.01', 'Support chats are deleted after 30 days.', ['src/agent/**'], facets('30', 'days'));
    const answer = { ...base, mode: 'must-match', pattern: 'CHAT_TTL_DAYS\\s*=\\s*(?:[0-9]|[12][0-9]|30)\\b', globs: ['src/agent/**'] };
    const res = await proposeRule(q, chat, COMMIT, fixedModel(answer), NOW);
    expect(res.ok, JSON.stringify(res)).toBe(true);
    if (!res.ok) return;
    expect(res.brokenNow?.evidence[0]).toMatchObject({ path: 'src/agent/chats.ts', line: 1, actual: '90', allowed: 'at most 30 days' });
    expect(res.brokenNow?.fix).toMatch(/the value set to the limit \(at most 30 days\) at src\/agent\/chats\.ts:1/u);
  });

  it('a wrong rule (no fixed copy passes) is still dropped', async () => {
    const chat = [{ path: 'src/agent/chats.ts', text: 'export const CHAT_TTL_DAYS = 30;\n' }];
    const q = promise('privacy.01', 'Support chats are deleted after 30 days.', ['src/agent/**'], facets('30', 'days'));
    // The model's "kept" line keeps 90, which breaks the promise's number: the fixed copy fails too.
    const answer = { ...base, mode: 'must-match', pattern: 'CHAT_TTL_DAYS\\s*=\\s*90\\b', globs: ['src/agent/**'], keptExamples: ['CHAT_TTL_DAYS = 90'] };
    const res = await proposeRule(q, chat, COMMIT, fixedModel(answer), NOW);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/fails on the current code .* no small fix/u);
  });
});

describe('breaks now: forbidden line and missing guard', () => {
  it('must-not-match: the forbidden line is removed in memory; evidence is that line', async () => {
    const files = [
      { path: 'src/log.ts', text: "export function log(event: string, data: object) {}\nlog('login', { user });\nlog('signup', { user, password });\n" },
    ];
    const p = promise('security.02', 'Passwords are never written to logs.', ['src/**']);
    const answer = {
      ...base,
      reason: 'Breaks now: src/log.ts:3 logs the password',
      mode: 'must-not-match',
      pattern: 'log\\([^)]*password',
      globs: ['src/**/*.ts'],
      violationExamples: ["log('reset', { password })"],
      keptExamples: ["log('login', { userId })"],
    };
    const res = await proposeRule(p, files, COMMIT, fixedModel(answer), NOW);
    expect(res.ok, JSON.stringify(res)).toBe(true);
    if (!res.ok) return;
    expect(res.brokenNow?.evidence).toEqual([{ path: 'src/log.ts', line: 3, quote: "log('signup', { user, password });", actual: 'a line the promise forbids' }]);
    expect(res.brokenNow?.fix).toBe('1 forbidden line removed (src/log.ts:3)');
  });

  it('each-near: the guard this code already uses is added after the unguarded route', async () => {
    const files = [
      {
        path: 'src/routes/export.ts',
        text: [
          "router.get('/export', (req, res) => {",
          '  requireAdmin(req);',
          '  res.send(all());',
          '});',
          "router.get('/export.csv', (req, res) => {",
          '  res.send(csv());',
          '});',
        ].join('\n'),
      },
    ];
    const p = promise('security.01', 'Only admins can export customer data.', ['src/routes/**']);
    const answer = {
      ...base,
      reason: 'Breaks now: export.ts:5 exports with no admin check',
      mode: 'each-near',
      anchor: "router\\.\\w+\\(\\s*['\"`][^'\"`]*export",
      pattern: 'requireAdmin\\(',
      within: 3,
      globs: ['src/routes/**/*.ts'],
      violationExamples: ["router.post('/export/all', (req, res) => {"],
    };
    const res = await proposeRule(p, files, COMMIT, fixedModel(answer), NOW);
    expect(res.ok, JSON.stringify(res)).toBe(true);
    if (!res.ok) return;
    expect(res.brokenNow?.evidence[0]).toMatchObject({ path: 'src/routes/export.ts', line: 5, actual: 'no guard within 3 lines' });
    expect(res.brokenNow?.fix).toBe('`requireAdmin(req);` added after 1 unguarded line');
  });
});

describe('breaks now: an answer that says so but writes no rule', () => {
  it('a live answer gets one retry asking for the rule anyway', async () => {
    const calls: string[] = [];
    const answers = [
      { ...base, feasible: false, reason: 'Breaks now: chats.ts:1 keeps chats 90 days', mode: null, pattern: null, globs: [] },
      { ...base, mode: 'must-match', pattern: 'CHAT_TTL_DAYS\\s*=\\s*(?:[0-9]|[12][0-9]|30)\\b', globs: ['src/agent/**'] },
    ];
    const live: ModelClient = {
      id: 'fake-live',
      mode: 'live',
      async json<T>(request: ModelJsonRequest<T>): Promise<ModelJsonResult<T>> {
        calls.push(request.input);
        return { value: request.schema.parse(answers[calls.length - 1]), usage: { id: 'fake-live', mode: 'live', inputTokens: 1, outputTokens: 1, usd: 0.01 } };
      },
    };
    const chat = [{ path: 'src/agent/chats.ts', text: 'export const CHAT_TTL_DAYS = 90;\n' }];
    const q = promise('privacy.01', 'Support chats are deleted after 30 days.', ['src/agent/**'], facets('30', 'days'));
    const res = await proposeRule(q, chat, COMMIT, live, NOW);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain(BREAKS_NOW_FEEDBACK);
    expect(res.ok && res.brokenNow?.evidence[0]?.actual).toBe('90');
  });

  it('the run budget stops the call: budgetStopped, nothing spent', async () => {
    const stop: ModelClient = {
      id: 'fake-live',
      mode: 'live',
      json: async () => {
        throw Object.assign(new Error('budget'), { code: 'MODEL_BUDGET_EXCEEDED' });
      },
    };
    const res = await proposeRule(promise('privacy.01', 'x x x'), [], COMMIT, stop, NOW);
    expect(res).toEqual({ ok: false, reason: 'not asked: the run budget was reached', budgetStopped: true });
  });
});

describe('jurator rule propose: BROKEN NOW and the budget stop (command)', () => {
  const SHA = '1111111111111111111111111111111111111111';
  const code = [
    { path: 'src/agent/chats.ts', text: 'export const CHAT_TTL_DAYS = 90;\n' },
    { path: 'src/agent/notes.ts', text: 'export const NOTE_TTL_DAYS = 7;\n' },
  ];
  const promises = [
    promise('privacy.01', 'Support chats are deleted after 30 days.', ['src/agent/**'], facets('30', 'days')),
    promise('privacy.02', 'Notes are deleted after 30 days.', ['src/agent/**'], facets('30', 'days')),
    promise('privacy.03', 'Drafts are deleted after 30 days.', ['src/agent/**'], facets('30', 'days')),
  ];
  const answerFor: Record<string, unknown> = {
    'rule-propose:privacy.01': { ...base, mode: 'must-match', pattern: 'CHAT_TTL_DAYS\\s*=\\s*(?:[0-9]|[12][0-9]|30)\\b', globs: ['src/agent/**'] },
    'rule-propose:privacy.02': { ...base, reason: 'catches a longer lifetime', mode: 'must-match', pattern: 'NOTE_TTL_DAYS\\s*=\\s*(?:[0-9]|[12][0-9]|30)\\b', globs: ['src/agent/**'] },
  };
  function world(budgetAfter: number) {
    let rules: import('../../src/contracts.js').Rule[] = [];
    let calls = 0;
    const store = {
      dir: '/x/.jurator',
      repoRoot: '/x',
      exists: async () => true,
      readConfig: async () => (({ ...DEFAULT_CONFIG_LOCAL }) as import('../../src/contracts.js').Config),
      readPromises: async () => promises,
      readRules: async () => rules,
      writeRules: async (items: typeof rules) => {
        rules = items;
      },
      readBindings: async () => [],
      writeBindings: async () => undefined,
    } as unknown as import('../../src/contracts.js').Store;
    const repo = {
      root: '/x',
      snapshot: async () => ({ repo: '/x', branch: 'main', commit: SHA, dirty: false }),
      resolve: async () => SHA,
      listFiles: async () => code.map((f) => f.path),
      readFile: async (_c: string, path: string) => code.find((f) => f.path === path)?.text ?? '',
      changedFiles: async () => [],
    };
    const budgets: number[] = [];
    const deps = {
      findRepoRoot: async () => '/x',
      openStore: () => store,
      openRepo: async () => repo,
      createModel: (o: { config: import('../../src/contracts.js').Config }): ModelClient => {
        budgets.push(o.config.budgetUsdPerRun);
        return {
          id: 'fake-live',
          mode: 'live',
          async json<T>(request: ModelJsonRequest<T>): Promise<ModelJsonResult<T>> {
            calls += 1;
            if (calls > budgetAfter) throw Object.assign(new Error('budget'), { code: 'MODEL_BUDGET_EXCEEDED' });
            return { value: request.schema.parse(answerFor[request.task]), usage: { id: 'fake-live', mode: 'live', inputTokens: 1, outputTokens: 1, usd: 0.3 } };
          },
        };
      },
      infeasible: { read: async () => [], write: async () => true },
      mutants: { read: async () => ({ version: 1 as const, rules: {} }), write: async () => true },
    };
    return { deps, rules: () => rules, budgets };
  }
  const DEFAULT_CONFIG_LOCAL = { schemaVersion: 1, sources: [], failMode: 'block', codeScope: ['src/**'], model: { id: 'm' }, budgetUsdPerRun: 10 };
  function ctx(argv: string[]) {
    const out: string[] = [];
    const c = {
      cwd: '/x',
      argv,
      env: {},
      out: (l: string) => out.push(l),
      err: (l: string) => out.push(l),
      style: makeStyle(false),
      now: () => NOW,
    };
    return { c, out };
  }

  it('reports BROKEN NOW with the evidence and keeps the rule; --budget sets the run budget', async () => {
    const w = world(99);
    const { c, out } = ctx(['propose', 'privacy.01,privacy.02', '--accept', '--budget', '25']);
    expect(await runRuleCommand(c, w.deps as never)).toBe(0);
    expect(w.budgets[0]).toBe(25);
    const text = out.join('\n');
    expect(text).toContain('✗ privacy.01  BROKEN NOW  R-privacy.01-1 written and accepted (must-match)');
    expect(text).toContain('    src/agent/chats.ts:1 `export const CHAT_TTL_DAYS = 90;`: 90, allowed at most 30 days');
    expect(text).toContain('✓ privacy.02  R-privacy.02-1 written and accepted');
    expect(text).toContain('2 of 2 written · 1 broken now');
    expect(text).toContain('Next: fix the code at src/agent/chats.ts:1, then jurator check');
    expect(w.rules().map((r) => [r.id, r.status])).toEqual([
      ['R-privacy.01-1', 'accepted'],
      ['R-privacy.02-1', 'accepted'],
    ]);
  });

  it('when the budget stops the run: how much more is needed and the exact command to continue', async () => {
    const w = world(2);
    const { c, out } = ctx(['propose', '--all', '--concurrency', '1']);
    expect(await runRuleCommand(c, w.deps as never)).toBe(0);
    const text = out.join('\n');
    expect(text).toContain('Budget reached: this run spent $0.60 of its $10.00 budget after 2 promises; 1 promise not asked.');
    expect(text).toContain('About $0.30 more is needed. Continue with: jurator rule propose privacy.03 --budget 1');
  });
});
