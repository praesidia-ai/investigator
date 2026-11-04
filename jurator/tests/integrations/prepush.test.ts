import { describe, expect, it } from 'vitest';
import {
  blockingResults,
  choosePushTarget,
  parsePrePushInput,
  runPrePush,
  type CheckTarget,
  type HookDeps,
} from '../../src/integrations/index.js';
import { brokenSecurityResult, fakeGit, fakeRun, holdsResult, SHA_BASE, SHA_FEATURE, SHA_MAIN, SHA_REMOTE, ZERO } from './fakes.js';

describe('pre-push stdin', () => {
  it('parses one update per line and skips junk', () => {
    const text = [
      `refs/heads/feature/csv-export ${SHA_FEATURE} refs/heads/feature/csv-export ${ZERO}`,
      '',
      'not a push line',
      `refs/heads/main ${SHA_MAIN} refs/heads/main ${SHA_REMOTE}\r`,
    ].join('\n');
    expect(parsePrePushInput(text)).toEqual([
      { localRef: 'refs/heads/feature/csv-export', localSha: SHA_FEATURE, remoteRef: 'refs/heads/feature/csv-export', remoteSha: ZERO },
      { localRef: 'refs/heads/main', localSha: SHA_MAIN, remoteRef: 'refs/heads/main', remoteSha: SHA_REMOTE },
    ]);
  });
  it('gives nothing for empty stdin', () => {
    expect(parsePrePushInput('')).toEqual([]);
  });
});

describe('pre-push base choice', () => {
  const update = (localSha: string, remoteSha: string, ref = 'refs/heads/feature/csv-export') => ({
    localRef: ref,
    localSha,
    remoteRef: ref,
    remoteSha,
  });

  it('uses the remote sha when git has it', async () => {
    const git = fakeGit({}, {}, [SHA_REMOTE]);
    expect(await choosePushTarget(update(SHA_FEATURE, SHA_REMOTE), git, 'origin')).toEqual({
      kind: 'diff',
      base: SHA_REMOTE,
      head: SHA_FEATURE,
    });
  });

  it('uses the merge-base with origin/main for a new branch', async () => {
    const git = fakeGit({ 'origin/main': SHA_MAIN, main: SHA_MAIN }, { [`${SHA_MAIN}|${SHA_FEATURE}`]: SHA_BASE });
    expect(await choosePushTarget(update(SHA_FEATURE, ZERO), git, 'origin')).toEqual({
      kind: 'diff',
      base: SHA_BASE,
      head: SHA_FEATURE,
    });
  });

  it('prefers the pushed-to remote, then falls back to local main', async () => {
    const git = fakeGit({ main: SHA_MAIN }, { [`${SHA_MAIN}|${SHA_FEATURE}`]: SHA_BASE });
    expect(await choosePushTarget(update(SHA_FEATURE, ZERO), git, 'team')).toEqual({ kind: 'diff', base: SHA_BASE, head: SHA_FEATURE });
  });

  it('falls back to the merge-base when the remote sha is unknown locally (force push)', async () => {
    const git = fakeGit({ 'origin/main': SHA_MAIN }, { [`${SHA_MAIN}|${SHA_FEATURE}`]: SHA_BASE });
    expect(await choosePushTarget(update(SHA_FEATURE, SHA_REMOTE), git, 'origin')).toEqual({
      kind: 'diff',
      base: SHA_BASE,
      head: SHA_FEATURE,
    });
  });

  it('checks the whole repo when there is no base to diff against', async () => {
    const git = fakeGit({ main: SHA_MAIN }, { [`${SHA_MAIN}|${SHA_MAIN}`]: SHA_MAIN });
    expect(await choosePushTarget(update(SHA_MAIN, ZERO, 'refs/heads/main'), git, 'origin')).toEqual({ kind: 'repo', head: SHA_MAIN });
  });

  it('skips deleted branches, tags and no-op pushes', async () => {
    const git = fakeGit({}, {});
    expect(await choosePushTarget(update(ZERO, SHA_REMOTE), git)).toBeNull();
    expect(await choosePushTarget(update(SHA_FEATURE, ZERO, 'refs/tags/v1'), git)).toBeNull();
    expect(await choosePushTarget(update(SHA_FEATURE, SHA_FEATURE), git)).toBeNull();
  });
});

describe('runPrePush', () => {
  const stdin = `refs/heads/feature/csv-export ${SHA_FEATURE} refs/heads/feature/csv-export ${ZERO}\n`;
  const git = fakeGit({ 'origin/main': SHA_MAIN }, { [`${SHA_MAIN}|${SHA_FEATURE}`]: SHA_BASE });

  const renders: unknown[] = [];
  function deps(run: ReturnType<typeof fakeRun> | null, seen: CheckTarget[] = []): HookDeps {
    return {
      git: () => git,
      async check(_cwd, target) {
        seen.push(target);
        return { run, runPath: run ? '/repo/.jurator/local/runs/x/run.json' : null };
      },
      render: (r, extra) => {
        renders.push(extra);
        return `rendered ${r.results.map((x) => `${x.promiseId}:${x.verdict}`).join(',')}`;
      },
    };
  }

  it('blocks (exit 1) when a rule says broken in block mode', async () => {
    const out: string[] = [];
    const err: string[] = [];
    const seen: CheckTarget[] = [];
    const code = await runPrePush(stdin, 'origin', '/repo', deps(fakeRun([brokenSecurityResult(), holdsResult()]), seen), {
      out: (l) => out.push(l),
      err: (l) => err.push(l),
    });
    expect(code).toBe(1);
    expect(seen).toEqual([{ kind: 'diff', base: SHA_BASE, head: SHA_FEATURE }]);
    expect(out.join('\n')).toContain('security.01:broken');
    expect(renders).toEqual([{ runPath: '.jurator/local/runs/x/run.json' }]);
    expect(err.join('\n')).toContain('Next: fix the code, or change the policy and run');
    expect(err.join('\n')).toContain('push blocked');
  });

  it('lets the push through when every rule holds', async () => {
    const code = await runPrePush(stdin, 'origin', '/repo', deps(fakeRun([holdsResult()])), { out: () => {}, err: () => {} });
    expect(code).toBe(0);
  });

  it('does not block in monitor mode, nor on AI reads', async () => {
    expect(blockingResults(fakeRun([brokenSecurityResult()], 'monitor'))).toEqual([]);
    const aiBroken = { ...brokenSecurityResult(), verdict: 'looks-broken' as const, level: 'ai-read' as const };
    expect(blockingResults(fakeRun([aiBroken]))).toEqual([]);
  });

  it('fails open when the check throws', async () => {
    const err: string[] = [];
    const code = await runPrePush(
      stdin,
      'origin',
      '/repo',
      { ...deps(null), check: async () => Promise.reject(new Error('boom')) },
      { out: () => {}, err: (l) => err.push(l) },
    );
    expect(code).toBe(0);
    expect(err.join('\n')).toContain('letting it through');
  });

  it('says so and exits 0 when the repo has no .jurator/', async () => {
    const err: string[] = [];
    expect(await runPrePush(stdin, 'origin', '/repo', deps(null), { out: () => {}, err: (l) => err.push(l) })).toBe(0);
    expect(err.join('\n')).toContain('jurator init');
  });
});
