import { describe, expect, it } from 'vitest';
import { proveRuleCanFail, runRule } from '../../src/rules/index.js';
import { compileSafe, displayPattern, unsafeReason } from '../../src/rules/regex.js';
import { COMMIT, rule } from './helpers.js';

const routes = {
  path: 'src/routes/export.ts',
  text: [
    "import { requireAdmin } from '../auth/require-admin.js';", // 1
    '', // 2
    "router.get('/export', async (req, res) => {", // 3
    '  requireAdmin(req);', // 4
    '  res.send("ok");', // 5
    '});', // 6
    '', // 7
    "router.get('/export.csv', async (req, res) => {", // 8
    '  res.send("csv");', // 9
    '});', // 10
  ].join('\n'),
};
const guarded = { path: routes.path, text: routes.text.replace("'/export.csv', async (req, res) => {", "'/export.csv', async (req, res) => {\n  requireAdmin(req);") };
const chats = { path: 'src/agent/chats.ts', text: '/** ttl */\nexport const CHAT_TTL_DAYS = 30;\n' };
const logs = { path: 'src/log.ts', text: "export function log(event: string) {}\nlog('login', { user });\n" };

describe('runRule', () => {
  it('must-match passes with the matching line as citation, fails when missing', () => {
    const r = rule({ mode: 'must-match', pattern: 'CHAT_TTL_DAYS\\s*=\\s*30\\b', globs: ['src/agent/**'] });
    const pass = runRule(r, [chats, logs], COMMIT);
    expect(pass.outcome).toBe('pass');
    expect(pass.hits).toEqual([{ path: 'src/agent/chats.ts', commit: COMMIT, startLine: 2, endLine: 2, quote: 'export const CHAT_TTL_DAYS = 30;' }]);
    expect(pass.message).toContain('src/agent/chats.ts:2');
    const fail = runRule(r, [{ path: chats.path, text: chats.text.replace('30', '90') }], COMMIT);
    expect(fail.outcome).toBe('fail');
    // A must-match failure cites the lines that still name what the rule requires: where the value changed.
    expect(fail.message).toBe('src/agent/chats.ts:2 has CHAT_TTL_DAYS but no line in 1 file under src/agent/** has /CHAT_TTL_DAYS\\s*=\\s*30\\b/');
    expect(fail.hits).toEqual([{ path: 'src/agent/chats.ts', commit: COMMIT, startLine: 2, endLine: 2, quote: 'export const CHAT_TTL_DAYS = 90;' }]);
    const gone = runRule(r, [{ path: chats.path, text: '// nothing here\n' }], COMMIT);
    expect(gone).toMatchObject({ outcome: 'fail', hits: [], message: 'no line in 1 file under src/agent/** has /CHAT_TTL_DAYS\\s*=\\s*30\\b/' });
    expect(runRule(r, [logs], COMMIT).message).toContain('no file matches src/agent/**');
  });

  it('only looks at files under the rule globs', () => {
    const r = rule({ mode: 'must-match', pattern: 'CHAT_TTL_DAYS', globs: ['src/routes/**'] });
    expect(runRule(r, [chats], COMMIT).outcome).toBe('fail');
  });

  it('must-not-match fails on the offending line and passes when absent', () => {
    const r = rule({ mode: 'must-not-match', pattern: '\\blog\\([^)]*\\bpassword\\b', flags: 'i' });
    expect(runRule(r, [logs], COMMIT)).toMatchObject({ outcome: 'pass', hits: [] });
    const bad = { path: logs.path, text: `${logs.text}log('login', { PASSWORD });\n` };
    const fail = runRule(r, [bad], COMMIT);
    expect(fail.outcome).toBe('fail');
    expect(fail.hits[0]).toMatchObject({ path: 'src/log.ts', startLine: 3, quote: "log('login', { PASSWORD });" });
    expect(fail.message).toMatch(/^src\/log\.ts:3 has /u);
  });

  it('each-near fails on an unguarded anchor, names the line in plain words', () => {
    const r = rule({ mode: 'each-near', anchor: 'router\\.(get|post)\\(', pattern: 'requireAdmin\\(', within: 3, globs: ['src/routes/**'] });
    const fail = runRule(r, [routes], COMMIT);
    expect(fail.outcome).toBe('fail');
    expect(fail.message).toBe('src/routes/export.ts:8 has router.get( with no requireAdmin( within 3 lines');
    expect(fail.hits).toEqual([{ path: routes.path, commit: COMMIT, startLine: 8, endLine: 8, quote: "router.get('/export.csv', async (req, res) => {" }]);
    const pass = runRule(r, [guarded], COMMIT);
    expect(pass.outcome).toBe('pass');
    expect(pass.hits.map((h) => [h.startLine, h.endLine])).toEqual([[3, 4], [8, 9]]);
    expect(pass.hits[0]?.quote).toBe("router.get('/export', async (req, res) => {\n  requireAdmin(req);");
  });

  it('each-near counts a guard on the anchor line itself, and respects within', () => {
    const inline = { path: 'src/routes/a.ts', text: "router.get('/x', requireAdmin(), h);\n" };
    const r = rule({ mode: 'each-near', anchor: 'router\\.get\\(', pattern: 'requireAdmin\\(', within: 0 });
    expect(runRule(r, [inline], COMMIT).outcome).toBe('pass');
    const far = { path: 'src/routes/b.ts', text: "router.get('/x', h);\n\n\n\nrequireAdmin(req);\n" };
    expect(runRule({ ...r, within: 3 }, [far], COMMIT).outcome).toBe('fail');
    expect(runRule({ ...r, within: 4 }, [far], COMMIT).outcome).toBe('pass');
  });

  it('whole-file patterns (s flag) cite the line range of the match', () => {
    const r = rule({ mode: 'must-match', pattern: "router\\.get\\('/export',.*?requireAdmin\\(", flags: 's' });
    const pass = runRule(r, [routes], COMMIT);
    expect(pass.outcome).toBe('pass');
    expect(pass.hits[0]).toMatchObject({ startLine: 3, endLine: 4 });
  });

  it('returns error (never throws) for unsafe or invalid patterns', () => {
    for (const pattern of ['(a+)+$', '(\\w+\\s?)*x', '(a)\\1', '(?<n>a)\\k<n>', '((ab)*c)+', '[unclosed']) {
      const res = runRule(rule({ mode: 'must-match', pattern }), [chats], COMMIT);
      expect(res.outcome, pattern).toBe('error');
    }
    expect(runRule(rule({ mode: 'each-near', pattern: 'x' }), [chats], COMMIT).outcome).toBe('error');
  });
});

describe('regex safety', () => {
  it('accepts the patterns rules need', () => {
    for (const p of ['requireAdmin\\(', 'router\\.(?:get|post)\\(\\s*[\'"]/export', 'a{2,3}', '(get|post)?x', '\\b(?:log|console\\.\\w+)\\([^)]*\\bpassword\\b', '[(+*]+']) {
      expect(unsafeReason(p), p).toBeNull();
    }
  });
  it('rejects back-references, nested repeats and over-long patterns', () => {
    expect(unsafeReason('(a)\\1')).toMatch(/back-reference/u);
    expect(unsafeReason('(a+)+')).toMatch(/repeats a group/u);
    expect(unsafeReason('(a*){2,}')).toMatch(/repeats a group/u);
    expect(unsafeReason('(?:x(a+))*')).toMatch(/repeats a group/u);
    expect(unsafeReason('(a|ab)*c')).toMatch(/alternatives/u);
    expect(unsafeReason('(?:get|post)\\(')).toBeNull();
    expect(unsafeReason('(?:get|post)?x')).toBeNull();
    expect(unsafeReason('x'.repeat(401))).toMatch(/longer/u);
    expect(() => compileSafe('(a+)+')).toThrow(/not safe/u);
    expect(() => compileSafe('a', 'g')).not.toThrow();
    expect(() => compileSafe('a', 'x')).toThrow(/flags/u);
  });
  it('shows simple patterns as plain text', () => {
    expect(displayPattern('requireAdmin\\(')).toBe('requireAdmin(');
    expect(displayPattern('a\\s+b')).toBe('/a\\s+b/');
  });
  it('caps very long lines instead of scanning them whole', () => {
    const long = { path: 'src/min.js', text: `${'x'.repeat(5000)}NEEDLE` };
    expect(runRule(rule({ mode: 'must-match', pattern: 'NEEDLE' }), [long], COMMIT).outcome).toBe('fail');
  });
});

describe('proveRuleCanFail', () => {
  it('must-match: blanking the matching lines makes it fail', () => {
    const r = rule({ mode: 'must-match', pattern: 'CHAT_TTL_DAYS\\s*=\\s*30\\b', globs: ['src/agent/**'] });
    const proof = proveRuleCanFail(r, [chats], COMMIT);
    expect(proof).toEqual({ ok: true, mutation: 'removed 1 line with /CHAT_TTL_DAYS\\s*=\\s*30\\b/ (src/agent/chats.ts:2); the rule then failed' });
  });
  it('each-near: removing the guard makes it fail', () => {
    const r = rule({ mode: 'each-near', anchor: 'router\\.get\\(', pattern: 'requireAdmin\\(', within: 3 });
    const proof = proveRuleCanFail(r, [guarded], COMMIT);
    expect(proof.ok).toBe(true);
    expect(proof.mutation).toBe('removed requireAdmin( from 2 lines (src/routes/export.ts:4, src/routes/export.ts:9); the rule then failed');
  });
  it('catches a rule that cannot fail', () => {
    // matches the empty string: still passes after every matching line is blanked
    expect(proveRuleCanFail(rule({ mode: 'must-match', pattern: 'x*' }), [chats], COMMIT)).toMatchObject({ ok: false });
    expect(proveRuleCanFail(rule({ mode: 'must-match', pattern: 'x*' }), [chats], COMMIT).mutation).toMatch(/still passed/u);
    // each-near whose anchor never matches: passes vacuously, nothing to remove
    const vacuous = rule({ mode: 'each-near', anchor: 'nothingLikeThis', pattern: 'requireAdmin\\(' });
    expect(proveRuleCanFail(vacuous, [routes], COMMIT)).toMatchObject({ ok: false });
  });
  it('must-not-match: adding the violation example must make it fail', () => {
    const r = rule({ mode: 'must-not-match', pattern: '\\blog\\([^)]*\\bpassword\\b' });
    expect(proveRuleCanFail(r, [logs], COMMIT, { violationExample: "log('x', { password });" })).toEqual({
      ok: true,
      mutation: "added the line `log('x', { password });` to src/log.ts; the rule then failed",
    });
    expect(proveRuleCanFail(r, [logs], COMMIT, { violationExample: "log('x', { email });" }).ok).toBe(false);
    expect(proveRuleCanFail(r, [logs], COMMIT).mutation).toMatch(/needs an example/u);
  });
  it('refuses to prove a rule that already fails', () => {
    const r = rule({ mode: 'each-near', anchor: 'router\\.get\\(', pattern: 'requireAdmin\\(', within: 3 });
    expect(proveRuleCanFail(r, [routes], COMMIT)).toMatchObject({ ok: false });
  });
});

describe('requiredName (near-miss citations for must-match failures)', () => {
  it('finds the longest name a pattern always needs', async () => {
    const { requiredName } = await import('../../src/rules/engine.js');
    expect(requiredName('CHAT_TTL_DAYS\\s*=\\s*(?:[0-9]|[12][0-9]|30)\\b')).toBe('CHAT_TTL_DAYS');
    expect(requiredName("approvalGate\\(\\s*['\"]export_notes['\"]")).toBe('approvalGate');
    expect(requiredName('a|bcdefg')).toBeNull();
    expect(requiredName('(?:foo|barbaz)\\(')).toBeNull();
    expect(requiredName('logs?Event')).toBe('Event');
  });
});
