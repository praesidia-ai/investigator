import { describe, expect, it } from 'vitest';
import { runCheck } from '../../src/check/index.js';
import { nextHint, renderRunMarkdown, renderRunText } from '../../src/render/index.js';
import { makeStyle } from '../../src/util/term.js';
import { FakeModel, FakeRepo, FakeStore, fakeRunRule, fixedNow, promise, rule } from './fakes.js';

async function demoRun() {
  const repo = new FakeRepo(undefined, ['src/routes/export.ts']);
  const store = new FakeStore(
    [
      promise('security.01', {
        scope: ['src/routes/**'],
        wording: 'Only workspace admins can export customer data.',
        quote: { alias: 'security', policySha256: '0'.repeat(64), text: 'Only workspace admins can export customer data.', line: 3 },
      }),
      promise('privacy.02', { scope: ['src/export/**', 'src/routes/export.ts'] }),
      promise('privacy.04', { checkable: 'process', wording: 'Tell users within 72 hours of a breach.' }),
    ],
    [rule('R-security.01', 'security.01', ['src/routes/**'])],
  );
  const model = new FakeModel({
    'ai-read:privacy.02': { verdict: 'kept', explanation: 'Filters deleted and archived.', citations: [{ path: 'src/export/query.ts', startLine: 2, endLine: 2 }] },
  }, 0);
  const rr = fakeRunRule({ 'R-security.01': { outcome: 'fail', hits: [['src/routes/export.ts', 9]] } });
  return runCheck({ repo, store, model, target: { kind: 'diff', base: 'main', head: 'HEAD' }, aiRead: true, now: fixedNow }, { runRule: rr.fn });
}

describe('renderers', () => {
  it('terminal text matches the agreed layout (no colour)', async () => {
    const run = await demoRun();
    const text = renderRunText(run, makeStyle(false), { runPath: '.jurator/local/runs/x/run.json', sources: { security: 'docs/security.md' } });
    expect(text.split('\n')).toEqual([
      'jurator · acme-notes · feature/csv-export @ bbbbbbb vs main',
      '  3 of 3 promises touched · $0.00 · mode: block',
      '',
      `┏━ ✗ BROKEN · security.01 · proved by a rule, no AI ${'━'.repeat(28)}`,
      '┃ Policy   "Only workspace admins can export customer data."  docs/security.md:3',
      '┃ Code     src/routes/export.ts:9',
      "┃          router.get('/export.csv', async (req, res) => {",
      '┃ Rule     R-security.01: fail',
      `┗${'━'.repeat(79)}`,
      '',
      '~ privacy.02  LOOKS KEPT (read by AI)  src/export/query.ts:2',
      '☐ privacy.04  Before merge: Tell users within 72 hours of a breach.',
      '',
      'Covered by rules: 1 of 2 code promises',
      'Failed: 1 broken.',
      'Re-check this record with no AI: jurator verify .jurator/local/runs/x/run.json',
      'Next: fix the code (src/routes/export.ts:9), or change the policy and run jurator compile.',
    ]);
  });

  it('keeps one header line when it fits, and every line within the width', async () => {
    const run = await demoRun();
    const text = renderRunText(run, makeStyle(false), { width: 120, sources: { security: 'docs/security.md' } });
    expect(text.split('\n')[0]).toBe('jurator · acme-notes · feature/csv-export @ bbbbbbb vs main · 3 of 3 promises touched · $0.00 · mode: block');
    const narrow = renderRunText(run, makeStyle(false), { width: 50 });
    for (const line of narrow.split('\n').filter((l) => !/^(jurator ·|Re-check|Next:)/u.test(l))) {
      expect(line.length).toBeLessThanOrEqual(50);
    }
  });

  it('shortens a full base sha in the header and cuts long AI reasons at the width', async () => {
    const run = await demoRun();
    const long = {
      ...run,
      target: { ...run.target, base: 'c'.repeat(40) },
      results: run.results.map((r) =>
        r.promiseId === 'privacy.02' ? { ...r, verdict: 'cant-tell' as const, explanation: 'word '.repeat(60) } : r,
      ),
    };
    const lines = renderRunText(long, makeStyle(false), { width: 80 }).split('\n');
    expect(lines[0]).toBe('jurator · acme-notes · feature/csv-export @ bbbbbbb vs ccccccc');
    const reason = lines.find((l) => l.trim().startsWith('word'));
    expect(reason?.length).toBe(80);
    expect(reason?.endsWith('…')).toBe(true);
  });

  it('Next: fix the code or change the policy after a broken rule; no propose hint for infeasible promises', async () => {
    const run = await demoRun();
    expect(nextHint(run)).toBe('Next: fix the code (src/routes/export.ts:9), or change the policy and run jurator compile.');
    const passing = { ...run, results: run.results.filter((r) => r.verdict !== 'broken'), summary: { ...run.summary, broken: 0 } };
    const notChecked = {
      ...passing,
      results: [...passing.results, { ...passing.results[0]!, promiseId: 'praesidia.01', verdict: 'not-checked' as const, level: 'quick' as const, citations: [] }],
    };
    expect(nextHint(notChecked)).toBe('Next: jurator rule propose praesidia.01 (a rule checks it with no AI on every run)');
    expect(nextHint(notChecked, { infeasible: ['praesidia.01', 'privacy.02'] })).toBe(
      'Next: tick the "Before merge" items in the PR (privacy.04); nothing here blocks it.',
    );
    expect(nextHint({ ...notChecked, target: { kind: 'repo', head: notChecked.target.head } }, { infeasible: ['praesidia.01', 'privacy.02'] })).toBe(
      'Next: check each change with jurator check --diff main (or jurator hook install pre-push).',
    );
    expect(nextHint({ ...notChecked, checklist: [] }, { infeasible: ['praesidia.01', 'privacy.02'] })).toBe(
      'Next: push or open the PR; nothing here blocks it.',
    );
  });

  it('a broken must-match shows the new line and what it was on the base', async () => {
    const run = await demoRun();
    const head = run.target.head;
    const changed = {
      ...run,
      results: run.results.map((r) =>
        r.verdict === 'broken'
          ? {
              ...r,
              citations: [
                { path: 'src/agent/chats.ts', commit: head, startLine: 2, endLine: 2, quote: 'export const CHAT_TTL_DAYS = 90;' },
                { path: 'src/agent/chats.ts', commit: 'a'.repeat(40), startLine: 2, endLine: 2, quote: 'export const CHAT_TTL_DAYS = 30;' },
              ],
            }
          : r,
      ),
    };
    const text = renderRunText(changed, makeStyle(false));
    expect(text).toContain('┃ Code     src/agent/chats.ts:2\n┃          export const CHAT_TTL_DAYS = 90;\n┃ Was      export const CHAT_TTL_DAYS = 30;  (line 2 on main)');
  });

  it('colours only when asked', async () => {
    const run = await demoRun();
    expect(renderRunText(run, makeStyle(false))).not.toContain('\u001b[');
    expect(renderRunText(run, makeStyle(true))).toContain('\u001b[31m');
  });

  it('markdown for PR comments has a title, a table, evidence and the checklist', async () => {
    const md = renderRunMarkdown(await demoRun(), { runPath: 'run.json' });
    expect(md).toMatch(/^### ✗ Jurator: 1 promise broken/u);
    expect(md).toContain('| ✗ | **security.01** Only workspace admins can export customer data. | BROKEN (rule, no AI) | `src/routes/export.ts:9` |');
    expect(md).toContain('| ~ | **privacy.02**');
    expect(md).toContain("```text\nrouter.get('/export.csv', async (req, res) => {\n```");
    expect(md).toContain('- [ ] **privacy.04** Tell users within 72 hours of a breach.');
    expect(md).toContain('jurator verify run.json');
  });
});
