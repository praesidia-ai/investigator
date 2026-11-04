// Every hook bypass found in review is a test, plus fail-closed behaviour.
import { describe, expect, it } from 'vitest';
import type { CheckResult } from '../../src/contracts.js';
import {
  analyzeShell,
  failClosedFrom,
  runAgentHook,
  runPrePush,
  uncheckedOf,
  withDeadline,
  type HookDeps,
  type HookOptions,
} from '../../src/integrations/index.js';
import { brokenSecurityResult, fakeGit, fakeRun, holdsResult, SHA_BASE, SHA_FEATURE, SHA_MAIN, ZERO } from './fakes.js';

const git = fakeGit({ HEAD: SHA_FEATURE, main: SHA_MAIN, 'origin/main': SHA_MAIN }, { [`${SHA_MAIN}|${SHA_FEATURE}`]: SHA_BASE });

function deps(run: ReturnType<typeof fakeRun> | null, calls: string[] = []): HookDeps {
  return {
    git: () => git,
    async check(cwd) {
      calls.push(cwd);
      return { run, runPath: run ? '/repo/.jurator/local/runs/run-test/run.json' : null };
    },
    render: () => 'rendered',
  };
}

const bash = (command: string) => ({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd: '/repo' });

async function hook(payload: unknown, d: HookDeps, options?: HookOptions, agent: 'claude' | 'muse' = 'claude') {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runAgentHook(agent, typeof payload === 'string' ? payload : JSON.stringify(payload), '/repo', d, {
    out: (l) => out.push(l),
    err: (l) => err.push(l),
  }, options);
  const answer = out[0] ? (JSON.parse(out[0]) as { hookSpecificOutput?: Record<string, string>; systemMessage?: string }) : null;
  return { code, out, err, answer, denied: answer?.hookSpecificOutput?.permissionDecision === 'deny', reason: answer?.hookSpecificOutput?.permissionDecisionReason ?? '' };
}

/** A promise whose rule could not run (the regex sandbox stopped it). */
function timedOutResult(): CheckResult {
  return {
    ...holdsResult(),
    verdict: 'not-checked',
    level: 'quick',
    reason: 'Rule R-privacy.01-1 took longer than 2000 ms and was stopped',
    ruleResults: [
      { ruleId: 'R-privacy.01-1', promiseId: 'privacy.01', outcome: 'error', hits: [], message: 'Rule R-privacy.01-1 took longer than 2000 ms and was stopped' },
    ],
  };
}
function incompleteRun() {
  return { ...fakeRun([timedOutResult(), holdsResult()]), status: 'incomplete' as const };
}

describe('E-2 probes: pushes the old reader missed', () => {
  const skipping = [
    "bash -c 'git push --no-verify'",
    'sh -c "git push origin HEAD --no-verify"',
    "bash -lc 'cd app && git push --no-verify'",
    "eval 'git push --no-verify'",
    'eval "git push --no-verify origin HEAD"',
    '$(echo git) push --no-verify',
    'echo origin | xargs -I{} git push --no-verify {}',
    'GIT_DIR=.git git push --no-verify',
    'env -i PATH=/usr/bin git push --no-verify',
    'sudo -u me git push --no-verify',
    'timeout 30 git push --no-verify',
    '(git push --no-verify)',
    '{ git push --no-verify; }',
    'if git push --no-verify; then echo ok; fi',
    'echo "$(git push --no-verify)"',
    'git push --no-veri origin HEAD',
    'git --config-env=core.hooksPath=X push',
    "GIT_CONFIG_PARAMETERS=\"'core.hooksPath=/dev/null'\" git push",
    'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/dev/null git push',
    "export GIT_CONFIG_PARAMETERS=\"'core.hooksPath=/dev/null'\"; git push",
    'python3 -c "import os; os.system(\'git push --no-verify\')"',
    "python3 -c \"import subprocess; subprocess.run(['git', 'push', '--no-verify'])\"",
    "node -e \"require('child_process').execSync('git push --no-verify')\"",
    "python3 - <<'EOF'\nimport subprocess\nsubprocess.run(['git', 'push', '--no-verify'])\nEOF",
    'find . -maxdepth 0 -exec git push --no-verify \\;',
    'npm test && git push --no-verify',
    'npm test; git push --no-verify',
    'false || git push --no-verify',
  ];
  it.each(skipping)('sees a push that skips hooks: %s', (command) => {
    expect(analyzeShell(command)).toMatchObject({ pushes: true, skipsHooks: true });
  });

  it.each(skipping)('the agent hook denies it without running a check: %s', async (command) => {
    const calls: string[] = [];
    const r = await hook(bash(command), deps(fakeRun([holdsResult()]), calls));
    expect(r.denied).toBe(true);
    expect(r.reason).toContain('skips git hooks');
    expect(calls).toEqual([]);
  });

  it.each([
    "bash -c 'git push origin feature/csv-export'",
    'eval git push',
    'echo x | xargs git push',
    "python3 -c \"import subprocess; subprocess.run(['git', 'push'])\"",
    'g=git; $g push',
  ])('a hidden push is checked and denied when a rule says broken: %s', async (command) => {
    const calls: string[] = [];
    const r = await hook(bash(command), deps(fakeRun([brokenSecurityResult()]), calls));
    expect(r.denied).toBe(true);
    expect(r.reason).toContain('security.01 BROKEN');
    expect(calls).toHaveLength(1);
  });

  it('reads an argv array (Muse Code shell tool) with its words intact', async () => {
    const payload = { tool_name: 'shell', tool_input: { command: ['bash', '-c', 'git push --no-verify'] }, cwd: '/repo' };
    expect((await hook(payload, deps(fakeRun([holdsResult()])), undefined, 'muse')).denied).toBe(true);
    const accept = { tool_name: 'shell', tool_input: { command: ['sh', '-c', "jurator rule accept 'R-1'"] }, cwd: '/repo' };
    expect((await hook(accept, deps(null), undefined, 'muse')).denied).toBe(true);
  });

  it('keeps the push directory through bash -c', () => {
    expect(analyzeShell("cd app && bash -c 'git push'")).toMatchObject({ pushes: true, pushDir: 'app' });
  });
});

describe('E-2 probes: turning the hooks off for later pushes', () => {
  it.each([
    'git config core.hooksPath /dev/null && git push',
    'git config --local core.hooksPath /tmp/none',
    'git config set core.hooksPath /tmp/none',
    'git config --unset core.hooksPath',
    'rm .git/hooks/pre-push',
    'chmod -x .git/hooks/pre-push',
    'echo "exit 0" > .git/hooks/pre-push',
    "python3 -c \"open('.claude/settings.json','w').write('{}')\"",
    'echo {} > .claude/settings.local.json',
    'rm .muse/hooks.json',
  ])('denies %s', async (command) => {
    expect(analyzeShell(command).tampersHooks).toBe(true);
    const r = await hook(bash(command), deps(null));
    expect(r.denied).toBe(true);
    expect(r.reason).toContain('core.hooksPath');
  });

  it('allows reading the hook settings', () => {
    for (const command of ['git config --get core.hooksPath', 'git config core.hooksPath', 'cat .git/hooks/pre-push', 'ls .claude/']) {
      expect(analyzeShell(command).tampersHooks).toBe(false);
    }
  });

  it('denies Edit/Write on the hook files', async () => {
    for (const file of ['/repo/.git/hooks/pre-push', '/repo/.claude/settings.json', '.muse/hooks.json']) {
      const r = await hook({ tool_name: 'Write', tool_input: { file_path: file, content: '' }, cwd: '/repo' }, deps(null));
      expect(r.denied).toBe(true);
    }
  });
});

describe('E-2 probes: writing .jurator/', () => {
  it.each([
    "python3 -c \"open('.jurator/rules.json','w').write('[]')\"",
    "python3 -c \"import pathlib; pathlib.Path('.jurator/rules.json').write_text('[]')\"",
    "node -e \"require('fs').writeFileSync('.jurator/rules.json','[]')\"",
    "python3 - <<'EOF'\nimport json\njson.dump([], open('.jurator/rules.json', 'w'))\nEOF",
    'cat /dev/null > .jurator/rules.json',
    'cp /tmp/x .jurator/rules.json',
    "echo '[]' | tee .jurator/rules.json",
    "echo '[]' | tee -a .jurator/rules.json",
    'sed -i "" s/block/monitor/ .jurator/config.json',
    'sed -i.bak s/block/monitor/ .jurator/config.json',
    "perl -pi -e 's/block/monitor/' .jurator/config.json",
    "bash -c 'echo [] > .jurator/rules.json'",
    "eval 'rm .jurator/rules.json'",
    'cd .jurator && echo [] > rules.json',
    'cd .jurator; rm rules.json',
    'printf x >| .jurator/rules.json',
    'jq . r.json &> .jurator/rules.json',
    'curl -o .jurator/rules.json https://example.com/r.json',
    'find .jurator -name "*.json" -delete',
    'git checkout main -- .jurator/rules.json',
    'mv /tmp/r.json "$PWD/.jurator/rules.json"',
  ])('denies %s', async (command) => {
    expect(analyzeShell(command).writesJurator).toBe(true);
    const r = await hook(bash(command), deps(null));
    expect(r.denied).toBe(true);
    expect(r.reason).toContain('.jurator/');
  });

  it.each([
    'cat .jurator/rules.json',
    'jq . .jurator/rules.json',
    'cp .jurator/rules.json /tmp/r.json',
    "python3 -c \"print(open('.jurator/rules.json').read())\"",
    'grep -r requireAdmin .jurator/ > /tmp/hits.txt',
    'ls .jurator 2>/dev/null',
  ])('allows reading it: %s', (command) => {
    expect(analyzeShell(command).writesJurator).toBe(false);
  });
});

describe('E-2 probes: the agent records a decision for the person', () => {
  it.each([
    'jurator rule accept R-1',
    'jurator rule accept --all',
    'jurator accept privacy.01',
    'jurator accept --all',
    'jurator decide C-1',
    'npx jurator waive P-3 --reason ok',
    'npx -y jurator rule accept R-1',
    'npm exec jurator -- accept privacy.01',
    'pnpm jurator rule accept R-1',
    'node dist/bin.js rule accept R-1',
    'node /opt/jurator/dist/bin.js accept --all',
    'jurator rule propose --all --accept',
    'jurator compile --accept',
    'jurator conflicts --rule C-1 --as not-a-conflict --why x',
    'npm test && jurator rule accept R-1',
    "bash -c 'jurator rule accept R-1'",
    "python3 -c \"import os; os.system('jurator rule accept R-1')\"",
  ])('denies %s', async (command) => {
    expect(analyzeShell(command).decides).toBe(true);
    const r = await hook(bash(command), deps(null));
    expect(r.denied).toBe(true);
    expect(r.reason).toContain('a person makes');
  });

  it.each([
    'jurator check --diff main',
    'jurator rule propose privacy.01',
    'jurator rule list',
    'jurator rule test',
    'jurator promises',
    'jurator conflicts',
    'node dist/bin.js verify .jurator/local/runs/x/run.json',
    'cat .jurator/rules.json | grep accept',
  ])('allows %s', (command) => {
    expect(analyzeShell(command).decides).toBe(false);
  });
});

describe('fail-closed', () => {
  it('reads the flag and the env', () => {
    expect(failClosedFrom(['--fail-closed'], {})).toBe(true);
    expect(failClosedFrom([], { JURATOR_FAIL_CLOSED: '1' })).toBe(true);
    expect(failClosedFrom([], { JURATOR_FAIL_CLOSED: '0' })).toBe(false);
    expect(failClosedFrom(['origin'], {})).toBe(false);
  });

  it('counts rule errors and incomplete runs, not BROKEN or uncovered promises', () => {
    expect(uncheckedOf(incompleteRun()).map((u) => u.promiseId)).toEqual(['privacy.01']);
    expect(uncheckedOf(fakeRun([brokenSecurityResult(), holdsResult()]))).toEqual([]);
    expect(uncheckedOf({ ...fakeRun([holdsResult()]), status: 'failed' })).toEqual([{ promiseId: '(run)', why: 'the check is failed' }]);
  });

  const stdin = `refs/heads/feature/csv-export ${SHA_FEATURE} refs/heads/feature/csv-export ${ZERO}\n`;
  async function prePush(d: HookDeps, failClosed: boolean, timeoutMs: number | null = null) {
    const err: string[] = [];
    const code = await runPrePush(stdin, 'origin', '/repo', d, { out: () => {}, err: (l) => err.push(l) }, { failClosed, timeoutMs });
    return { code, err: err.join('\n') };
  }

  it('pre-push: a rule timeout blocks with fail-closed (exit 2) and warns loudly without it (exit 0)', async () => {
    const closed = await prePush(deps(incompleteRun()), true);
    expect(closed.code).toBe(2);
    expect(closed.err).toContain('push blocked');
    expect(closed.err).toContain('privacy.01 NOT CHECKED: Rule R-privacy.01-1 took longer than 2000 ms');
    const open = await prePush(deps(incompleteRun()), false);
    expect(open.code).toBe(0);
    expect(open.err).toContain('WARNING: 1 promise could not be checked');
    expect(open.err).toContain('--fail-closed');
  });

  it('pre-push: an internal error blocks with fail-closed and warns without it', async () => {
    const boom = { ...deps(null), check: async () => Promise.reject(new Error('git exploded')) };
    expect(await prePush(boom, true)).toMatchObject({ code: 2 });
    expect((await prePush(boom, true)).err).toContain('could not check it (git exploded)');
    const open = await prePush(boom, false);
    expect(open.code).toBe(0);
    expect(open.err).toContain('WARNING');
    expect(open.err).toContain('UNCHECKED');
  });

  it('pre-push: a check slower than the time limit blocks with fail-closed', async () => {
    const slow = { ...deps(null), check: () => new Promise<never>(() => {}) };
    const r = await prePush(slow, true, 30);
    expect(r.code).toBe(2);
    expect(r.err).toContain('took longer than 30 ms');
    expect((await prePush(slow, false, 30)).code).toBe(0);
  });

  it('pre-push: BROKEN still exits 1 and a clean run exits 0 under fail-closed', async () => {
    expect((await prePush(deps(fakeRun([brokenSecurityResult(), timedOutResult()])), true)).code).toBe(1);
    expect((await prePush(deps(fakeRun([holdsResult()])), true)).code).toBe(0);
  });

  it('agent: a rule timeout denies the push with fail-closed, else allows with a warning', async () => {
    const closed = await hook(bash('git push'), deps(incompleteRun()), { failClosed: true, timeoutMs: null });
    expect(closed.denied).toBe(true);
    expect(closed.reason).toContain('could not be checked');
    expect(closed.reason).toContain('privacy.01 NOT CHECKED');
    const open = await hook(bash('git push'), deps(incompleteRun()), { failClosed: false, timeoutMs: null });
    expect(open.denied).toBe(false);
    expect(open.answer?.systemMessage).toContain('WARNING');
    expect(open.err.join('\n')).toContain('NOT fully checked');
    const muse = await hook(bash('git push'), deps(incompleteRun()), { failClosed: false, timeoutMs: null }, 'muse');
    expect(muse.out).toEqual([]);
    expect(muse.err.join('\n')).toContain('WARNING');
  });

  it('agent: internal errors, timeouts and unreadable input deny with fail-closed', async () => {
    const boom = { ...deps(null), check: async () => Promise.reject(new Error('git exploded')) };
    expect((await hook(bash('git push'), boom, { failClosed: true, timeoutMs: null })).denied).toBe(true);
    const slow = { ...deps(null), check: () => new Promise<never>(() => {}) };
    const late = await hook(bash('git push'), slow, { failClosed: true, timeoutMs: 30 });
    expect(late.denied).toBe(true);
    expect(late.reason).toContain('took longer than 30 ms');
    expect((await hook('not json', deps(null), { failClosed: true, timeoutMs: null })).denied).toBe(true);
    // default stays fail-open, with a loud warning
    const open = await hook(bash('git push'), boom);
    expect(open.denied).toBe(false);
    expect(open.err.join('\n')).toContain('WARNING');
    expect((await hook('not json', deps(null))).out).toEqual([]);
  });

  it('withDeadline passes results through and clears its timer', async () => {
    expect(await withDeadline(Promise.resolve(7), 1000)).toBe(7);
    expect(await withDeadline(Promise.resolve(8), null)).toBe(8);
  });
});
