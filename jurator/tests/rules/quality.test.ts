// WP-R2: rule quality. Repo-aware examples for must-not-match, values from typed facets, the job pool.
import { describe, expect, it } from 'vitest';
import type { ModelClient, ModelJsonRequest, PromiseRecord } from '../../src/contracts.js';
import {
  breakingValue,
  callsIn,
  exampleCallProblem,
  keptNumberPattern,
  mapPool,
  numericConstraint,
  proposeRule,
  proveValueChecked,
  unsafeReason,
} from '../../src/rules/index.js';
import { ACME_PROMISES, acmeFiles, COMMIT, hasAcme, promise, rule } from './helpers.js';

const NOW = new Date('2026-11-04T04:30:00.000Z');

function liveModel(answers: unknown[], inputs: string[] = []): ModelClient {
  let i = 0;
  return {
    id: 'fake-live',
    mode: 'live',
    async json<T>(req: ModelJsonRequest<T>) {
      inputs.push(req.input);
      const value = answers[Math.min(i++, answers.length - 1)];
      return { value: value as T, usage: { id: 'fake-live', mode: 'live', inputTokens: 10, outputTokens: 5, usd: 0.01 } };
    },
  };
}

const logFiles = [
  { path: 'src/log.ts', text: "export function log(event: string, fields: Record<string, unknown> = {}): void {\n  process.stdout.write(event);\n}\n" },
  { path: 'src/routes/export.ts', text: "router.get('/export', async (req, res) => {\n  requireAdmin(req);\n  log('export', { count: 1 });\n});\n" },
];
const noSecrets = promise('security.04', 'Card numbers and passwords are never written to logs.', ['src/**'], { kind: 'must-not' });
const consoleAnswer = {
  feasible: true,
  reason: 'a log call with a card number writes it to the logs',
  mode: 'must-not-match',
  pattern: 'console\\.log\\([^)]*\\b(?:password|cardNumber)\\b',
  flags: null,
  anchor: null,
  within: null,
  globs: ['src/**'],
  description: 'No console.log call passes a password or card number.',
  violationExamples: ["console.log('charge', cardNumber);"],
  keptExamples: [],
};
const logAnswer = {
  ...consoleAnswer,
  pattern: '\\blog\\([^)]*\\b(?:password|cardNumber)\\b',
  description: 'No log call passes a password or card number.',
  violationExamples: ["log('charge', { cardNumber });"],
  keptExamples: [],
};

describe('repo-aware must-not-match examples', () => {
  it('finds the outermost call first, ignoring strings and keywords', () => {
    expect(callsIn("console.log('charge (card)', mask(cardNumber));")).toEqual(['console.log', 'mask']);
    expect(callsIn('if (x) { this.logger.info(password); }')).toEqual(['logger.info']);
    expect(callsIn('return plain;')).toEqual([]);
  });
  it('rejects an example whose call this repo never makes, and names the call it does use', () => {
    const why = exampleCallProblem("console.log('charge', cardNumber);", logFiles);
    expect(why).toContain('calls console.log(, which no file in this repo calls');
    expect(why).toContain('this code uses log( (src/log.ts:1)');
    expect(exampleCallProblem("log('charge', { cardNumber });", logFiles)).toBeNull();
    expect(exampleCallProblem('const notes = db.notes;', logFiles)).toBeNull();
  });
  it('a live console.log answer is rejected with the reason, and the retry with log( is kept', async () => {
    const inputs: string[] = [];
    const res = await proposeRule(noSecrets, logFiles, COMMIT, liveModel([consoleAnswer, logAnswer], inputs), NOW);
    expect(res.ok, res.ok ? '' : res.reason).toBe(true);
    expect(inputs).toHaveLength(2);
    expect(inputs[1]).toContain('which no file in this repo calls');
    expect(inputs[1]).toContain('log( (src/log.ts:1)');
    if (res.ok) expect(res.rule.provenBy?.mutation).toContain("added the line `log('charge', { cardNumber });`");
  });
  it.skipIf(!hasAcme)('on acme-notes main: console.log is rejected, log( is accepted', async () => {
    const main = acmeFiles('main');
    expect(exampleCallProblem("console.log('charge', cardNumber);", main)).toContain('log( (src/log.ts:4)');
    const res = await proposeRule(ACME_PROMISES['security.03']!, main, COMMIT, liveModel([consoleAnswer]), NOW);
    expect(res).toMatchObject({ ok: false, reason: expect.stringContaining('(after one retry)') });
  });
});

const days = (op: '<=' | '>=' | '==', value: string): Partial<PromiseRecord> => ({
  facets: { subject: 'support chats', action: 'keep', constraint: { name: 'retention', op, value, unit: 'days' } },
});
const chats = [{ path: 'src/agent/chats.ts', text: 'export const CHAT_TTL_DAYS = 30;\nexport const MS = CHAT_TTL_DAYS * 24 * 60 * 60 * 1000;\n' }];
const keep30 = promise('privacy.01', 'Support chats are deleted after 30 days.', ['src/agent/**'], days('<=', '30'));
const keep90 = promise('praesidia.01', 'Customer data is kept at most 90 days.', ['src/agent/**'], days('<=', '90'));
const mustMatch = (pattern: string) => ({
  feasible: true,
  reason: 'the constant sets the chat lifetime',
  mode: 'must-match',
  pattern,
  flags: null,
  anchor: null,
  within: null,
  globs: ['src/agent/**'],
  description: 'CHAT_TTL_DAYS keeps the limit.',
  violationExamples: [],
  keptExamples: [],
});

describe('values from typed facets', () => {
  it('reads a numeric constraint; ignores never/always and non-numbers', () => {
    expect(numericConstraint(keep30)).toEqual({ name: 'retention', op: '<=', value: 30, unit: 'days' });
    expect(numericConstraint(promise('x.01', 'x x x', [], days('==', 'argon2id')))).toBeNull();
    expect(numericConstraint(promise('x.01', 'x x x'))).toBeNull();
  });
  it('builds safe number patterns that match exactly the kept values', () => {
    for (const n of [0, 7, 9, 10, 30, 90, 99, 100, 365, 1000]) {
      for (const op of ['<=', '>='] as const) {
        const src = keptNumberPattern({ name: 'n', op, value: n, unit: null })!;
        expect(unsafeReason(src), src).toBeNull();
        const re = new RegExp(`^x = ${src}`, 'u');
        for (let v = 0; v <= n * 3 + 20; v += 1) expect(re.test(`x = ${v};`), `${op} ${n}: ${v} via ${src}`).toBe(op === '<=' ? v <= n : v >= n);
      }
    }
    expect(keptNumberPattern({ name: 'n', op: '<=', value: 30, unit: null })).toBe('(?:[0-9]|[12][0-9]|30)\\b');
    expect(breakingValue({ name: 'n', op: '<=', value: 90, unit: null }, 30)).toBe(91);
    expect(breakingValue({ name: 'n', op: '>=', value: 12, unit: null }, 12)).toBe(11);
  });
  it('tells the model the value and a ready pattern', async () => {
    const inputs: string[] = [];
    await proposeRule(keep30, chats, COMMIT, liveModel([mustMatch('CHAT_TTL_DAYS\\s*=\\s*(?:[0-9]|[12][0-9]|30)\\b')], inputs), NOW);
    expect(inputs[0]).toContain('Typed facets: subject "support chats", action "keep", constraint retention <= 30 days.');
    expect(inputs[0]).toContain('(?:[0-9]|[12][0-9]|30)\\b');
    expect(inputs[0]).toContain('changes the number on the matched line to 31');
  });
  it('keeps a rule that checks the value, proven by changing 30 to 31', async () => {
    const res = await proposeRule(keep30, chats, COMMIT, liveModel([mustMatch('CHAT_TTL_DAYS\\s*=\\s*(?:[0-9]|[12][0-9]|30)\\b')]), NOW);
    expect(res.ok, res.ok ? '' : res.reason).toBe(true);
    if (res.ok) expect(res.rule.provenBy?.mutation).toContain('changed 30 to 31 at src/agent/chats.ts:1 (breaks retention <= 30 days); the rule failed too');
  });
  it('rejects a rule that checks only the name (an agent setting 90 would pass), then retries', async () => {
    const inputs: string[] = [];
    const nameOnly = mustMatch('export const CHAT_TTL_DAYS\\b');
    const res = await proposeRule(keep30, chats, COMMIT, liveModel([nameOnly, mustMatch('CHAT_TTL_DAYS\\s*=\\s*30\\b')], inputs), NOW);
    expect(inputs[1]).toContain('but the rule still passed, so it does not check the value');
    expect(res.ok).toBe(true);
    const direct = proveValueChecked(rule({ mode: 'must-match', pattern: 'CHAT_TTL_DAYS\\s*=\\s*\\d+' }), chats, COMMIT, numericConstraint(keep30)!);
    expect(direct).toMatchObject({ applies: true, ok: false });
  });
  it('praesidia.01 (<= 90): code says 30, the proof sets 91', async () => {
    const res = await proposeRule(keep90, chats, COMMIT, liveModel([mustMatch('CHAT_TTL_DAYS\\s*=\\s*(?:[0-9]|[1-8][0-9]|90)\\b')]), NOW);
    expect(res.ok && res.rule.provenBy?.mutation).toContain('changed 30 to 91 at src/agent/chats.ts:1');
  });
  it('does not apply to rules whose lines carry no number', () => {
    const files = [{ path: 'src/agent/tools.ts', text: "approvalGate('export_notes');\n" }];
    expect(proveValueChecked(rule({ mode: 'must-match', pattern: 'approvalGate\\(' }), files, COMMIT, numericConstraint(keep30)!)).toMatchObject({
      applies: false,
      ok: true,
    });
  });
});

describe('mapPool', () => {
  it('runs at most `limit` at once, returns input order, reports finish order', async () => {
    let running = 0;
    let peak = 0;
    const finished: number[] = [];
    const delays = [30, 5, 20, 1, 10, 2];
    const out = await mapPool(
      delays,
      4,
      async (ms, i) => {
        running += 1;
        peak = Math.max(peak, running);
        await new Promise((r) => setTimeout(r, ms));
        running -= 1;
        return i * 10;
      },
      (_r, _ms, i, done) => finished.push(i * 100 + done),
    );
    expect(out).toEqual([0, 10, 20, 30, 40, 50]);
    expect(peak).toBe(4);
    expect(finished.map((x) => x % 100)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(finished[0]! >= 100).toBe(true); // job 0 (30 ms) is not the first to finish
  });
});

describe.skipIf(!hasAcme)('acme-notes: value rules from facets (scripted answers)', () => {
  it('privacy.01 (<= 30) breaks on agent/retention (90); praesidia.01 (<= 90) holds there', async () => {
    const { scriptedModel, SCRIPTED_ACME } = await import('./helpers.js');
    const main = acmeFiles('main');
    const model = scriptedModel(SCRIPTED_ACME);
    const p1 = await proposeRule({ ...ACME_PROMISES['privacy.01']!, ...days('<=', '30') }, main, COMMIT, model, NOW);
    const p9 = await proposeRule({ ...keep90, scope: [] }, main, COMMIT, model, NOW);
    expect(p1.ok && p1.rule.provenBy?.mutation).toContain('changed 30 to 31 at src/agent/chats.ts:2');
    expect(p9.ok && p9.rule.provenBy?.mutation).toContain('changed 30 to 91 at src/agent/chats.ts:2');
    if (!p1.ok || !p9.ok) return;
    const { runRule } = await import('../../src/rules/index.js');
    const retention = acmeFiles('agent/retention');
    expect(runRule(p1.rule, retention, 'aaa1111').outcome).toBe('fail');
    expect(runRule(p9.rule, retention, 'aaa1111')).toMatchObject({ outcome: 'pass', hits: [{ path: 'src/agent/chats.ts', startLine: 2 }] });
  });
});
