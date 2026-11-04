// WP-C: the incremental header line, "(reused from <run>)" notes and triggers in the renderers.
import { describe, expect, it } from 'vitest';
import type { CheckRun } from '../../src/contracts.js';
import { incrementalLine, renderRunMarkdown, renderRunText } from '../../src/render/index.js';
import { makeStyle } from '../../src/util/term.js';
import { runCheck } from '../../src/check/index.js';
import { FakeRepo, FakeStore, fakeRunRule, fixedNow, promise, rule } from './fakes.js';

const PS_OLD = '1'.repeat(64);
const PS = 'a'.repeat(64);

async function baseRun(): Promise<CheckRun> {
  const store = new FakeStore(
    [promise('security.01', { scope: ['src/routes/**'] }), promise('privacy.01', { scope: ['src/agent/**'] })],
    [rule('R-security.01', 'security.01', ['src/routes/**']), rule('R-privacy.01', 'privacy.01', ['src/agent/**'])],
  );
  const rr = fakeRunRule({
    'R-security.01': { outcome: 'pass', hits: [['src/routes/export.ts', 5]] },
    'R-privacy.01': { outcome: 'pass', hits: [['src/agent/chats.ts', 1]] },
  });
  return runCheck({ repo: new FakeRepo(), store, model: null, target: { kind: 'repo', head: 'HEAD' }, aiRead: false, now: fixedNow }, { runRule: rr.fn });
}

function withReuse(run: CheckRun, over: Partial<CheckRun>): CheckRun {
  return {
    ...run,
    policyState: PS,
    results: run.results.map((r) => (r.promiseId === 'privacy.01' ? { ...r, reused: { fromRun: '20261104T030000Z-1111111', fromCommit: '1'.repeat(40) } } : r)),
    incremental: { rechecked: 1, reused: 1, skippedUnchanged: false },
    ...over,
  };
}

describe('incremental rendering', () => {
  it('says nothing on a first run', async () => {
    const run = await baseRun();
    expect(run.incremental).toEqual({ rechecked: 2, reused: 0, skippedUnchanged: false });
    expect(incrementalLine(run)).toBeNull();
    expect(renderRunText(run, makeStyle(false))).not.toContain('rechecked');
  });

  it('names the policy state, the code range and the counts', async () => {
    const run = withReuse(await baseRun(), {});
    const since = { commit: '1'.repeat(40), policyState: PS, runId: '20261104T030000Z-1111111' };
    expect(incrementalLine(run, { since })).toBe('Policies aaaaaaa unchanged · code 1111111..bbbbbbb: rechecked 1 of 2 promises, reused 1');
    expect(incrementalLine(run, { since: { ...since, policyState: PS_OLD } })).toBe(
      'Policies changed (1111111 -> aaaaaaa) · code 1111111..bbbbbbb: rechecked 1 of 2 promises, reused 1',
    );
    const diff = { ...run, target: { kind: 'diff' as const, base: 'main', head: run.target.head, changedFiles: [] } };
    expect(incrementalLine(diff, { since })).toBe('Policies aaaaaaa unchanged · code main..bbbbbbb: rechecked 1 of 2 promises, reused 1');
  });

  it('the fast path prints one line and no per-result notes', async () => {
    const run = withReuse(await baseRun(), { incremental: { rechecked: 0, reused: 2, skippedUnchanged: true } });
    const text = renderRunText(run, makeStyle(false), { since: { commit: '1'.repeat(40), policyState: PS, runId: 'run-7' } });
    expect(text).toContain('Nothing to recheck: code and policies unchanged since run run-7.');
    expect(text).not.toContain('(reused from');
  });

  it('marks reused results and shows triggers under touched promises (text and Markdown)', async () => {
    const base = await baseRun();
    const run = withReuse(base, {
      results: base.results.map((r) =>
        r.promiseId === 'privacy.01'
          ? { ...r, reused: { fromRun: '20261104T030000Z-1111111', fromCommit: '1'.repeat(40) }, trigger: 'touched CHAT_TTL_DAYS = 30 (bound to privacy.01)' }
          : r,
      ),
    });
    const text = renderRunText(run, makeStyle(false), { width: 100 });
    const lines = text.split('\n');
    const row = lines.findIndex((l) => l.startsWith('✓ privacy.01'));
    expect(lines[row]).toContain('(reused from 20261104T030000Z-1111111)');
    expect(lines[row + 1]?.trim()).toBe('touched CHAT_TTL_DAYS = 30 (bound to privacy.01)');
    expect(lines.find((l) => l.startsWith('✓ security.01'))).not.toContain('reused');
    const md = renderRunMarkdown(run);
    expect(md).toContain('HOLDS (rule, no AI) (reused from 20261104T030000Z-1111111) · touched CHAT_TTL_DAYS = 30 (bound to privacy.01)');
    expect(md).toContain('rechecked 1 of 2 promises, reused 1');
  });

  it('a narrow terminal marks the row "(reused)" and names the run once under the list', async () => {
    const run = withReuse(await baseRun(), {});
    const lines = renderRunText(run, makeStyle(false), { width: 60 }).split('\n');
    const row = lines.findIndex((l) => l.startsWith('✓ privacy.01'));
    expect(lines[row]).not.toContain('reused from'); // no room on a 60-column row
    expect(lines.join(' ').replace(/\s+/gu, ' ')).toContain('Reused from run 20261104T030000Z-1111111 (same code and rules, not checked again): privacy.01');
    expect(lines.filter((l) => l.length > 60 && !l.startsWith('Next:'))).toEqual([]); // the Next hint is never cut
  });

  it('a broken block shows the trigger and the reused note', async () => {
    const base = await baseRun();
    const run: CheckRun = {
      ...withReuse(base, {}),
      results: base.results.map((r) =>
        r.promiseId === 'privacy.01'
          ? {
              ...r,
              verdict: 'broken',
              trigger: 'touched CHAT_TTL_DAYS (bound to privacy.01)',
              reused: { fromRun: 'run-3', fromCommit: '1'.repeat(40) },
            }
          : r,
      ),
    };
    const text = renderRunText(run, makeStyle(false));
    expect(text).toContain('┃ Why      touched CHAT_TTL_DAYS (bound to privacy.01)');
    expect(text).toContain('┃          (reused from run-3)');
  });
});

describe('incremental rendering: width', () => {
  it('a long incremental line breaks after the code range instead of being cut', async () => {
    const store = new FakeStore([promise('security.01', { scope: ['src/routes/**'] })], [rule('R-security.01', 'security.01', ['src/routes/**'])]);
    const rr = fakeRunRule({ 'R-security.01': { outcome: 'pass', hits: [['src/routes/export.ts', 5]] } });
    const base = await runCheck({ repo: new FakeRepo(), store, model: null, target: { kind: 'repo', head: 'HEAD' }, aiRead: false, now: fixedNow }, { runRule: rr.fn });
    const run: CheckRun = {
      ...base,
      target: { kind: 'diff', base: 'feature/very-long-branch-name', head: base.target.head, changedFiles: [] },
      incremental: { rechecked: 2, reused: 9, skippedUnchanged: false },
    };
    const lines = renderRunText(run, makeStyle(false), { since: { commit: '1'.repeat(40), policyState: PS, runId: 'r' } }).split('\n');
    expect(lines).toContain('  rechecked 2 of 11 promises, reused 9');
    const fast = renderRunText({ ...run, incremental: { rechecked: 0, reused: 1, skippedUnchanged: true } }, makeStyle(false), {
      since: { commit: '1'.repeat(40), policyState: PS, runId: '20261104T042447Z-6394cfe' },
      width: 60,
    }).split('\n');
    expect(fast).toContain('Nothing to recheck: code and policies unchanged');
    expect(fast).toContain('  since run 20261104T042447Z-6394cfe.');
  });
});
