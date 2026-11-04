import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { DEFAULT_CONFIG } from '../../src/contracts.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import doctor from '../../src/cli/commands/doctor.js';
import type { CommandContext } from '../../src/cli/context.js';
import { makeStyle } from '../../src/util/term.js';
import { reply, TEST_KEY, transport } from './helpers.js';

let cwd: string;
beforeAll(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'kw-doctor-'));
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function context(argv: string[], env: NodeJS.ProcessEnv) {
  const out: string[] = [];
  const err: string[] = [];
  const ctx: CommandContext = {
    cwd,
    argv,
    env,
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    style: makeStyle(false),
    now: () => new Date('2026-11-04T05:00:00Z'),
  };
  return { ctx, out, err };
}

describe('jurator doctor', () => {
  it('says the key is missing and what to do, without a network call', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const { ctx, out } = context([], {});
    expect(await doctor.run(ctx)).toBe(0);
    const text = out.join('\n');
    expect(text).toContain('API key       not set');
    expect(text).toContain('muse-wonder-1.0');
    expect(text).toMatch(/Next: set META_API_KEY/u);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('shows which variable holds the key but never the key itself', async () => {
    const { ctx, out } = context(['--json'], { META_API_KEY: TEST_KEY, MODEL_ID: 'muse-spark-1.3' });
    expect(await doctor.run(ctx)).toBe(0);
    const report = JSON.parse(out.join('\n')) as Record<string, unknown>;
    expect(report['keySet']).toBe(true);
    expect(report['keyEnv']).toBe('META_API_KEY');
    expect(report['model']).toBe('muse-spark-1.3');
    expect(report['modelSource']).toBe('env MODEL_ID');
    expect(out.join('\n')).not.toContain(TEST_KEY);
  });

  it('--live makes one tiny call and prints latency and cost', async () => {
    const t = transport(reply(JSON.stringify({ ok: true, word: 'ready' }), { usage: { input_tokens: 60, output_tokens: 20 } }));
    vi.stubGlobal('fetch', t.fetch);
    const { ctx, out } = context(['--live'], { META_API_KEY: TEST_KEY, JURATOR_SCRIPTED_DIR: '/nope' });
    expect(await doctor.run(ctx)).toBe(0);
    expect(t.fetch).toHaveBeenCalledTimes(1);
    const text = out.join('\n');
    expect(text).toMatch(/Live call +ok in \d+ ms · 60 in \/ 20 out tokens · \$0\.0006/u);
    expect(text).not.toContain(TEST_KEY);
    // R4-FIX (backlog 2): no .jurator/ here yet, so init comes first.
    expect(text).toContain('Next: jurator init (there is no .jurator/ here yet)');
  });

  it('with a workspace, --live points at compile', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'kw-doctor-ws-'));
    execFileSync('git', ['init', '-q'], { cwd: repo });
    await mkdir(join(repo, '.jurator'), { recursive: true });
    await writeFile(join(repo, '.jurator', 'config.json'), JSON.stringify(DEFAULT_CONFIG));
    const t = transport(reply(JSON.stringify({ ok: true, word: 'ready' }), { usage: { input_tokens: 60, output_tokens: 20 } }));
    vi.stubGlobal('fetch', t.fetch);
    const { ctx, out } = context(['--live'], { META_API_KEY: TEST_KEY });
    expect(await doctor.run({ ...ctx, cwd: repo })).toBe(0);
    expect(out.join('\n')).toContain('Next: jurator compile');
  });

  it('rejects unknown options with exit 2', async () => {
    const { ctx, err } = context(['--bogus'], {});
    expect(await doctor.run(ctx)).toBe(2);
    expect(err[0]).toMatch(/Unknown option --bogus/u);
  });
});
