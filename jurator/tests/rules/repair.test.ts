// FU-1: the red-team loop. Spark attacks, the judge confirms, the writer repairs, the program re-proves.
import { describe, expect, it } from 'vitest';
import type { ModelClient, ModelJsonRequest, Rule, SourceFile } from '../../src/contracts.js';
import {
  editDiff,
  hardenRule,
  nextMutants,
  proposeRule,
  readMutants,
  repairInput,
  repairTaskKey,
  testMutants,
  writeMutants,
  type HardenReport,
} from '../../src/rules/index.js';
import { matchesAny } from '../../src/util/glob.js';
import { ACME_PROMISES, acmeFiles, fixedModel, hasAcme, SCRIPTED_ACME, scriptedModel } from './helpers.js';

const NOW = new Date('2026-11-04T04:00:00.000Z');
const COMMIT = '1111111111111111111111111111111111111111';

async function written(id: string, files: readonly SourceFile[]): Promise<{ rule: Rule; examples: { violation: readonly string[]; kept: readonly string[] } }> {
  const res = await proposeRule(ACME_PROMISES[id]!, files, COMMIT, scriptedModel(SCRIPTED_ACME), NOW);
  if (!res.ok) throw new Error(res.reason);
  return { rule: res.rule, examples: res.examples ?? { violation: [], kept: [] } };
}

async function harden(id: string, calls: string[] = [], writer: ModelClient = scriptedModel(SCRIPTED_ACME, calls)): Promise<HardenReport> {
  const files = acmeFiles('main');
  const p = ACME_PROMISES[id]!;
  const { rule, examples } = await written(id, files);
  const loadFiles = async (globs: readonly string[]): Promise<SourceFile[]> => files.filter((f) => matchesAny(f.path, globs));
  return hardenRule(rule, p, {
    attacker: scriptedModel(SCRIPTED_ACME, calls),
    judge: scriptedModel(SCRIPTED_ACME, calls),
    writer,
    attackFiles: async (r) => loadFiles([...r.globs, ...p.scope]),
    promptFiles: files,
    commit: COMMIT,
    now: NOW,
    propose: { loadFiles },
    examples,
  });
}

describe('repair task keys and input', () => {
  it('round 1 is rule-repair:<id>, round 2 adds the number', () => {
    expect(repairTaskKey('security.01', 1)).toBe('rule-repair:security.01');
    expect(repairTaskKey('security.01', 2)).toBe('rule-repair:security.01:2');
  });
  it('shows each evasion as a diff with why it breaks the promise', () => {
    expect(editDiff({ path: 'a.ts', find: 'x();', replace: 'try { x(); } catch {}' })).toBe('in a.ts:\n- x();\n+ try { x(); } catch {}');
    expect(editDiff({ path: 'b.ts', find: '', replace: 'y();' })).toBe('(added at the end of b.ts)\n+ y();');
  });
});

describe.skipIf(!hasAcme)('hardenRule over acme-notes (scripted)', () => {
  it('security.01: the try/catch evasion is repaired, re-proven, attacked again and closed', async () => {
    const calls: string[] = [];
    const h = await harden('security.01', calls);
    expect(h.redteam.verdict).toBe('weak');
    expect(h.verdict).toBe('closed');
    expect(h.repaired).toBe(true);
    expect(h.rule.id).toBe('R-security.01-1');
    expect(h.rule.pattern).toBe('^\\s*(?:await\\s+)?requireAdmin\\(\\s*\\w+\\s*\\);');
    // Re-proven: the base proof, the new route example, and the red-team edits (the evasion and the old break).
    expect(h.rule.provenBy?.mutation).toContain('failed on 2 red-team edits that break the promise');
    expect(h.rounds).toHaveLength(1);
    expect(h.rounds[0]).toMatchObject({ round: 1, outcome: 'proven' });
    expect(h.rounds[0]?.redteam?.verdict).toBe('held');
    expect(h.closed.map((e) => e.edit.replace)).toEqual(['  try { requireAdmin(req); } catch { /* keep going for a smoother UX */ }']);
    expect(h.open).toEqual([]);
    expect(h.message).toBe('evasion closed: R-security.01-1 now fails on 1 evasion it passed before');
    expect(calls).toEqual([
      'redteam:R-security.01-1',
      'redteam:judge:R-security.01-1:2',
      'rule-repair:security.01',
      'redteam:R-security.01-1',
    ]);
  });

  it('privacy.01: a repair the program rejects, then the writer says it cannot close: still evadable, first rule kept', async () => {
    const h = await harden('privacy.01');
    expect(h.verdict).toBe('still-evadable');
    expect(h.repaired).toBe(false);
    expect(h.rule.pattern).toBe('CHAT_TTL_DAYS\\s*=\\s*(?:[0-9]|[12][0-9]|30)\\b');
    expect(h.rounds.map((r) => r.outcome)).toEqual(['rejected', 'gave-up']);
    // The repair caught the evasion but no longer needs the constant: deleting `CHAT_TTL_DAYS = 30` (the first rule's
    // simulated break) still passes, so the program refused it.
    expect(h.rounds[0]?.reason).toBe(
      "the rule still passes on R-privacy.01-1's break (removed /CHAT_TTL_DAYS\\s*=\\s*(?:[0-9]|[12][0-9]|30)\\b/ at src/agent/chats.ts:2), which the older rule was proven to catch",
    );
    expect(h.rounds[1]?.reason).toMatch(/^Cannot close:/u);
    expect(h.open).toHaveLength(1);
    expect(h.message).toMatch(/^still evadable: src\/agent\/chats\.ts: .*365 \* 24/u);
  });

  it('the repair prompt carries the rule, the evasion diff, the judge note and the rejection', async () => {
    const seen: ModelJsonRequest<unknown>[] = [];
    const base = scriptedModel(SCRIPTED_ACME);
    const spy: ModelClient = { ...base, json: (req) => (seen.push(req as ModelJsonRequest<unknown>), base.json(req)) };
    await harden('privacy.01', [], spy);
    const [first, second] = seen;
    expect(first?.task).toBe('rule-repair:privacy.01');
    expect(first?.input).toContain('Current rule (it passes on every evasion below):');
    expect(first?.input).toContain('-   return now.getTime() - createdAt.getTime() > CHAT_TTL_DAYS * 24 * 60 * 60 * 1000;');
    expect(first?.input).toContain('+   return now.getTime() - createdAt.getTime() > 365 * 24 * 60 * 60 * 1000;');
    expect(first?.input).toContain('Judge: isExpired in src/agent/chats.ts compares against 365 days');
    expect(first?.input).toContain('Breaks the current rule catches (1)');
    expect(first?.instructions).toContain('Repairing a rule after a red team');
    expect(second?.task).toBe('rule-repair:privacy.01:2');
    expect(second?.input).toContain('Your previous repair was rejected by the program:');
  });

  it('a repair that raises a false alarm on a harmless change is refused', async () => {
    const files = acmeFiles('main');
    const p = ACME_PROMISES['security.01']!;
    const { rule } = await written('security.01', files);
    // The attacker sends the try/catch evasion and a harmless spacing change; the judge confirms only the first.
    const attacker = fixedModel({
      evasions: [
        { path: 'src/routes/export.ts', find: '  requireAdmin(req);', replace: '  try { requireAdmin(req); } catch {}', why: 'swallowed' },
        { path: 'src/routes/export.ts', find: '  requireAdmin(req);', replace: '  requireAdmin(req) ;', why: 'spacing' },
      ],
    });
    const judge = (input: { edit: { replace: string } }): { verdict: 'breaks' | 'keeps'; note: string } =>
      input.edit.replace.includes('try') ? { verdict: 'breaks', note: 'errors are swallowed' } : { verdict: 'keeps', note: 'still guarded' };
    const loadFiles = async (globs: readonly string[]): Promise<SourceFile[]> => files.filter((f) => matchesAny(f.path, globs));
    const h = await hardenRule(rule, p, {
      attacker,
      judge,
      writer: scriptedModel(SCRIPTED_ACME),
      attackFiles: async (r) => loadFiles([...r.globs, ...p.scope]),
      promptFiles: files,
      commit: COMMIT,
      now: NOW,
      propose: { loadFiles },
    });
    // The scripted repair needs `requireAdmin(req);` with no space before the semicolon: a false alarm, so refused.
    expect(h.rounds[0]).toMatchObject({ round: 1, outcome: 'rejected' });
    expect(h.rounds[0]?.reason).toMatch(/^the rule fails on harmless change 1 .*which keeps the promise \(a false alarm/u);
    // Round 2 has no scripted answer: the call fails, the first rule is kept, and the evasion stays open.
    expect(h.rounds[1]).toMatchObject({ round: 2, outcome: 'failed' });
    expect(h.rule).toBe(rule);
    expect(h.verdict).toBe('still-evadable');
  });

  it('live regression: a must-not-match repair that drops the constant is refused (the old must-match break passes it)', async () => {
    // The repair Wonder wrote in the live run (tasks/FU-1/live-redteam.txt): it catches the evasions, but deleting
    // CHAT_TTL_DAYS altogether passes it. The first rule failed on that deletion, so the repair is weaker there.
    const writer = fixedModel({
      feasible: true,
      reason: 'blocks long or computed lifetimes and hard-coded expiries',
      violationExamples: ['export const CHAT_TTL_DAYS = 45;', 'export const CHAT_TTL_DAYS = 30 * 12;', 'if (true) return false;'],
      keptExamples: ['export const CHAT_TTL_DAYS = 7;', 'export const CHAT_TTL_DAYS = 30;'],
      mode: 'must-not-match',
      pattern: '(?:CHAT_TTL_DAYS\\s*=\\s*(?:3[1-9]|[4-9]\\d|\\d{3,})\\b|CHAT_TTL_DAYS\\s*=\\s*\\d+\\s*[*+\\-/]|>\\s*\\d+\\s*\\*|return\\s+false\\b)',
      flags: null,
      anchor: null,
      within: null,
      globs: ['src/agent/**'],
      description: 'No retention code sets a long or computed lifetime.',
    });
    const h = await harden('privacy.01', [], writer);
    expect(h.rounds[0]?.outcome).toBe('rejected');
    expect(h.rounds[0]?.reason).toMatch(/^the rule still passes on R-privacy\.01-1's break \(removed /u);
    expect(h.repaired).toBe(false);
  });

  it('stops before a repair when the spend cap is reached', async () => {
    let asked = 0;
    const files = acmeFiles('main');
    const p = ACME_PROMISES['security.01']!;
    const { rule } = await written('security.01', files);
    const loadFiles = async (globs: readonly string[]): Promise<SourceFile[]> => files.filter((f) => matchesAny(f.path, globs));
    const h = await hardenRule(rule, p, {
      attacker: scriptedModel(SCRIPTED_ACME),
      judge: scriptedModel(SCRIPTED_ACME),
      writer: scriptedModel(SCRIPTED_ACME),
      attackFiles: async (r) => loadFiles([...r.globs, ...p.scope]),
      promptFiles: files,
      commit: COMMIT,
      now: NOW,
      propose: { loadFiles },
      // Under the cap for the first attack, over it before the repair.
      mayContinue: () => (asked += 1) === 1,
    });
    expect(h.rounds).toEqual([{ round: 1, outcome: 'skipped', reason: 'the spend cap was reached' }]);
    expect(h.verdict).toBe('still-evadable');
    expect(h.rule).toBe(rule);
    // Over the cap from the start: no attack call at all.
    const calls: string[] = [];
    const none = await hardenRule(rule, p, {
      attacker: scriptedModel(SCRIPTED_ACME, calls),
      judge: null,
      writer: scriptedModel(SCRIPTED_ACME, calls),
      attackFiles: async (r) => loadFiles([...r.globs, ...p.scope]),
      promptFiles: files,
      commit: COMMIT,
      now: NOW,
      mayContinue: () => false,
    });
    expect(calls).toEqual([]);
    expect(none).toMatchObject({ verdict: 'failed', message: 'R-security.01-1 was not attacked: the spend cap was reached' });
  });

  it('stored evasions: closed ones are re-run as mutants (caught on main), and the file round-trips', async () => {
    const h = await harden('security.01');
    const p = ACME_PROMISES['security.01']!;
    const data = nextMutants({ version: 1, rules: {} }, [h], COMMIT, [h.rule]);
    expect(data.rules[h.rule.id]?.evasions.map((e) => [e.closed, e.round])).toEqual([[true, 0]]);
    const main = acmeFiles('main');
    const load = async (globs: readonly string[]): Promise<SourceFile[]> => main.filter((f) => matchesAny(f.path, globs));
    const res = await testMutants(h.rule, p, data.rules[h.rule.id]!.evasions, COMMIT, load);
    expect(res.map((r) => r.outcome)).toEqual(['caught']);
    // The rule as first written passes the same evasion: `rule test` would report it MISSED (exit 1).
    const { rule: first } = await written('security.01', main);
    const weak = await testMutants(first, p, data.rules[h.rule.id]!.evasions, COMMIT, load);
    expect(weak.map((r) => r.outcome)).toEqual(['missed']);
    // Gone rules leave the file; a broken file reads as empty.
    expect(nextMutants(data, [], COMMIT, []).rules).toEqual({});
    const { mkdtemp, writeFile, mkdir } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = await mkdtemp(join(tmpdir(), 'kw-fu1-'));
    expect(await writeMutants(dir, data)).toBe(true);
    expect(await readMutants(dir)).toEqual(data);
    await mkdir(join(dir, 'local'), { recursive: true });
    await writeFile(join(dir, 'local', 'rule-mutants.json'), '{"version":2}');
    expect(await readMutants(dir)).toEqual({ version: 1, rules: {} });
  });

  it('privacy.01 keeps its open evasion as still open in the file', async () => {
    const h = await harden('privacy.01');
    const data = nextMutants({ version: 1, rules: {} }, [h], COMMIT, [h.rule]);
    expect(data.rules[h.rule.id]?.evasions.map((e) => e.closed)).toEqual([false]);
    const main = acmeFiles('main');
    const load = async (globs: readonly string[]): Promise<SourceFile[]> => main.filter((f) => matchesAny(f.path, globs));
    const res = await testMutants(h.rule, ACME_PROMISES['privacy.01'], data.rules[h.rule.id]!.evasions, COMMIT, load);
    expect(res.map((r) => r.outcome)).toEqual(['still-open']);
  });

  it('repairInput lists harmless changes the new rule must pass', () => {
    const p = ACME_PROMISES['security.01']!;
    const r: Rule = {
      id: 'R-security.01-1', promiseId: 'security.01', description: 'x x x', mode: 'each-near', pattern: 'requireAdmin\\(',
      anchor: 'router', within: 3, globs: ['src/routes/**'], provenBy: null, status: 'proposed', author: 'model', createdAt: NOW.toISOString(),
    };
    const text = repairInput(p, r, [], COMMIT, [], [], [{ path: 'a.ts', find: 'a', replace: 'b' }], { violation: ['v1'], kept: [] }, null);
    expect(text).toContain('Harmless changes (1): the judge said the promise still holds; your rule must PASS on each one.');
    expect(text).toContain('Its violation examples: `v1`');
  });
});
