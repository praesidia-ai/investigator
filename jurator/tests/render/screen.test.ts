// R4-UI2: when commands draw the new look, the model wrapper that feeds the live view, and the new check screen.
import { describe, expect, it } from 'vitest';
import { runCheck } from '../../src/check/index.js';
import type { CommandContext } from '../../src/cli/context.js';
import type { ModelClient } from '../../src/contracts.js';
import { renderRunScreen, runWorkspace } from '../../src/render/check-screen.js';
import { dressed, fancy, liveFor, trackModel, workspaceLabel } from '../../src/render/screen.js';
import { createUi } from '../../src/ui/index.js';
import { makeStyle } from '../../src/util/term.js';
import { FakeModel, FakeRepo, FakeStore, fakeRunRule, fixedNow, promise, rule } from '../check/fakes.js';

function ctx(argv: string[], env: NodeJS.ProcessEnv = {}, color = false) {
  const out: string[] = [];
  const err: string[] = [];
  const c: CommandContext = { cwd: '/x', argv, env, out: (l) => out.push(l), err: (l) => err.push(l), style: makeStyle(color), now: fixedNow };
  return { c, out, err };
}

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

describe('fancy(): when a screen is drawn in the new look', () => {
  it('colour or JURATOR_UI=1 turns it on; --json, --md and JURATOR_CLASSIC=1 keep the old output', () => {
    expect(fancy(ctx([]).c)).toBe(false);
    expect(fancy(ctx([], {}, true).c)).toBe(true);
    expect(fancy(ctx([], { JURATOR_UI: '1' }).c)).toBe(true);
    expect(fancy(ctx(['--json'], { JURATOR_UI: '1' }, true).c)).toBe(false);
    expect(fancy(ctx(['--md'], {}, true).c)).toBe(false);
    expect(fancy(ctx([], { JURATOR_CLASSIC: '1' }, true).c)).toBe(false);
  });

  it('the live view is quiet in tests and pipes, and prints one line per event with JURATOR_PROGRESS=1', () => {
    const quiet = ctx([]);
    const a = liveFor(quiet.c, { title: 'rule propose', unit: 'rules' });
    a.add('p.1');
    a.start('p.1', 'writing');
    a.done('p.1', 'rule written');
    a.finish();
    expect(quiet.err).toEqual([]);
    const loud = ctx([], { JURATOR_PROGRESS: '1', NO_COLOR: '1' });
    const b = liveFor(loud.c, { title: 'rule propose', unit: 'rules' });
    b.add('p.1');
    b.start('p.1', 'writing');
    b.done('p.1', 'rule written');
    b.finish();
    expect(loud.err.join('\n')).toContain('p.1  writing');
    expect(loud.err.join('\n')).toContain('p.1  rule written');
    expect(loud.err.join('\n')).not.toContain('\u001b');
  });
});

describe('trackModel(): the same client, reporting each call', () => {
  it('reports start, end and cost by task key, keeps id and mode, and reports a failed call', async () => {
    const events: string[] = [];
    const inner: ModelClient = {
      id: 'muse-wonder-1.0',
      mode: 'live',
      json: async (req) => {
        if (req.task === 'boom') throw Object.assign(new Error('cut off'), { usage: { usd: 0.01 } });
        return { value: { ok: true } as never, usage: { id: 'm', inputTokens: 1, outputTokens: 1, usd: 0.25, latencyMs: 1 } as never };
      },
    };
    const m = trackModel(inner, { onStart: (t) => events.push(`start ${t}`), onEnd: (t, usd, ok) => events.push(`end ${t} ${usd} ${ok}`) });
    expect(m.id).toBe('muse-wonder-1.0');
    expect(m.mode).toBe('live');
    await m.json({ task: 'rule-propose:privacy.01' } as never);
    await expect(m.json({ task: 'boom' } as never)).rejects.toThrow('cut off');
    expect(events).toEqual(['start rule-propose:privacy.01', 'end rule-propose:privacy.01 0.25 true', 'start boom', 'end boom 0.01 false']);
    expect(trackModel(null, {})).toBeNull();
  });
});

describe('headers and Next', () => {
  it('names a multi-repo workspace', () => {
    expect(workspaceLabel('/w/investigator', { repos: [{ name: 'a', path: 'a' }, { name: 'b', path: 'b' }] } as never)).toBe('investigator workspace · 2 repos');
    expect(workspaceLabel('/w/acme-notes', {} as never)).toBe('acme-notes');
  });

  it('dressed(): plain output is unchanged; the new look adds the header and draws Next as the arrow hint', () => {
    const plain = ctx([]);
    const d1 = dressed(plain.c, 'promises');
    d1.out('11 promises');
    d1.out('Next: jurator accept --all');
    expect(plain.out).toEqual(['11 promises', 'Next: jurator accept --all']);

    const nice = ctx([], { JURATOR_UI: '1' });
    const d2 = dressed(nice.c, 'promises');
    d2.setWorkspace('investigator workspace · 2 repos');
    d2.out('11 promises');
    d2.out('Nothing changed. Next: jurator check');
    expect(nice.out[0]).toContain('Jurator');
    expect(nice.out[0]).toContain('promises');
    expect(nice.out[1]).toContain('investigator workspace · 2 repos');
    expect(nice.out).toContain('11 promises');
    expect(nice.out).toContain('Nothing changed.');
    expect(nice.out.some((l) => /Next: jurator check$/u.test(l) && l.includes('→'))).toBe(true);
    expect(nice.out.join('\n')).not.toContain('\u001b');
  });
});

describe('renderRunScreen(): the check screen in the new look', () => {
  it('boxes the BROKEN promise first, then one table, cards, verify and one Next', async () => {
    const run = await demoRun();
    const ui = createUi({ env: {}, caps: { color: 'none', width: 100, unicode: true } });
    const lines = renderRunScreen(run, ui, { model: { id: 'm', mode: 'scripted' }, runPath: '.jurator/local/runs/x/run.json' });
    const text = lines.join('\n');
    expect(text).not.toContain('\u001b');
    expect(lines.every((l) => l.length <= 100)).toBe(true);
    const box = lines.findIndex((l) => l.includes('BROKEN') && l.includes('security.01'));
    const table = lines.findIndex((l) => /Results|Other results/u.test(l));
    expect(box).toBeGreaterThan(0);
    expect(table).toBeGreaterThan(box);
    expect(text).toContain('proved by a rule, no AI');
    expect(text).toContain('src/routes/export.ts:9');
    expect(text).toMatch(/LOOKS KEPT\s+privacy\.02/u);
    // HZ-1: the promise's own words in the table, the plain summary first in the box, then Found and To fix.
    expect(text).toContain('Only workspace admins can export customer data.');
    expect(text).toMatch(/Found\s+src\/routes\/export\.ts:9/u);
    expect(text).toContain('To fix');
    expect(text).toContain('summary by the program');
    expect(text).toContain('BEFORE MERGE  privacy.04');
    expect(text).toContain('jurator verify .jurator/local/runs/x/run.json');
    expect(lines.filter((l) => l.includes('Next:'))).toHaveLength(1);
    expect(runWorkspace(run)).toBeTruthy();
  });
});
