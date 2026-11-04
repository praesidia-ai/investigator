// FX-1: every probe from the E-1 and E-2 evaluations, as a test. A rule must never say "pass" (HOLDS) for code that
// breaks the promise in these ways: the value hidden in arithmetic, the old value or the guard left in a comment, a
// rule that finds nothing to check, a pattern that hangs.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { Rule } from '../../src/contracts.js';
import { proveRuleCanFail, runRule } from '../../src/rules/engine.js';
import { codeView, evaluate, valueAssigned } from '../../src/rules/code-text.js';
import { resetSandbox, setScanBudget } from '../../src/rules/sandbox.js';
import { unsafeReason } from '../../src/rules/regex.js';

const C = 'c'.repeat(40);
const raw = JSON.parse(readFileSync(join(import.meta.dirname, '../../fixtures/report/acme/.jurator/rules.json'), 'utf8')) as { items: Rule[] };
const RULES = Object.fromEntries(raw.items.map((r) => [r.promiseId, r] as const)) as Record<string, Rule>;
const LE30 = { op: '<=' as const, value: 30, unit: 'days' };
const run = (pid: string, path: string, text: string, constraint: typeof LE30 | null = null) =>
  runRule(RULES[pid] as Rule, [{ path, text }], C, { constraint });

describe('E-1 probes: privacy.01 (retention <= 30 days)', () => {
  it('control: an honest break (= 90) fails', () => {
    expect(run('privacy.01', 'src/agent/chats.ts', 'export const CHAT_TTL_DAYS = 90;\n', LE30).outcome).toBe('fail');
  });
  it('`CHAT_TTL_DAYS = 30 * 3` fails: the program evaluates the constant (90) and compares it with the promise', () => {
    const r = run('privacy.01', 'src/agent/chats.ts', 'export const CHAT_TTL_DAYS = 30 * 3;\n', LE30);
    expect(r.outcome).toBe('fail');
    expect(r.message).toBe('src/agent/chats.ts:1: CHAT_TTL_DAYS is 90 (30 * 3); the policy allows at most 30 days');
    expect(r.hits[0]?.quote).toBe('export const CHAT_TTL_DAYS = 30 * 3;');
  });
  it('the old value in a comment above the break (`// was: CHAT_TTL_DAYS = 30`) fails: comments are not code', () => {
    const r = run('privacy.01', 'src/agent/chats.ts', '// was: CHAT_TTL_DAYS = 30\nexport const CHAT_TTL_DAYS = 90;\n');
    expect(r.outcome).toBe('fail');
    expect(r.hits.map((h) => h.startLine)).toEqual([2]);
  });
  it('the old value in a block comment, a trailing comment or a lone string also fails', () => {
    for (const text of [
      '/* CHAT_TTL_DAYS = 30 */\nexport const CHAT_TTL_DAYS = 90;\n',
      '/*\n * CHAT_TTL_DAYS = 30\n */\nexport const CHAT_TTL_DAYS = 90;\n',
      'export const CHAT_TTL_DAYS = 90; // CHAT_TTL_DAYS = 30\n',
      "'CHAT_TTL_DAYS = 30';\nexport const CHAT_TTL_DAYS = 90;\n",
    ]) {
      expect(run('privacy.01', 'src/agent/chats.ts', text).outcome, text).toBe('fail');
    }
  });
  it('a value that is not a literal fails honestly: the rule cannot prove it', () => {
    const r = run('privacy.01', 'src/agent/chats.ts', 'export const CHAT_TTL_DAYS = 30 || Number(process.env.TTL);\n', LE30);
    expect(r.outcome).toBe('fail');
    expect(r.message).toContain('is not a literal; cannot prove <= 30 days');
  });
  it('literal values that keep the promise still pass (30, 3 * 10, 30 days written in hours)', () => {
    expect(run('privacy.01', 'src/agent/chats.ts', 'export const CHAT_TTL_DAYS = 30;\n', LE30).outcome).toBe('pass');
    expect(run('privacy.01', 'src/agent/chats.ts', 'export const CHAT_TTL_DAYS = 30 * 1; // = 3 * 10\n', LE30).outcome).toBe('pass');
    const hours = { ...(RULES['privacy.01'] as Rule), pattern: 'CHAT_TTL_HOURS\\s*=\\s*\\d' };
    expect(runRule(hours, [{ path: 'src/agent/chats.ts', text: 'const CHAT_TTL_HOURS = 30 * 24;\n' }], C, { constraint: LE30 }).outcome).toBe('pass');
    expect(runRule(hours, [{ path: 'src/agent/chats.ts', text: 'const CHAT_TTL_HOURS = 31 * 24;\n' }], C, { constraint: LE30 }).message).toContain(
      'CHAT_TTL_HOURS is 744 (31 * 24), which is 31 days; the policy allows at most 30 days',
    );
  });
  it('the constant kept but a tripled copy used elsewhere is a known limit of a rule on one constant', () => {
    // The rule guards the line it names; it does not follow every use. Bindings and the AI read cover the rest.
    expect(run('privacy.01', 'src/agent/chats.ts', 'export const CHAT_TTL_DAYS = 30;\nconst ttl = CHAT_TTL_DAYS * 3;\n', LE30).outcome).toBe('pass');
  });
});

describe('E-2 probes: security.01 (every export route has requireAdmin( within 3 lines)', () => {
  const file = (line: string) => [{ path: 'src/routes/export.ts', text: `${line}\n` }];
  const rule = RULES['security.01'] as Rule;
  it('control: an unguarded route fails', () => {
    expect(runRule(rule, file("router.get('/export.csv', handler);"), C).outcome).toBe('fail');
  });
  it('the guard named in a comment does not guard the route', () => {
    expect(runRule(rule, file("router.get('/export.csv', handler); // TODO requireAdmin("), C).outcome).toBe('fail');
  });
  it('a commented-out route is not a route, and a route the anchor cannot see is never a pass', () => {
    for (const line of [
      "router.all('/export.csv', handler);",
      "app.get('/export.csv', handler);",
      'router.get(EXPORT_CSV, handler);',
      "router\n  .get('/export.csv', handler);",
      "// router.get('/export.csv', handler);",
    ]) {
      const r = runRule(rule, file(line), C);
      expect(r.outcome, line).toBe('error');
      expect(r.message).toMatch(/^rule found nothing to check: no code line in 1 file under src\/routes\/\*\* has/u);
    }
  });
  it('a guarded route still passes; a // inside a string is not a comment', () => {
    const text = "router.get('/export//all', async (req, res) => {\n  requireAdmin(req);\n});\n";
    expect(runRule(rule, [{ path: 'src/routes/export.ts', text }], C).outcome).toBe('pass');
  });
  it('a rule whose anchor matches nothing cannot be proven, so it is never saved', () => {
    const proof = proveRuleCanFail(rule, file("app.get('/export.csv', handler);"), C, {});
    expect(proof.ok).toBe(false);
    expect(proof.mutation).toContain('rule found nothing to check');
  });
});

describe('E-2 probes: security.03 (never log passwords) and privacy.02 (exports skip deleted notes)', () => {
  const rule = RULES['security.03'] as Rule;
  it('control: logging the password fails; a commented-out log line is dead code', () => {
    expect(runRule(rule, [{ path: 'src/x.ts', text: "log('login', user.password);\n" }], C).outcome).toBe('fail');
    expect(runRule(rule, [{ path: 'src/x.ts', text: "// log('login', user.password);\n" }], C).outcome).toBe('pass');
  });
  // Known limits of these model-written patterns (not of the engine): FX-3's red-team step is meant to reject such
  // rules before they are saved. Marked `fails` so the day they are caught, these tests say so.
  it.fails('known limit: a nested call before the field', () => {
    expect(runRule(rule, [{ path: 'src/x.ts', text: 'log(String(user.id), user.password);\n' }], C).outcome).toBe('fail');
  });
  it.fails('known limit: a call split over two lines', () => {
    expect(runRule(rule, [{ path: 'src/x.ts', text: "log('login',\n  user.password);\n" }], C).outcome).toBe('fail');
  });
  it.fails('known limit: the password through a variable', () => {
    expect(runRule(rule, [{ path: 'src/x.ts', text: "const p = user.password;\nlog('login', p);\n" }], C).outcome).toBe('fail');
  });
  it.fails('known limit: a new unfiltered export beside the old filtered one', () => {
    const text = 'const ok = n.deletedAt === null && n.archivedAt === null;\nexport function exportAll(){ return db.notes.all(); }\n';
    expect(runRule(RULES['privacy.02'] as Rule, [{ path: 'src/export/notes.ts', text }], C).outcome).toBe('fail');
  });
});

describe('E-2 probes: patterns that hang are stopped by the time budget', () => {
  afterAll(() => {
    setScanBudget(2000);
    resetSandbox();
  });
  const cases: Array<[string, string, string]> = [
    ['\\s*\\s*\\s*\\s*\\s*\\s*x', '', ' '.repeat(1999)],
    ['.*.*.*.*.*x', '', 'a'.repeat(1999)],
    ['\\w+\\w+\\w+\\w+\\w+\\w+!', '', 'a'.repeat(1999)],
    ['[\\s\\S]*[\\s\\S]*[\\s\\S]*x', 's', 'a'.repeat(20000)],
  ];
  it.each(cases)('/%s/ (flags "%s") passes the syntax check, then times out as a rule error', (pattern, flags, text) => {
    expect(unsafeReason(pattern)).toBeNull();
    setScanBudget(250);
    const rule: Rule = { ...(RULES['privacy.01'] as Rule), id: 'R-x-1', pattern, flags, globs: ['**'] };
    const t = performance.now();
    const r = runRule(rule, [{ path: 'a.ts', text }], C);
    expect(performance.now() - t).toBeLessThan(5000);
    expect(r.outcome).toBe('error');
    expect(r.message).toContain('took longer than 250 ms and was stopped');
  });
  it('after a timeout the next rule runs normally (a new worker)', () => {
    setScanBudget(2000);
    expect(run('privacy.01', 'src/agent/chats.ts', 'export const CHAT_TTL_DAYS = 30;\n').outcome).toBe('pass');
  });
  it('a proof that times out is not ok, and says why', () => {
    setScanBudget(250);
    const rule: Rule = { ...(RULES['privacy.01'] as Rule), id: 'R-x-2', pattern: '.*.*.*.*.*x', flags: '', globs: ['**'] };
    const proof = proveRuleCanFail(rule, [{ path: 'a.ts', text: `${'a'.repeat(1999)}\nx\n` }], C);
    expect(proof.ok).toBe(false);
    expect(proof.mutation).toContain('took longer than');
    setScanBudget(2000);
  });
});

describe('code-text helpers', () => {
  it('blanks comments (same length), keeps strings, empties string-only lines in the live view', () => {
    const v = codeView('a.ts', "const a = 'x // y'; // note\n/* a\n b */ const b = 1;\n'use strict';\n");
    expect(v.code[0]).toBe("const a = 'x // y';        ");
    expect(v.code[1]?.trim()).toBe('');
    expect(v.code[2]).toBe('      const b = 1;');
    expect(v.live[3]).toBe('');
    expect(codeView('a.py', '# CHAT_TTL_DAYS = 30\n"""\nCHAT_TTL_DAYS = 30\n"""\nCHAT_TTL_DAYS = 90\n').live).toEqual(['                    ', '', '', '', 'CHAT_TTL_DAYS = 90', '']);
    expect(codeView('a.md', '# Title').code).toEqual(['# Title']);
  });
  it('a string-only check stays fast on lines with many backslashes (R4-I: a vendored masking.ts hung rule propose)', () => {
    const line = `    "${'\\\\bsms\\\\b|'.repeat(40)}" +`;
    const started = Date.now();
    const v = codeView('a.ts', `${line}\n  'a\\'b';\n'x\\\\';\n`);
    expect(Date.now() - started).toBeLessThan(500);
    expect(v.live[0]).toBe(line);
    expect(v.live[1]).toBe('');
    expect(v.live[2]).toBe('');
  });
  it('reads assigned values: literals, arithmetic, keys, types; anything else is an expression', () => {
    expect(valueAssigned('export const CHAT_TTL_DAYS: number = 30 * 3;', 'CHAT_TTL_DAYS')).toMatchObject({ kind: 'number', value: 90 });
    expect(valueAssigned('  "dataRetentionDays": 1_000,', 'dataRetentionDays')).toMatchObject({ kind: 'number', value: 1000 });
    expect(valueAssigned('const cfg = { ttlDays: 30 };', 'ttlDays')).toMatchObject({ kind: 'number', value: 30 });
    expect(valueAssigned('CHAT_TTL_DAYS = days(30)', 'CHAT_TTL_DAYS')).toEqual({ kind: 'expression', text: 'days(30)' });
    expect(valueAssigned('if (CHAT_TTL_DAYS === 30) {}', 'CHAT_TTL_DAYS')).toBeNull();
    expect(evaluate('(10 + 5) * 2')).toBe(30);
    expect(evaluate('30 * DAY')).toBeNull();
  });
});
