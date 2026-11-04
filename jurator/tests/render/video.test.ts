import { describe, expect, it } from 'vitest';
import type { CommandContext } from '../../src/cli/context.js';
import { runCheck } from '../../src/check/index.js';
import { renderRunText } from '../../src/render/index.js';
import { fold, isVideo, modelLabel, rootSpellings, tidy, VIDEO_WIDTH, visibleLength, withVideo } from '../../src/render/video.js';
import { makeStyle } from '../../src/util/term.js';
import { FakeModel, FakeRepo, FakeStore, fakeRunRule, fixedNow, promise, rule } from '../check/fakes.js';

function ctxFor(argv: string[], env: NodeJS.ProcessEnv = {}): { ctx: CommandContext; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const ctx: CommandContext = {
    cwd: '/tmp/kw.demo/acme-notes',
    argv,
    env,
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    style: makeStyle(false),
    now: fixedNow,
  };
  return { ctx, out, err };
}

async function brokenRun() {
  const repo = new FakeRepo(undefined, ['src/routes/export.ts']);
  const store = new FakeStore(
    [
      promise('security.01', {
        scope: ['src/routes/**'],
        wording: 'Only workspace admins can export customer data.',
        quote: { alias: 'security', policySha256: '0'.repeat(64), text: 'Only workspace admins can export customer data.', line: 3 },
      }),
      promise('privacy.02', { scope: ['src/export/**', 'src/routes/export.ts'] }),
    ],
    [rule('R-security.01', 'security.01', ['src/routes/**'])],
  );
  const model = new FakeModel(
    { 'ai-read:privacy.02': { verdict: 'kept', explanation: 'Filters deleted and archived.', citations: [{ path: 'src/export/query.ts', startLine: 2, endLine: 2 }] } },
    0,
  );
  const rr = fakeRunRule({ 'R-security.01': { outcome: 'fail', hits: [['src/routes/export.ts', 9]] } });
  return runCheck({ repo, store, model, target: { kind: 'diff', base: 'main', head: 'HEAD' }, aiRead: true, now: fixedNow }, { runRule: rr.fn });
}

describe('fold', () => {
  it('leaves a line that fits alone', () => {
    expect(fold('short line', 100)).toEqual(['short line']);
  });
  it('breaks at spaces within the width, keeps the indent and nothing is lost', () => {
    const line = `    ${'word '.repeat(40).trim()}`;
    const lines = fold(line, 50);
    for (const l of lines) expect(visibleLength(l)).toBeLessThanOrEqual(50);
    expect(lines[0]?.startsWith('    word')).toBe(true);
    expect(lines[1]?.startsWith('      word')).toBe(true);
    expect(lines.join(' ').replace(/\s+/gu, ' ').trim()).toBe(line.trim());
  });
  it('keeps the bar on box rows', () => {
    const lines = fold(`┃ Rule     ${'x'.repeat(8)} ${'long text '.repeat(12).trim()}`, 60);
    expect(lines.length).toBeGreaterThan(1);
    for (const l of lines) {
      expect(l.startsWith('┃ ')).toBe(true);
      expect(visibleLength(l)).toBeLessThanOrEqual(60);
    }
  });
  it('splits a word longer than a line, and does not count colour codes', () => {
    const lines = fold(`proof: ${'a'.repeat(130)}`, 50);
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(50);
    expect(lines.join('').replace(/\s+/gu, '')).toBe(`proof:${'a'.repeat(130)}`);
    const coloured = `\u001b[2m${'abc '.repeat(20).trim()}\u001b[22m`;
    expect(fold(coloured, 100)).toEqual([coloured]);
  });
});

describe('tidy', () => {
  const roots = ['/private/tmp/kw.demo/acme-notes', '/tmp/kw.demo/acme-notes'];
  it('makes paths repo-relative and names the repo folder', () => {
    expect(tidy('jurator verify /private/tmp/kw.demo/acme-notes/.jurator/local/runs/x/run.json', roots)).toBe(
      'jurator verify .jurator/local/runs/x/run.json',
    );
    expect(tidy('Created .jurator/ in /tmp/kw.demo/acme-notes', roots)).toBe('Created .jurator/ in acme-notes');
    expect(tidy('/tmp/kw.demo/acme-notes-other/x', roots)).toBe('/tmp/kw.demo/acme-notes-other/x');
  });
  it('shortens full shas to 7 characters', () => {
    expect(tidy(`at ${'a1b2c3d'.padEnd(40, 'e')} and ${'f'.repeat(64)}; short 1234567 stays`, [])).toBe('at a1b2c3d and fffffff; short 1234567 stays');
  });
  it('knows the /private spelling of a temp folder', () => {
    expect(rootSpellings('/tmp/does-not-exist-kw')).toEqual(['/private/tmp/does-not-exist-kw', '/tmp/does-not-exist-kw']);
  });
});

describe('withVideo', () => {
  it('returns the context as it is outside video mode', () => {
    const { ctx } = ctxFor(['--diff', 'main']);
    expect(withVideo(ctx)).toBe(ctx);
    expect(isVideo({}, ['--diff'])).toBe(false);
  });
  it('takes --video out of argv, passes JURATOR_VIDEO=1 on and shapes the output', () => {
    const { ctx, out } = ctxFor(['--diff', 'main', '--video']);
    const v = withVideo(ctx);
    expect(v.argv).toEqual(['--diff', 'main']);
    expect(v.env.JURATOR_VIDEO).toBe('1');
    v.out(`Record /tmp/kw.demo/acme-notes/.jurator/run.json at ${'c'.repeat(40)} ${'x '.repeat(80)}`);
    expect(out.join('\n')).toContain('Record .jurator/run.json at ccccccc');
    for (const l of out.join('\n').split('\n')) expect(l.length).toBeLessThanOrEqual(VIDEO_WIDTH);
  });
  it('never changes --json or --md output', () => {
    const json = ctxFor(['--json'], { JURATOR_VIDEO: '1' });
    const v = withVideo(json.ctx);
    const record = JSON.stringify({ head: 'd'.repeat(40), path: '/tmp/kw.demo/acme-notes/x', pad: 'y'.repeat(200) });
    v.out(record);
    expect(json.out).toEqual([record]);
    expect(withVideo(ctxFor(['--md', '--video']).ctx).argv).toEqual(['--md']);
  });
});

describe('video render', () => {
  it('fits 100 columns, says which model read the code, and never says waive', async () => {
    const run = await brokenRun();
    const text = renderRunText(run, makeStyle(false), {
      video: true,
      width: 160,
      runPath: '.jurator/local/runs/x/run.json',
      sources: { security: 'docs/security.md' },
      model: { id: 'muse-wonder-1.0', mode: 'live' },
    });
    for (const l of text.split('\n')) expect(l.length).toBeLessThanOrEqual(VIDEO_WIDTH);
    expect(text).toContain('AI: muse-wonder-1.0 (live)');
    expect(text).toContain('BROKEN · security.01 · proved by a rule, no AI');
    expect(text).not.toMatch(/waive/u);
    expect(text).toContain('Next: fix the code (src/routes/export.ts:9), or change the policy and run jurator compile.');
  });
  it('says live only for a live client', async () => {
    const run = await brokenRun();
    const scripted = renderRunText(run, makeStyle(false), { video: true, model: { id: 'scripted', mode: 'scripted' } });
    expect(scripted).toContain('AI: scripted answers (offline)');
    expect(scripted).not.toMatch(/\(live\)/u);
    expect(renderRunText(run, makeStyle(false), { video: true, model: null })).toContain('AI: off');
    expect(renderRunText(run, makeStyle(false), { video: false })).not.toMatch(/AI: (?:off|scripted|muse)/u);
    expect(modelLabel({ id: 'muse-wonder-1.0', mode: 'scripted' })).toBe('AI: scripted answers (offline)');
  });
});
