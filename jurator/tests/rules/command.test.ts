import { describe, expect, it } from 'vitest';
import { runRuleCommand, type RuleCommandDeps } from '../../src/cli/commands/rule.js';
import { DEFAULT_CONFIG, type GitRepo, type Rule, type Store } from '../../src/contracts.js';
import type { MutantsFile } from '../../src/rules/index.js';
import { matchesAny } from '../../src/util/glob.js';
import { makeCtx } from '../command-context.js';

import { ACME_PROMISES, acmeFiles, hasAcme, SCRIPTED_ACME, scriptedModel } from './helpers.js';

const SHAS: Record<string, string> = { main: '1111111111111111111111111111111111111111', 'feature/csv-export': '2222222222222222222222222222222222222222' };

function fakeWorld() {
  const files = new Map(Object.keys(SHAS).map((ref) => [SHAS[ref] as string, acmeFiles(ref)]));
  let rules: Rule[] = [];
  let infeasible: string[] = [];
  let mutants: MutantsFile = { version: 1, rules: {} };
  const writes: Rule[][] = [];
  const store = {
    dir: '/x/.jurator',
    repoRoot: '/x',
    exists: async () => true,
    readConfig: async () => DEFAULT_CONFIG,
    readPromises: async () => Object.values(ACME_PROMISES),
    readRules: async () => rules,
    writeRules: async (items: Rule[]) => {
      rules = items;
      writes.push(items);
    },
  } as unknown as Store;
  const repo: GitRepo = {
    root: '/x',
    snapshot: async () => ({ repo: '/x', branch: 'main', commit: SHAS.main as string, dirty: false }),
    resolve: async (ref) => SHAS[ref === 'HEAD' ? 'main' : ref] ?? ref,
    listFiles: async (commit, globs) => (files.get(commit) ?? []).map((f) => f.path).filter((p) => matchesAny(p, globs)),
    readFile: async (commit, path) => (files.get(commit) ?? []).find((f) => f.path === path)?.text ?? '',
    changedFiles: async () => [],
  };
  const scriptedDirs: Array<string | undefined> = [];
  const deps: RuleCommandDeps = {
    findRepoRoot: async () => '/x',
    openStore: () => store,
    openRepo: async () => repo,
    createModel: (o) => {
      scriptedDirs.push(o.scriptedDir);
      return scriptedModel(SCRIPTED_ACME);
    },
    // In memory, so tests never write a cache file outside a temp dir.
    infeasible: { read: async () => [...infeasible], write: async (_d, ids) => ((infeasible = [...ids]), true) },
    mutants: { read: async () => mutants, write: async (_d, data) => ((mutants = data), true) },
  };
  return { deps, writes, scriptedDirs, rules: () => rules, mutants: () => mutants };
}
const ctx = (argv: string[]) => makeCtx('/x', argv);

describe.skipIf(!hasAcme)('jurator rule (fake store and git over acme-notes)', () => {
  it('propose --all --accept writes rules for coverable promises and explains the rest', async () => {
    const w = fakeWorld();
    const { c, out } = ctx(['propose', '--all', '--accept', '--scripted', 'fixtures/scripted/acme']);
    expect(await runRuleCommand(c, w.deps)).toBe(0);
    expect(w.scriptedDirs).toEqual(['/x/fixtures/scripted/acme']);
    expect(w.rules().map((r) => [r.id, r.status])).toEqual([
      ['R-praesidia.03-1', 'accepted'],
      ['R-privacy.01-1', 'accepted'],
      ['R-privacy.02-1', 'accepted'],
      ['R-security.01-1', 'accepted'],
      ['R-security.03-1', 'accepted'],
    ]);
    const text = out.join('\n');
    expect(text).toContain('✓ security.01  R-security.01-1 written and accepted (each-near)');
    expect(text).toContain('proof: removed requireAdmin( from 1 line (src/routes/export.ts:9); the rule then failed');
    expect(text).toContain('privacy.03  no rule possible: Selling or sharing notes');
    expect(text).toContain('(it stays on AI reads)');
    expect(text).toContain('5 of 6 written');
  });

  it('list shows coverage; test passes on main and fails (exit 1) on feature/csv-export', async () => {
    const w = fakeWorld();
    await runRuleCommand(ctx(['propose', '--all', '--scripted', 'x']).c, w.deps);
    expect(w.rules().every((r) => r.status === 'proposed')).toBe(true);

    const l1 = ctx(['list']);
    await runRuleCommand(l1.c, w.deps);
    expect(l1.out.join('\n')).toContain('0 of 6 code promises covered by rules');

    expect(await runRuleCommand(ctx(['accept', '--all']).c, w.deps)).toBe(0);
    const l2 = ctx(['list', '--json']);
    await runRuleCommand(l2.c, w.deps);
    expect(JSON.parse(l2.out.join('\n')).coverage).toEqual({ covered: 5, codePromises: 6, uncovered: ['privacy.03'] });

    const t1 = ctx(['test']);
    expect(await runRuleCommand(t1.c, w.deps)).toBe(0);
    expect(t1.out.join('\n')).toContain('5 rules: 5 pass, 0 fail, 0 error');

    const t2 = ctx(['test', '--at', 'feature/csv-export']);
    expect(await runRuleCommand(t2.c, w.deps)).toBe(1);
    const text = t2.out.join('\n');
    expect(text).toContain("✗ FAIL  R-security.01-1  security.01  src/routes/export.ts:15 has router.get('/export with no requireAdmin( within 3 lines");
    expect(text).toContain("src/routes/export.ts:15  router.get('/export.csv', async (req, res) => {");

    const t3 = ctx(['test', 'R-privacy.01-1', '--at', 'feature/csv-export', '--json']);
    expect(await runRuleCommand(t3.c, w.deps)).toBe(0);
    expect(JSON.parse(t3.out.join('\n')).results[0].outcome).toBe('pass');
  });

  it('refuses to accept a rule that was never proven, and bad input exits through JuratorError', async () => {
    const w = fakeWorld();
    const unproven: Rule = {
      id: 'R-privacy.01-9', promiseId: 'privacy.01', description: 'hand rule', mode: 'must-match', pattern: 'x',
      globs: ['src/**'], provenBy: null, status: 'proposed', author: 'human', createdAt: '2026-11-04T04:00:00.000Z',
    };
    await w.deps.openStore('/x').writeRules([unproven]);
    await expect(runRuleCommand(ctx(['accept', 'R-privacy.01-9']).c, w.deps)).rejects.toThrow(/never shown able to fail/u);
    await expect(runRuleCommand(ctx(['propose', 'nope.01']).c, w.deps)).rejects.toThrow(/no promise nope.01/u);
    await expect(runRuleCommand(ctx(['propose']).c, w.deps)).rejects.toThrow(/say which promise/u);
    const bad = ctx(['frobnicate']);
    expect(await runRuleCommand(bad.c, w.deps)).toBe(2);
    expect(bad.err.join('\n')).toContain('Unknown subcommand');
  });
});

// WP-R2: concurrency with stable output, live progress lines, and the infeasible cache.
describe.skipIf(!hasAcme)('jurator rule propose: 4 at a time, infeasible cache', () => {
  /** The scripted acme answers, but as a slow "live" model: later promises answer first. */
  function slowLive(peak: { now: number; max: number }) {
    const base = scriptedModel(SCRIPTED_ACME);
    const order = Object.keys(ACME_PROMISES).sort();
    return {
      id: 'slow-live',
      mode: 'live' as const,
      async json<T>(req: import('../../src/contracts.js').ModelJsonRequest<T>) {
        peak.now += 1;
        peak.max = Math.max(peak.max, peak.now);
        const i = order.indexOf(req.task.replace('rule-propose:', ''));
        await new Promise((r) => setTimeout(r, 5 + (order.length - i) * 4));
        peak.now -= 1;
        return base.json(req);
      },
    };
  }
  function memoryCache(initial: string[] = []) {
    const state = { ids: initial, writes: 0 };
    return {
      state,
      cache: {
        read: async () => [...state.ids],
        write: async (_dir: string, ids: readonly string[]) => {
          state.ids = [...ids];
          state.writes += 1;
          return true;
        },
      },
    };
  }

  it('runs up to 4 at once (--concurrency 4), prints progress as answers come back, and results in promise order', async () => {
    const w = fakeWorld();
    const peak = { now: 0, max: 0 };
    const mem = memoryCache();
    const deps: RuleCommandDeps = { ...w.deps, createModel: () => slowLive(peak), infeasible: mem.cache };
    const { c, out } = ctx(['propose', '--all', '--accept', '--concurrency', '4']);
    expect(await runRuleCommand(c, deps)).toBe(0);
    expect(peak.max).toBe(4);
    expect(out[0]).toBe('Writing rules for 6 promises at 1111111 with slow-live (live), 4 at a time');
    const progress = out.filter((l) => /^ {2}\[\d\/6\]/u.test(l));
    expect(progress).toHaveLength(6);
    expect(progress[0]).toMatch(/^ {2}\[1\/6\] (?!praesidia\.03)/u); // finish order, not promise order
    const results = out.filter((l) => /^[✓–] /u.test(l)).map((l) => l.split(/\s+/u)[1]);
    expect(results).toEqual(['praesidia.03', 'privacy.01', 'privacy.02', 'privacy.03', 'security.01', 'security.03']);
    expect(out).toContain('  [6/6] ' + progress[5]!.slice(8));
    expect(mem.state.ids).toEqual(['privacy.03']);
  });

  it('R4-FIX: the default runs up to 8 at once (all 6 here)', async () => {
    const w = fakeWorld();
    const peak = { now: 0, max: 0 };
    const deps: RuleCommandDeps = { ...w.deps, createModel: () => slowLive(peak), infeasible: memoryCache().cache };
    const { c, out } = ctx(['propose', '--all']);
    expect(await runRuleCommand(c, deps)).toBe(0);
    expect(peak.max).toBe(6);
    expect(out[0]).toBe('Writing rules for 6 promises at 1111111 with slow-live (live), 6 at a time');
  });

  it('--jobs 1 runs one at a time; a bad --jobs or --concurrency is bad input', async () => {
    const w = fakeWorld();
    const peak = { now: 0, max: 0 };
    const deps: RuleCommandDeps = { ...w.deps, createModel: () => slowLive(peak), infeasible: memoryCache().cache };
    const { c, out } = ctx(['propose', '--all', '--jobs', '1']);
    expect(await runRuleCommand(c, deps)).toBe(0);
    expect(peak.max).toBe(1);
    expect(out[0]).toBe('Writing rules for 6 promises at 1111111 with slow-live (live)');
    await expect(runRuleCommand(ctx(['propose', '--all', '--jobs', '0']).c, deps)).rejects.toThrow(/--concurrency \(or --jobs\) must be a whole number/u);
    await expect(runRuleCommand(ctx(['propose', '--all', '--concurrency', '17']).c, deps)).rejects.toThrow(/from 1 to 16/u);
  });

  it('does not ask again, or suggest proposing, for a promise the model judged infeasible', async () => {
    const w = fakeWorld();
    const mem = memoryCache();
    const deps: RuleCommandDeps = { ...w.deps, infeasible: mem.cache };
    const first = ctx(['propose', '--all', '--accept', '--scripted', 'x']);
    await runRuleCommand(first.c, deps);
    expect(first.out.join('\n')).toContain('– privacy.03  no rule possible: Selling or sharing notes');
    expect(mem.state.ids).toEqual(['privacy.03']);

    const again = ctx(['propose', '--all', '--scripted', 'x']);
    expect(await runRuleCommand(again.c, deps)).toBe(0);
    expect(again.out).toEqual([
      'Not asked again: privacy.03 (the model found no rule last time; they stay on AI reads; name one to ask again)',
      'Next: jurator check',
    ]);
    const l = ctx(['list']);
    await runRuleCommand(l.c, deps);
    const text = l.out.join('\n');
    expect(text).toContain('On AI reads (the model found no rule): privacy.03');
    expect(text).not.toContain('rule propose');
    const lj = ctx(['list', '--json']);
    await runRuleCommand(lj.c, deps);
    expect(JSON.parse(lj.out.join('\n')).infeasible).toEqual(['privacy.03']);

    // Naming it asks again; a rule written later takes it off the list.
    const named = ctx(['propose', 'privacy.03', '--scripted', 'x']);
    await runRuleCommand(named.c, { ...deps, createModel: () => scriptedModel(SCRIPTED_ACME) });
    expect(named.out.join('\n')).toContain('Next: jurator check');
    expect(mem.state.ids).toEqual(['privacy.03']);
  });

  it('writes .jurator/local/infeasible.json (a JSON array of ids) and reads it back', async () => {
    const { mkdtemp, readFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = await mkdtemp(join(tmpdir(), 'kw-r2-'));
    const w = fakeWorld();
    const store = w.deps.openStore('/x');
    const { infeasible: _memory, ...fileDeps } = w.deps;
    const deps: RuleCommandDeps = { ...fileDeps, openStore: () => Object.assign(Object.create(store), store, { dir }) };
    await runRuleCommand(ctx(['propose', '--all', '--scripted', 'x']).c, deps);
    expect(JSON.parse(await readFile(join(dir, 'local', 'infeasible.json'), 'utf8'))).toEqual(['privacy.03']);
    const { readInfeasible } = await import('../../src/rules/index.js');
    expect(await readInfeasible(dir)).toEqual(['privacy.03']);
    expect(await readInfeasible(join(dir, 'nope'))).toEqual([]);
  });

  it('propose --redteam: Spark attacks, the judge confirms, the writer repairs, the program re-proves; the best rule is saved', async () => {
    const w = fakeWorld();
    const ids: string[] = [];
    const deps: RuleCommandDeps = {
      ...w.deps,
      createModel: (o) => {
        ids.push(`${o.config.model.id}/${o.env.MODEL_ID ?? ''}`);
        return scriptedModel(SCRIPTED_ACME);
      },
    };
    const { c, out } = ctx(['propose', 'security.01', '--accept', '--redteam', '--scripted', 'fixtures/scripted/acme']);
    expect(await runRuleCommand(c, deps)).toBe(0);
    // The proposer uses the config's model; the attacker and the judge each set MODEL_ID (env wins over config).
    expect(ids.slice(1)).toEqual(['muse-spark-1.3/muse-spark-1.3', 'muse-wonder-1.0/muse-wonder-1.0']);
    const text = out.join('\n');
    expect(text).toContain('Red team for 1 rule: scripted answers (no network)');
    expect(text).toContain('R-security.01-1 written and accepted (each-near, repaired after the red team)');
    expect(text).toContain('    red team on the first version: weak\n');
    expect(text).toContain('1. src/routes/export.ts: added');
    expect(text).toContain('2. src/routes/export.ts: `requireAdmin(req);` -> `try { requireAdmin(req); }');
    expect(text).toContain('rule passed; the judge says it breaks the promise');
    expect(text).toContain('    repair 1: proven (each-near)');
    expect(text).toContain('      red team on repair 1: held');
    expect(text).toContain('    evasion closed: R-security.01-1 now fails on 1 evasion it passed before');
    expect(text).toContain('Red team: 1 evasion confirmed on 1 rule, 1 closed by repair, 0 still open');
    // The repaired rule is the one saved (same id), and the evasion is kept as an extra mutant.
    expect(w.rules().map((r) => [r.id, r.status, r.pattern])).toEqual([['R-security.01-1', 'accepted', '^\\s*(?:await\\s+)?requireAdmin\\(\\s*\\w+\\s*\\);']]);
    expect(w.mutants().rules['R-security.01-1']?.evasions.map((e) => e.closed)).toEqual([true]);

    // rule test re-runs the stored evasion on main: caught.
    const t = ctx(['test']);
    expect(await runRuleCommand(t.c, deps)).toBe(0);
    expect(t.out.join('\n')).toContain('    evasion 1: src/routes/export.ts: `requireAdmin(req);` -> `try { requireAdmin(req); }');
    expect(t.out.join('\n')).toContain('Known red-team evasions: 1 of 1 caught');

    // A fresh store, so the new rule is R-security.01-1 again (the scripted attack is keyed by rule id).
    const j = ctx(['propose', 'security.01', '--redteam', '--scripted', 'fixtures/scripted/acme', '--json']);
    await runRuleCommand(j.c, { ...fakeWorld().deps, createModel: () => scriptedModel(SCRIPTED_ACME) });
    const res = JSON.parse(j.out.join('\n')).results[0];
    expect(res.redteam.verdict).toBe('weak');
    expect(res.redteam.attempts.map((a: { rule: string; judge: string }) => `${a.rule}/${a.judge}`)).toEqual(['caught/not-judged', 'missed/breaks']);
    expect(res.hardening).toMatchObject({ verdict: 'closed', repaired: true });
    expect(res.hardening.rounds.map((r: { outcome: string }) => r.outcome)).toEqual(['proven']);
  });

  it('propose --redteam: a repair the program refuses keeps the first rule and says how it is still evadable', async () => {
    const w = fakeWorld();
    const { c, out } = ctx(['propose', 'privacy.01', '--redteam', '--scripted', 'x']);
    expect(await runRuleCommand(c, w.deps)).toBe(0);
    const text = out.join('\n');
    expect(text).toContain('    repair 1: rejected by the program:');
    expect(text).toContain('    repair 2: the writer could not close it: Cannot close:');
    expect(text).toMatch(/ {4}still evadable: src\/agent\/chats\.ts: .*365 \* 24/u);
    expect(text).toContain('Still evadable: R-privacy.01-1.');
    expect(w.rules().map((r) => r.pattern)).toEqual(['CHAT_TTL_DAYS\\s*=\\s*(?:[0-9]|[12][0-9]|30)\\b']);
    // Kept as an open evasion: rule test lists it as still open and does not fail on it.
    await runRuleCommand(ctx(['accept', '--all']).c, w.deps);
    const t = ctx(['test']);
    expect(await runRuleCommand(t.c, w.deps)).toBe(0);
    expect(t.out.join('\n')).toContain('still open');
    expect(t.out.join('\n')).toContain('Known red-team evasions: 0 of 1 caught');
  });

  it('rule test exits 1 when a rule passes an evasion it was proven to catch (the rule was weakened)', async () => {
    const w = fakeWorld();
    await runRuleCommand(ctx(['propose', 'security.01', '--accept', '--redteam', '--scripted', 'x']).c, w.deps);
    // Hand-edit the rule back to the weak first version (same id): the stored evasion now passes.
    const store = w.deps.openStore('/x');
    await store.writeRules(w.rules().map((r) => ({ ...r, pattern: 'requireAdmin\\(' })));
    const t = ctx(['test']);
    expect(await runRuleCommand(t.c, w.deps)).toBe(1);
    const text = t.out.join('\n');
    expect(text).toContain('MISSED');
    expect(text).toContain('Next: R-security.01-1 passes an evasion it was proven to catch');
    const tj = ctx(['test', '--json']);
    expect(await runRuleCommand(tj.c, w.deps)).toBe(1);
    expect(JSON.parse(tj.out.join('\n')).mutants.map((m: { outcome: string }) => m.outcome)).toEqual(['missed']);
  });

  it('a bad --budget is bad input', async () => {
    const w = fakeWorld();
    await expect(runRuleCommand(ctx(['propose', 'security.01', '--redteam', '--budget', 'lots', '--scripted', 'x']).c, w.deps)).rejects.toThrow(
      /--budget must be an amount in USD/u,
    );
  });

  it('propose without --redteam makes no attack calls', async () => {
    const w = fakeWorld();
    let made = 0;
    const deps: RuleCommandDeps = { ...w.deps, createModel: () => ((made += 1), scriptedModel(SCRIPTED_ACME)) };
    const { c, out } = ctx(['propose', 'security.01', '--scripted', 'x']);
    await runRuleCommand(c, deps);
    expect(made).toBe(1);
    expect(out.join('\n')).not.toContain('red team');
  });
});
