import { afterEach, describe, expect, it, vi } from 'vitest';
import { createUi } from '../../src/ui/components.js';
import { createLive, nextState, renderFrame, type LiveOptions } from '../../src/ui/live.js';
import { stripAnsi, width } from '../../src/ui/text.js';

function fakeTty(columns = 80, rows = 24) {
  const chunks: string[] = [];
  return { isTTY: true, columns, rows, write: (s: string) => chunks.push(s), chunks };
}
function clock(start = 0) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe('nextState', () => {
  it('waiting -> running -> done | failed | skipped; ended steps never change', () => {
    expect(nextState('waiting', 'start')).toBe('running');
    expect(nextState('running', 'done')).toBe('done');
    expect(nextState('running', 'fail')).toBe('failed');
    expect(nextState('waiting', 'skip')).toBe('skipped');
    expect(nextState('waiting', 'done')).toBe('done');
    for (const s of ['done', 'failed', 'skipped'] as const) {
      for (const e of ['start', 'done', 'fail', 'skip'] as const) expect(nextState(s, e)).toBeNull();
    }
  });
});

describe('plain mode (one line per event)', () => {
  const run = (extra: Partial<LiveOptions> = {}) => {
    const lines: string[] = [];
    const c = clock();
    const live = createLive({ title: 'rule propose', unit: 'rules', budgetUsd: 10, env: { CI: 'true' }, write: (l) => lines.push(l), now: c.now, ...extra });
    live.add('documents.01');
    live.add('documents.02');
    live.add('documents.03');
    live.start('documents.01', 'writing the rule');
    live.detail('documents.01', 'proving: 6 mutants');
    live.detail('documents.01', 'proving: 6 mutants'); // the same detail twice prints once
    c.advance(8200);
    live.addCost(1.32);
    live.done('documents.01', 'rule written');
    live.done('documents.01', 'again'); // ignored: already done
    live.start('documents.02');
    c.advance(5100);
    live.fail('documents.02', 'no rule possible');
    live.skip('documents.03', 'budget reached');
    live.log('a note');
    const summary = live.finish({ ok: true });
    return { lines, summary, live };
  };

  it('prints a stable transcript', () => {
    const { lines, live } = run();
    expect(live.mode).toBe('plain');
    expect(lines).toEqual([
      '▸ documents.01  writing the rule',
      '  documents.01: proving: 6 mutants',
      '✓ documents.01  rule written  (8.2s · 1/3 rules · $1.32 of $10.00)',
      '▸ documents.02',
      '✗ documents.02  no rule possible  (5.1s · 2/3 rules · $1.32 of $10.00)',
      '– documents.03  skipped: budget reached',
      'a note',
      '✓ rule propose  3/3 rules · 1 done · 1 failed · 1 skipped · 13s · $1.32 of $10.00',
      '  ✗ documents.02  no rule possible',
    ]);
  });

  it('writes no escape codes with NO_COLOR, --json or JURATOR_PLAIN=1, even on a terminal', () => {
    for (const [env, argv] of [
      [{ NO_COLOR: '1' }, []],
      [{}, ['--json']],
      [{ JURATOR_PLAIN: '1' }, []],
    ] as const) {
      const tty = fakeTty();
      const lines: string[] = [];
      const live = createLive({ title: 't', env, argv, stream: tty, write: (l) => lines.push(l), timer: false });
      live.start('a', 'x');
      live.done('a');
      live.finish();
      expect(live.mode).toBe('plain');
      expect(tty.chunks.join('')).toBe('');
      expect(lines.join('\n')).not.toContain('\u001b');
    }
  });

  it('cleans step text (no cursor moves from a model or a repo)', () => {
    const lines: string[] = [];
    const live = createLive({ title: 't', env: { CI: '1' }, write: (l) => lines.push(l) });
    live.start('a', 'evil\u001b[2J\u001b[1Atext');
    expect(lines.join('')).not.toContain('\u001b');
  });
});

describe('terminal mode (redrawn in place)', () => {
  afterEach(() => vi.useRealTimers());
  const ui = (tty: ReturnType<typeof fakeTty>, env: NodeJS.ProcessEnv = {}) =>
    createUi({ stream: tty, env: { TERM: 'xterm-256color', ...env } });

  it('redraws by moving up over the last frame, and collapses into the summary', () => {
    const tty = fakeTty(80, 24);
    const c = clock();
    const live = createLive({ title: 'compile', unit: 'stages', stream: tty, env: { TERM: 'xterm-256color' }, now: c.now, timer: false, ui: ui(tty) });
    expect(live.mode).toBe('live');
    live.add('fetch', 'Fetch sources');
    live.add('draft', 'Draft promises');
    live.start('fetch', 'policies/document-handling.md');
    const first = live.render();
    expect(first.map(stripAnsi)).toEqual([
      expect.stringMatching(/^ {2}⠙ Fetch sources {2,}0ms$/u),
      '      policies/document-handling.md',
      '  ○ Draft promises',
      '',
      expect.stringMatching(/^ {2}─{24} {2}0\/2 stages {2}· {2}0ms$/u),
    ]);
    c.advance(1500);
    live.done('fetch');
    live.render();
    const last = tty.chunks[tty.chunks.length - 1] ?? '';
    expect(last).toContain(`\u001b[${first.length}A`);
    expect(last).toContain('\u001b[0J');
    const summary = live.finish();
    expect(stripAnsi(summary[0] ?? '')).toBe('✓ compile  1/2 stages · 1 done · 1 not run · 1.5s');
    expect(tty.chunks.join('')).toContain('\u001b[?25h');
    expect(live.render()).toEqual([]);
  });

  it('never draws more lines than the terminal has, nor wider lines', () => {
    for (const [cols, rows] of [
      [40, 8],
      [80, 12],
      [120, 40],
    ] as const) {
      const tty = fakeTty(cols, rows);
      const c = clock();
      const live = createLive({ title: 'rule propose', unit: 'rules', budgetUsd: 10, stream: tty, env: {}, now: c.now, timer: false, ui: ui(tty) });
      for (let i = 1; i <= 30; i += 1) live.add(`documents.${String(i).padStart(2, '0')}`);
      for (let i = 1; i <= 12; i += 1) {
        const id = `documents.${String(i).padStart(2, '0')}`;
        live.start(id, 'a detail line that is quite long and keeps going for a while');
        c.advance(900);
        if (i <= 8) (i % 3 === 0 ? live.fail : live.done)(id, 'a note that is also rather long');
      }
      live.cost(9.5);
      const frame = live.render();
      expect(frame.length).toBeLessThanOrEqual(rows - 1);
      for (const l of frame) expect(width(l)).toBeLessThanOrEqual(cols - 1);
      expect(stripAnsi(frame[frame.length - 1] ?? '')).toContain('8/30 rules');
      live.finish();
    }
  });

  it('folds hidden steps into count lines, keeping running and failed ones', () => {
    const u = createUi({ env: {}, caps: { live: true, color: 'none', width: 80, height: 10 } });
    const c = clock();
    const tty = fakeTty(80, 10);
    const live = createLive({ title: 'r', unit: 'rules', stream: tty, env: {}, now: c.now, timer: false, ui: u });
    for (let i = 1; i <= 20; i += 1) live.add(`p.${i}`);
    for (let i = 1; i <= 10; i += 1) {
      live.start(`p.${i}`);
      c.advance(1000);
      if (i === 2) live.fail(`p.${i}`, 'no rule possible');
      else if (i < 9) live.done(`p.${i}`);
    }
    const frame = renderFrame(u, live.snapshot(), 0, 79, 9).map((l) => l.trimEnd());
    expect(frame).toHaveLength(9);
    expect(frame[0]).toBe('  ✓ 6 done');
    expect(frame.some((l) => l.includes('✗ p.2') && l.includes('no rule possible'))).toBe(true);
    expect(frame.filter((l) => /⠋ p\.(9|10) /u.test(l))).toHaveLength(2);
    expect(frame).toContain('  ○ 9 more waiting');
    live.finish();
  });

  it('reduced motion: no spinner, the same lines', () => {
    const tty = fakeTty();
    const live = createLive({ title: 't', stream: tty, env: { JURATOR_NO_ANIMATION: '1' }, timer: false, now: () => 0, ui: ui(tty, { JURATOR_NO_ANIMATION: '1' }) });
    live.start('a', 'working');
    const frame = live.render().map(stripAnsi);
    expect(frame[0]).toMatch(/^ {2}▸ a/u);
    expect(frame.join('')).not.toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/u);
    live.finish();
  });

  it('ticks at about 10 fps and stops the timer on finish', () => {
    vi.useFakeTimers();
    const tty = fakeTty();
    const live = createLive({ title: 't', stream: tty, env: {}, ui: ui(tty) });
    live.start('a');
    vi.advanceTimersByTime(1000);
    const writes = tty.chunks.length;
    expect(writes).toBeGreaterThanOrEqual(9);
    live.finish();
    vi.advanceTimersByTime(1000);
    expect(tty.chunks.length).toBe(writes + 1);
  });

  it('cost meter, explicit progress and ETA', () => {
    const tty = fakeTty(100, 24);
    const c = clock();
    const live = createLive({ title: 't', unit: 'rules', total: 10, budgetUsd: 10, stream: tty, env: {}, now: c.now, timer: false, ui: ui(tty) });
    live.progress(4);
    live.cost(8.5);
    c.advance(40_000);
    const s = live.snapshot();
    expect(s).toMatchObject({ done: 4, total: 10, costUsd: 8.5, etaMs: 60_000 });
    const footer = stripAnsi(live.render().pop() ?? '');
    expect(footer).toContain('4/10 rules');
    expect(footer).toContain('$8.50 of $10.00');
    expect(footer).toContain('about 1m 00s left');
    live.eta(null);
    expect(live.snapshot().etaMs).toBeNull();
    live.finish();
  });

  it('log lines stay above the live area', () => {
    const tty = fakeTty();
    const live = createLive({ title: 't', stream: tty, env: {}, timer: false, now: () => 0, ui: ui(tty) });
    live.start('a');
    live.render();
    live.log('kept line');
    const out = tty.chunks.join('');
    expect(out.indexOf('kept line')).toBeGreaterThan(0);
    expect(out.lastIndexOf('a')).toBeGreaterThan(out.indexOf('kept line'));
    live.finish();
  });
});
