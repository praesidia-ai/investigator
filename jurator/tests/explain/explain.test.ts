// HZ-1: plain summaries of findings (AI from the program's evidence, or a template), short ids, plain words, the
// finding box layout, the per-repo header, and `jurator explain`.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runExplainCommand, type ExplainDeps } from '../../src/cli/commands/explain.js';
import type { CommandContext } from '../../src/cli/context.js';
import type { Config, ModelClient, ModelJsonRequest, ModelJsonResult } from '../../src/contracts.js';
import {
  SUMMARY_MODEL,
  explainTask,
  fileSummaryCache,
  findingRows,
  fromBrokenNow,
  memorySummaryCache,
  plainFix,
  plainReason,
  repoFacts,
  ruleLine,
  shortIds,
  summarize,
  summaryInput,
  summaryLabel,
  summaryModel,
  templateSummary,
  type Finding,
} from '../../src/explain/index.js';
import { createUi, stripAnsi } from '../../src/ui/index.js';
import { makeStyle } from '../../src/util/term.js';
import { FakeRepo, FakeStore, HEAD, fixedNow, promise, rule } from '../check/fakes.js';

const brokenNow: Finding = fromBrokenNow(
  promise('document-handling.09', { wording: 'Clipboard documents stay in memory only.', quote: { alias: 'document-handling', policySha256: '0'.repeat(64), text: 'Clipboard documents are kept in memory only.', line: 12 } }),
  { description: 'must-not-match: No line may combine a cache write with clipboard document content.' },
  {
    message: 'R-document-handling.09-1 matched 3 lines',
    evidence: [
      { path: 'api/src/cache.py', line: 120, quote: 'await self.cache_service.store_result(fp, clipboard_text)', actual: 'a line the promise forbids' },
      { path: 'api/src/cache.py', line: 140, quote: 'logger.info(f"cached clipboard {fp}")', actual: 'a line the promise forbids' },
      { path: 'api/src/notes.py', line: 9, quote: '"""Caches the clipboard text."""', actual: 'a line the promise forbids' },
      { path: 'api/src/notes.py', line: 30, quote: 'cache.set(k, clipboard)', actual: 'a line the promise forbids' },
    ],
    fix: '4 forbidden lines removed (api/src/cache.py:120, api/src/cache.py:140, ...)',
  },
);

function answering(answers: Record<string, unknown>, usd = 0.003): ModelClient & { calls: string[] } {
  const calls: string[] = [];
  return {
    id: SUMMARY_MODEL,
    mode: 'live',
    calls,
    async json<T>(request: ModelJsonRequest<T>): Promise<ModelJsonResult<T>> {
      calls.push(request.task);
      const a = answers[request.task];
      if (a instanceof Error) throw a;
      if (a === undefined) throw Object.assign(new Error('missing'), { code: 'SCRIPTED_ANSWER_MISSING' });
      return { value: request.schema.parse(a), usage: { id: SUMMARY_MODEL, mode: 'live', inputTokens: 10, outputTokens: 10, usd } };
    },
  };
}

describe('short ids (backlog 14)', () => {
  it('a long source alias is shown short; short aliases stay; both spellings resolve to the full id', () => {
    const ids = shortIds(['document-handling.09', 'document-handling.16', 'privacy.01', 'praesidia.02']);
    expect(ids.short('document-handling.09')).toBe('doc.09');
    expect(ids.short('privacy.01')).toBe('privacy.01');
    expect(ids.full('doc.16')).toBe('document-handling.16');
    expect(ids.full('document-handling.16')).toBe('document-handling.16');
    expect(ids.full('doc.99')).toBeUndefined();
  });
  it('two long aliases never share a short one', () => {
    const ids = shortIds(['document-handling.01', 'documentation-rules.01', 'doc.01']);
    const shown = ['document-handling.01', 'documentation-rules.01', 'doc.01'].map((id) => ids.short(id));
    expect(new Set(shown).size).toBe(3);
    expect(shown[2]).toBe('doc.01');
    for (const id of ['document-handling.01', 'documentation-rules.01']) expect(ids.full(ids.short(id))).toBe(id);
  });
});

describe('plain words', () => {
  it('what a rule checks, without the mode jargon', () => {
    expect(ruleLine({ mode: 'must-not-match', description: 'must-not-match: no log call passes a password' })).toBe('No log call passes a password.');
  });
  it('why there is no rule, with the command that tries again (short id)', () => {
    const cut = plainReason('the model call failed: The model\'s answer for "rule-propose:document-handling.16" was cut off at its output limit (4096 tokens); nothing was saved.', { id: 'doc.16' });
    expect(cut).toEqual({ text: "The model's answer was cut off before it finished.", retry: 'jurator rule propose doc.16' });
    expect(plainReason('not asked: the run budget was reached', { id: 'doc.2', budgetStopped: true }).retry).toBe('jurator rule propose doc.2 --budget <usd>');
    const no = plainReason('Selling notes is a business decision.', { id: 'privacy.03', infeasible: true });
    expect(no.text).toBe('No rule can check this in code: selling notes is a business decision.');
    expect(no.retry).toBeUndefined();
  });
  it('To fix from the program\'s fix, not the proof\'s mutation', () => {
    expect(plainFix('3 forbidden lines removed (a.ts:1, b.ts:2, c.ts:3)')).toBe('Change or remove the 3 lines found above so they no longer do what the promise forbids.');
    expect(plainFix("`requireAdmin(req)` added after 2 unguarded lines")).toBe('Add the missing check (like `requireAdmin(req)`) next to each of the 2 lines found above.');
    expect(plainFix('the value set to the limit (at most 30 days) at src/agent/chats.ts:2')).toBe('Set the value at src/agent/chats.ts:2 to at most 30 days.');
  });
});

describe('summaries', () => {
  it('the prompt input is the program\'s evidence, labelled and fenced as data', () => {
    const input = summaryInput(brokenNow);
    expect(input).toContain('Finding: BROKEN NOW');
    expect(input).toContain('Policy sentence: "Clipboard documents are kept in memory only."');
    expect(input).toMatch(/<<<CODE\napi\/src\/cache\.py:120: await self\.cache_service/u);
    expect(input).toContain('CODE>>>');
    expect(input).not.toContain('a line the promise forbids');
  });

  it('the template (no AI) names the place, and To fix says what to change', () => {
    const t = templateSummary(brokenNow, 'doc.09', '--no-ai');
    expect(t.by).toBe('program');
    expect(t.summary).toBe('Today\'s code breaks the promise "Clipboard documents stay in memory only" at api/src/cache.py:120 and 3 more places.');
    expect(t.toFix).toBe('Change or remove the 4 lines found above so they no longer do what the promise forbids.');
    expect(summaryLabel(t)).toBe('summary by the program (--no-ai)');
  });

  it('written by AI once, then read from the cache (same content, no second call)', async () => {
    const m = answering({ [explainTask('document-handling.09', 'broken-now')]: { summary: 'Clipboard text is written to the result cache in api/src/cache.py, so a copied document outlives the request.', toFix: 'Keep the clipboard text in memory and drop the store_result call.', note: 'Line 140 is a log message, not a write.' } });
    const cache = memorySummaryCache();
    const a = await summarize(brokenNow, { model: m, cache });
    expect(a).toMatchObject({ by: 'ai', model: SUMMARY_MODEL, cached: false, note: 'Line 140 is a log message, not a write.' });
    expect(a.usd).toBeCloseTo(0.003);
    const b = await summarize(brokenNow, { model: m, cache });
    expect(b).toMatchObject({ by: 'ai', cached: true, usd: 0, summary: a.summary });
    expect(m.calls).toHaveLength(1);
    expect(summaryLabel(b)).toBe(`summary by AI (${SUMMARY_MODEL}, cached)`);
  });

  it('the file cache lives in .jurator/local/explain/', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hz1-'));
    try {
      const cache = fileSummaryCache(dir);
      await cache.write('k1', { summary: 's', toFix: 't', note: null, promiseId: 'p.01', model: 'm' });
      expect(await cache.read('k1')).toEqual({ summary: 's', toFix: 't', note: null });
      expect(await cache.read('nope')).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('never overrules the program: a "kept" summary of a broken finding is replaced by the template sentence', async () => {
    const m = answering({ [explainTask('document-handling.09', 'broken-now')]: { summary: 'This is a false positive; the promise is kept.', toFix: 'No change needed.', note: null } });
    const s = await summarize(brokenNow, { model: m, cache: memorySummaryCache() });
    expect(s.summary).toBe(templateSummary(brokenNow).summary);
    expect(s.toFix).toBe(templateSummary(brokenNow).toFix);
    // Words that describe the breach are not an overrule ("are kept for 90 days", "the cache holds").
    const ok = answering({ [explainTask('document-handling.09', 'broken-now')]: { summary: 'Copied documents are kept in the cache, which holds them for a day.', toFix: 'Drop the cache write.', note: null } });
    expect((await summarize(brokenNow, { model: ok, cache: memorySummaryCache() })).summary).toBe('Copied documents are kept in the cache, which holds them for a day.');
  });

  it('a failed call, a missing answer or the budget gives the template, with the reason', async () => {
    const budget = answering({ [explainTask('document-handling.09', 'broken-now')]: Object.assign(new Error('budget'), { code: 'MODEL_BUDGET_EXCEEDED' }) });
    expect(await summarize(brokenNow, { model: budget, cache: memorySummaryCache() })).toMatchObject({ by: 'program', fallback: 'the summary budget is used up' });
    expect(await summarize(brokenNow, { model: answering({}), cache: memorySummaryCache() })).toMatchObject({ by: 'program', fallback: 'no recorded answer' });
    expect(await summarize(brokenNow, { model: null, cache: memorySummaryCache(), offReason: 'no model key' })).toMatchObject({ by: 'program', fallback: 'no model key' });
  });

  it('the summary model: Muse Spark within the budget left; none with --no-ai, no key or no budget', () => {
    const config = { budgetUsdPerRun: 10, model: { id: 'muse-wonder-1.0' } } as Config;
    const made: Array<{ id: string; budget: number; env: string | undefined }> = [];
    const create = (o: { config: Config; env: NodeJS.ProcessEnv }): ModelClient => {
      made.push({ id: o.config.model.id, budget: o.config.budgetUsdPerRun, env: o.env.MODEL_ID });
      return answering({});
    };
    expect(summaryModel({ config, env: { META_API_KEY: 'x' }, argv: ['--no-ai'], create })).toEqual({ model: null, offReason: '--no-ai' });
    expect(summaryModel({ config, env: {}, argv: [], create })).toEqual({ model: null, offReason: 'no model key' });
    expect(summaryModel({ config, env: { META_API_KEY: 'x' }, argv: [], budgetLeftUsd: 0.004, create })).toEqual({ model: null, offReason: 'the run budget is used up' });
    expect(summaryModel({ config, env: { META_API_KEY: 'x' }, argv: [], budgetLeftUsd: 0.2, create }).model).not.toBeNull();
    expect(summaryModel({ config, env: { META_API_KEY: 'x' }, argv: [], create }).model).not.toBeNull();
    expect(made).toEqual([
      { id: SUMMARY_MODEL, budget: 0.2, env: SUMMARY_MODEL },
      { id: SUMMARY_MODEL, budget: 0.5, env: SUMMARY_MODEL },
    ]);
  });
});

describe('the finding box (backlog 15)', () => {
  const ui = createUi({ env: {}, caps: { color: 'none', width: 100, unicode: true } });
  it('summary first, then Found with path:line before each code line, To fix, the policy sentence once', () => {
    const summary = templateSummary(brokenNow, 'doc.09');
    const lines = ui.finding({ kind: 'broken-now', id: 'doc.09', title: "today's code breaks it", rows: findingRows({ finding: brokenNow, summary, id: 'doc.09', policyWhere: 'policies/document-handling.md:12' }) });
    const text = lines.join('\n');
    expect(lines.every((l) => l.length <= 96)).toBe(true);
    const at = (s: string): number => lines.findIndex((l) => l.includes(s));
    expect(at("Today's code breaks")).toBe(1);
    expect(at('summary by the program')).toBe(at("Today's code breaks") + 2);
    expect(at('Found   api/src/cache.py:120')).toBeGreaterThan(at('summary by the program'));
    expect(at('120 │ await self.cache_service')).toBe(at('Found   api/src/cache.py:120') + 1);
    expect(at('+1 more: jurator explain doc.09')).toBeGreaterThan(0);
    expect(at('To fix')).toBeGreaterThan(at('+1 more'));
    expect(at('Policy  "Clipboard documents are kept in memory only."')).toBeGreaterThan(at('To fix'));
    expect(text).not.toContain('Actual');
    expect(text).not.toContain('Promise ');
    expect(text.match(/Clipboard documents are kept in memory only/gu)).toHaveLength(1);
  });
  it('--verbose: every line found and the details', () => {
    const summary = templateSummary(brokenNow, 'doc.09');
    const rows = findingRows({ finding: brokenNow, summary, id: 'doc.09', verbose: true, details: [{ label: 'Pattern', text: 'cache.*clipboard' }] });
    const text = ui.finding({ kind: 'broken-now', id: 'doc.09', rows }).join('\n');
    expect(text).toContain('api/src/notes.py:30');
    expect(text).toContain('Pattern');
    expect(text).not.toContain('more: jurator explain');
  });
  it('an AI note is shown as a doubt; the badge stays', () => {
    const summary = { summary: 'Clipboard text goes to the cache.', toFix: 'Drop the cache write.', note: 'Line 140 is a log message, not a write.', by: 'ai' as const, model: SUMMARY_MODEL, usd: 0 };
    const text = ui.finding({ kind: 'broken-now', id: 'doc.09', rows: findingRows({ finding: brokenNow, summary, id: 'doc.09' }) }).join('\n');
    expect(text).toContain('BROKEN NOW');
    expect(text).toMatch(/AI note\s+Line 140 is a log message, not a write\./u);
    expect(text).toContain(`summary by AI (${SUMMARY_MODEL})`);
  });
});

describe('workspace header (backlog 17)', () => {
  it("each repo's branch @ commit, not the composite commit", () => {
    const snap = {
      repo: '/w/investigator',
      branch: null,
      commit: 'c'.repeat(40),
      dirty: false,
      repos: [
        { name: 'chrome-extension', branch: 'main', commit: '1'.repeat(40), dirty: false },
        { name: 'backend-api', branch: 'dev', commit: '2'.repeat(40), dirty: true },
      ],
    };
    expect(repoFacts(snap, 'c'.repeat(40))).toEqual([
      ['chrome-extension', 'main @ 1111111'],
      ['backend-api', 'dev @ 2222222 (uncommitted changes not read)'],
    ]);
    expect(repoFacts({ repo: '/r', branch: 'main', commit: 'a'.repeat(40), dirty: false })).toEqual([['', 'main @ aaaaaaa']]);
    expect(repoFacts({ repo: '/r', branch: 'main', commit: 'a'.repeat(40), dirty: false }, 'b'.repeat(40))).toEqual([['commit', 'bbbbbbb']]);
  });
});

describe('ui: tables that fold and carry a note line', () => {
  it('the last column folds; the note goes under it, muted', () => {
    const ui = createUi({ env: {}, caps: { color: 'none', width: 60, unicode: true } });
    const lines = ui.table({
      columns: [{ header: 'Promise' }, { header: 'Says', flex: true, min: 10 }],
      rows: [['doc.09', 'Clipboard documents stay in memory only and are never cached anywhere at all.']],
      wrap: 2,
      notes: ['Rule: no cache write with clipboard text.'],
    });
    expect(lines.every((l) => l.length <= 60)).toBe(true);
    expect(lines[2]).toMatch(/^ {2}doc\.09 {3}Clipboard/u);
    expect(lines[3]).toMatch(/^ {11}\S/u);
    expect(lines[4]).toBe('           Rule: no cache write with clipboard text.');
  });
});

describe('jurator explain', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  function setup() {
    const dir = mkdtempSync(join(tmpdir(), 'hz1-explain-'));
    dirs.push(dir);
    const store = new FakeStore(
      [
        promise('security-and-access.01', {
          wording: 'Only workspace admins can export customer data.',
          scope: ['src/routes/**'],
          quote: { alias: 'security-and-access', policySha256: '0'.repeat(64), text: 'Only workspace admins can export customer data.', line: 3 },
        }),
      ],
      [rule('R-security-and-access.01-1', 'security-and-access.01', ['src/routes/**'], { description: 'Every export route calls requireAdmin( within 3 lines.' })],
    );
    Object.defineProperty(store, 'dir', { value: join(dir, '.jurator') });
    const deps: ExplainDeps = {
      findRepoRoot: async () => dir,
      openStore: () => store,
      openRepo: async () => new FakeRepo(),
      createModel: () => answering({}),
      listRuns: async () => [],
      readBindings: async () => [],
      readInfeasible: async () => [],
    };
    return { deps };
  }
  function ctx(argv: string[]) {
    const out: string[] = [];
    const c: CommandContext = { cwd: '/x', argv, env: {}, out: (l) => out.push(l), err: (l) => out.push(l), style: makeStyle(false), now: fixedNow };
    return { c, out };
  }

  it('takes the short id, runs the rule now (no AI), and prints the box, the rule details and the next step', async () => {
    const { deps } = setup();
    const { c, out } = ctx(['sec.01']);
    expect(await runExplainCommand(c, deps)).toBe(0);
    const text = stripAnsi(out.join('\n'));
    expect(text).toContain('explain sec.01');
    expect(text).toContain('security-and-access.01 · accepted');
    expect(text).toContain('✗ BROKEN ━ sec.01');
    expect(text).toMatch(/Found\s+src\/routes\/export\.ts:9/u);
    expect(text).toMatch(/Pattern\s+\/requireAdmin\\\(\//u);
    expect(text).toMatch(/Now\s+✗ FAILS at bbbbbbb \(no AI\)/u);
    expect(text).toContain('summary by the program (no model key)');
    expect(text).toContain('Next: fix the code at src/routes/export.ts:9');
  });

  it('--json keeps the full id and carries the summary', async () => {
    const { deps } = setup();
    const { c, out } = ctx(['security-and-access.01', '--json']);
    expect(await runExplainCommand(c, deps)).toBe(0);
    const j = JSON.parse(out.join('\n'));
    expect(j.promise.id).toBe('security-and-access.01');
    expect(j.shortId).toBe('sec.01');
    expect(j.commit).toBe(HEAD);
    expect(j.rules[0].now.outcome).toBe('fail');
    expect(j.summary.by).toBe('program');
  });

  it('an unknown id is a plain error', async () => {
    const { deps } = setup();
    await expect(runExplainCommand(ctx(['nope.01']).c, deps)).rejects.toThrow('there is no promise nope.01');
  });
});
