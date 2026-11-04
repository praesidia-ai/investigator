// FX-3: the rule red team. The attacker's edits come from scripted answers; the program applies them, re-runs the rule,
// and a judge (scripted AI read, or a known-break list) decides whether the rule is weak.
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadBench } from '../../src/bench/index.js';
import type { ModelClient, ModelJsonRequest, ModelJsonResult, PromiseRecord, Rule } from '../../src/contracts.js';
import { ScriptedModelClient } from '../../src/model/scripted.js';
import { runRule } from '../../src/rules/engine.js';
import {
  applyEdit,
  filesForRedteam,
  redteamInput,
  redteamRule,
  redteamTaskKey,
  showEdit,
  type JudgeFn,
} from '../../src/rules/redteam.js';

const SCRIPTED = join(import.meta.dirname, '../../fixtures/scripted/acme');
const data = await loadBench();

function ruleOf(id: string): Rule {
  const rule = data.rules.find((r) => r.id === id);
  if (!rule) throw new Error(`no rule ${id}`);
  return rule;
}
function promiseOf(id: string): PromiseRecord {
  const promise = data.promises.find((p) => p.id === id);
  if (!promise) throw new Error(`no promise ${id}`);
  return promise;
}
function filesFor(rule: Rule) {
  return filesForRedteam(rule, promiseOf(rule.promiseId), data.files, data.codeScope);
}
/** Answers every attack with the given edits. */
function attacker(evasions: Array<{ path: string; find: string; replace: string; why: string }>, tasks: string[] = []): ModelClient {
  return {
    id: 'fake-attacker',
    mode: 'scripted',
    async json<T>(request: ModelJsonRequest<T>): Promise<ModelJsonResult<T>> {
      tasks.push(request.task);
      return { value: request.schema.parse({ evasions }), usage: { id: 'fake-attacker', mode: 'scripted', inputTokens: 10, outputTokens: 5, usd: 0.001 } };
    },
  };
}

describe('applyEdit', () => {
  const files = [{ path: 'src/a.ts', text: 'const A = 1;\nconst B = 1;\n' }];
  it('replaces the only occurrence', () => {
    const out = applyEdit(files, { path: 'src/a.ts', find: 'A = 1', replace: 'A = 2' });
    expect(out.ok && out.files[0]?.text).toBe('const A = 2;\nconst B = 1;\n');
  });
  it('refuses text that occurs twice, text that is missing, and a missing file', () => {
    expect(applyEdit(files, { path: 'src/a.ts', find: '= 1', replace: '= 2' })).toMatchObject({ ok: false, reason: expect.stringContaining('more than once') });
    expect(applyEdit(files, { path: 'src/a.ts', find: 'C = 1', replace: 'C = 2' })).toMatchObject({ ok: false });
    expect(applyEdit(files, { path: 'src/b.ts', find: 'x', replace: 'y' })).toMatchObject({ ok: false, reason: expect.stringContaining('does not exist') });
  });
  it('appends with an empty find, or creates a new file', () => {
    const appended = applyEdit(files, { path: 'src/a.ts', find: '', replace: 'const C = 3;' });
    expect(appended.ok && appended.files[0]?.text).toBe('const A = 1;\nconst B = 1;\nconst C = 3;\n');
    const created = applyEdit(files, { path: 'src/new.ts', find: '', replace: 'export {};\n' });
    expect(created.ok && created.files.map((f) => f.path)).toEqual(['src/a.ts', 'src/new.ts']);
  });
  it('refuses paths outside the repo and edits that change nothing', () => {
    expect(applyEdit(files, { path: '../etc/passwd', find: '', replace: 'x' }).ok).toBe(false);
    expect(applyEdit(files, { path: '/abs.ts', find: '', replace: 'x' }).ok).toBe(false);
    expect(applyEdit(files, { path: 'src/a.ts', find: 'A = 1', replace: 'A = 1' }).ok).toBe(false);
  });
});

describe('redteamRule', () => {
  it('reports the value rule weak when an edit keeps the constant but stops using it, per the scripted judge', async () => {
    const rule = ruleOf('R-privacy.01-1');
    const model = new ScriptedModelClient(SCRIPTED);
    const report = await redteamRule(rule, promiseOf('privacy.01'), filesFor(rule), model, { judge: model });
    expect(report.verdict).toBe('weak');
    expect(report.attempts.map((a) => [a.rule, a.judge])).toEqual([
      ['missed', 'breaks'],
      ['caught', 'not-judged'],
      ['not-applied', 'not-judged'],
    ]);
    expect(report.message).toContain('365 * 24');
    expect(model.tasks).toEqual([redteamTaskKey(rule.id), 'redteam:judge:R-privacy.01-1:1']);
  });

  it('a known-break list can judge instead of a model: a swallowed guard still passes each-near', async () => {
    const rule = ruleOf('R-security.01-1');
    const knownBreaks: JudgeFn = ({ after }) => {
      const text = after.find((f) => f.path === 'src/routes/export.ts')?.text ?? '';
      return text.includes('try { requireAdmin(req); } catch') ? { verdict: 'breaks', note: 'guard error swallowed' } : { verdict: 'keeps', note: '' };
    };
    const report = await redteamRule(rule, promiseOf('security.01'), filesFor(rule), new ScriptedModelClient(SCRIPTED), { judge: knownBreaks });
    expect(report.verdict).toBe('weak');
    // The new /export.csv route is caught (the anchor covers any /export route); the swallowed guard is not.
    expect(report.attempts.map((a) => a.rule)).toEqual(['caught', 'missed']);
    expect(report.attempts[1]?.judgeNote).toBe('guard error swallowed');
  });

  it('holds when every edit is caught, and is unsure when a miss has no judge', async () => {
    const rule = ruleOf('R-privacy.01-1');
    const caughtOnly = attacker([{ path: 'src/agent/chats.ts', find: 'CHAT_TTL_DAYS = 30;', replace: 'CHAT_TTL_DAYS = 45;', why: 'longer' }]);
    const held = await redteamRule(rule, promiseOf('privacy.01'), filesFor(rule), caughtOnly);
    expect(held.verdict).toBe('held');
    expect(held.message).toContain('caught 1 of 1');
    expect(held.usage).toHaveLength(1);

    const missed = attacker([{ path: 'src/agent/chats.ts', find: 'CHAT_TTL_DAYS * 24', replace: '365 * 24', why: 'a year' }]);
    const unsure = await redteamRule(rule, promiseOf('privacy.01'), filesFor(rule), missed, { judge: null });
    expect(unsure.verdict).toBe('unsure');
    expect(unsure.attempts[0]).toMatchObject({ rule: 'missed', judge: 'not-judged' });
  });

  it('a judge that says the edit keeps the promise does not make the rule weak', async () => {
    const rule = ruleOf('R-privacy.01-1');
    const harmless = attacker([{ path: 'src/agent/chats.ts', find: '/** Support chats', replace: '/** Customer support chats', why: 'comment' }]);
    const report = await redteamRule(rule, promiseOf('privacy.01'), filesFor(rule), harmless, { judge: () => ({ verdict: 'keeps', note: 'only a comment' }) });
    expect(report.verdict).toBe('held');
  });

  it('does not attack a rule that already fails, and reports a failed attack call', async () => {
    const rule = ruleOf('R-privacy.01-1');
    const broken = data.files.map((f) => (f.path === 'src/agent/chats.ts' ? { ...f, text: f.text.replace('= 30', '= 90') } : f));
    expect(runRule(rule, broken, '0000000').outcome).toBe('fail');
    const tasks: string[] = [];
    const none = await redteamRule(rule, promiseOf('privacy.01'), broken, attacker([], tasks));
    expect(none.verdict).toBe('failed');
    expect(tasks).toEqual([]);

    const failing: ModelClient = { id: 'x', mode: 'scripted', json: async () => Promise.reject(new Error('rate limited')) };
    const failed = await redteamRule(rule, promiseOf('privacy.01'), filesFor(rule), failing);
    expect(failed).toMatchObject({ verdict: 'failed', message: expect.stringContaining('rate limited') });
  });

  it('shows the attacker the rule, the promise and the files the rule reads', () => {
    const rule = ruleOf('R-security.01-1');
    const input = redteamInput(rule, promiseOf('security.01'), filesFor(rule));
    expect(input).toContain('pattern: /requireAdmin\\(/');
    expect(input).toContain('anchor: /router');
    expect(input).toContain('=== src/routes/export.ts');
    expect(input).toContain('Only workspace admins can export customer data.');
    expect(showEdit({ path: 'a.ts', find: 'x = 1', replace: 'x = 2' })).toBe('a.ts: `x = 1` -> `x = 2`');
  });
});
