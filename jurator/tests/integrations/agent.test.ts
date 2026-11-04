import { describe, expect, it } from 'vitest';
import { analyzeShell, decideToolUse, runAgentHook, type HookDeps, type ToolEvent } from '../../src/integrations/index.js';
import { brokenSecurityResult, fakeGit, fakeRun, holdsResult, SHA_BASE, SHA_FEATURE, SHA_MAIN } from './fakes.js';

const git = fakeGit({ HEAD: SHA_FEATURE, main: SHA_MAIN }, { [`${SHA_MAIN}|${SHA_FEATURE}`]: SHA_BASE });

function deps(run: ReturnType<typeof fakeRun> | null, calls: string[] = []): HookDeps {
  return {
    git: () => git,
    async check(cwd, target) {
      calls.push(`${cwd} ${JSON.stringify(target)}`);
      return { run, runPath: run ? '/repo/.jurator/local/runs/run-test/run.json' : null, sources: { security: 'docs/security.md' } };
    },
    render: () => '',
  };
}

async function hook(agent: 'claude' | 'muse', payload: unknown, d: HookDeps): Promise<{ code: number; out: string[]; err: string[] }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runAgentHook(agent, JSON.stringify(payload), '/fallback', d, { out: (l) => out.push(l), err: (l) => err.push(l) });
  return { code, out, err };
}

const bash = (command: string) => ({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd: '/repo' });

describe('Claude Code PreToolUse hook', () => {
  it('denies git push with the evidence when a rule says broken', async () => {
    const calls: string[] = [];
    const { code, out } = await hook('claude', bash('git push origin feature/csv-export'), deps(fakeRun([brokenSecurityResult(), holdsResult()]), calls));
    expect(code).toBe(0);
    expect(out).toHaveLength(1);
    const answer = JSON.parse(out[0] as string) as { hookSpecificOutput: Record<string, string> };
    expect(answer.hookSpecificOutput.hookEventName).toBe('PreToolUse');
    expect(answer.hookSpecificOutput.permissionDecision).toBe('deny');
    const reason = answer.hookSpecificOutput.permissionDecisionReason ?? '';
    expect(reason).toContain('security.01 BROKEN');
    expect(reason).toContain('src/routes/export.ts:17');
    expect(reason).toContain('Policy (docs/security.md:3): "Only workspace admins can export customer data."');
    expect(reason).toContain('jurator verify /repo/.jurator/local/runs/run-test/run.json');
    expect(reason).not.toContain('privacy.01');
    // checked main...HEAD in the payload's cwd
    expect(calls).toEqual([`/repo ${JSON.stringify({ kind: 'diff', base: SHA_BASE, head: SHA_FEATURE })}`]);
  });

  it('allows git push (no output) when every rule holds', async () => {
    const { code, out } = await hook('claude', bash('git push'), deps(fakeRun([holdsResult()])));
    expect(code).toBe(0);
    expect(out).toEqual([]);
  });

  it('allows unrelated tools and commands without running a check', async () => {
    const calls: string[] = [];
    const d = deps(fakeRun([brokenSecurityResult()]), calls);
    for (const payload of [
      bash('npm test && git status'),
      bash('git commit -m "push the button"'),
      { tool_name: 'Read', tool_input: { file_path: '/repo/.jurator/rules.json' }, cwd: '/repo' },
      { tool_name: 'Edit', tool_input: { file_path: '/repo/src/routes/export.ts', old_string: 'a', new_string: 'b' }, cwd: '/repo' },
      { tool_name: 'Grep', tool_input: { pattern: 'git push' }, cwd: '/repo' },
      { tool_name: 'WebFetch', tool_input: { url: 'https://example.com' }, cwd: '/repo' },
    ]) {
      const { code, out } = await hook('claude', payload, d);
      expect(code).toBe(0);
      expect(out).toEqual([]);
    }
    expect(calls).toEqual([]);
  });

  it('denies edits to .jurator/', async () => {
    for (const payload of [
      { tool_name: 'Edit', tool_input: { file_path: '/repo/.jurator/rules.json', old_string: 'a', new_string: 'b' }, cwd: '/repo' },
      { tool_name: 'Write', tool_input: { file_path: '.jurator/promises/privacy.json', content: '{}' }, cwd: '/repo' },
      { tool_name: 'MultiEdit', tool_input: { file_path: '/repo/.jurator/config.json', edits: [] }, cwd: '/repo' },
      bash('rm -rf .jurator/rules.json'),
      bash("echo '{}' > .jurator/rules.json"),
      bash('sed -i "" s/block/monitor/ .jurator/config.json'),
    ]) {
      const { out } = await hook('claude', payload, deps(null));
      expect(out).toHaveLength(1);
      const answer = JSON.parse(out[0] as string) as { hookSpecificOutput: Record<string, string> };
      expect(answer.hookSpecificOutput.permissionDecision).toBe('deny');
      expect(answer.hookSpecificOutput.permissionDecisionReason).toContain('.jurator/');
    }
  });

  it('denies git push --no-verify without running a check', async () => {
    const calls: string[] = [];
    const { out } = await hook('claude', bash('git push --no-verify origin HEAD'), deps(fakeRun([holdsResult()]), calls));
    expect(JSON.parse(out[0] as string).hookSpecificOutput.permissionDecision).toBe('deny');
    expect(calls).toEqual([]);
  });

  it('fails open on bad input and internal errors', async () => {
    const out: string[] = [];
    expect(await runAgentHook('claude', 'not json', '/repo', deps(null), { out: (l) => out.push(l), err: () => {} })).toBe(0);
    const broken = { ...deps(null), check: async () => Promise.reject(new Error('git exploded')) };
    const r = await hook('claude', bash('git push'), broken);
    expect(r.code).toBe(0);
    expect(r.out).toEqual([]);
    expect(r.err.join('\n')).toContain('allowing it');
  });

  it('allows when the repo has no .jurator/', async () => {
    const { out } = await hook('claude', bash('git push'), deps(null));
    expect(out).toEqual([]);
  });
});

describe('Muse Code PreToolUse hook', () => {
  it('denies a push through the shell tool with the same JSON shape', async () => {
    const payload = { hook_event_name: 'PreToolUse', tool_name: 'shell', tool_input: { command: ['git', 'push'] }, cwd: '/repo', session_id: 's' };
    const { out } = await hook('muse', payload, deps(fakeRun([brokenSecurityResult()])));
    const answer = JSON.parse(out[0] as string) as { hookSpecificOutput: Record<string, string> };
    expect(Object.keys(answer)).toEqual(['hookSpecificOutput']);
    expect(Object.keys(answer.hookSpecificOutput).sort()).toEqual(['hookEventName', 'permissionDecision', 'permissionDecisionReason']);
    expect(answer.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(answer.hookSpecificOutput.permissionDecisionReason?.length).toBeGreaterThan(0);
  });

  it('denies a patch that touches .jurator/', async () => {
    const patch = '*** Begin Patch\n*** Update File: .jurator/rules.json\n@@\n-x\n+y\n*** End Patch';
    const { out } = await hook('muse', { tool_name: 'apply_patch', tool_input: { input: patch }, cwd: '/repo' }, deps(null));
    expect(JSON.parse(out[0] as string).hookSpecificOutput.permissionDecision).toBe('deny');
  });
});

describe('decideToolUse', () => {
  it('checks the directory named by git -C', async () => {
    const seen: string[] = [];
    const event: ToolEvent = { toolName: 'Bash', toolInput: { command: 'git -C sub push' }, cwd: '/repo' };
    await decideToolUse(event, {
      async checkPush(dir) {
        seen.push(dir);
        return { run: null, runPath: null };
      },
    });
    expect(seen).toEqual(['/repo/sub']);
  });
});

describe('analyzeShell', () => {
  it('finds pushes behind env vars, cd and chains', () => {
    expect(analyzeShell('cd app && GIT_TRACE=1 git push -u origin x')).toMatchObject({ pushes: true, pushDir: 'app', skipsHooks: false });
    expect(analyzeShell('git -c core.hooksPath=/dev/null push')).toMatchObject({ pushes: true, skipsHooks: true });
    expect(analyzeShell('echo "git push" > notes.txt')).toMatchObject({ pushes: false, writesJurator: false });
    expect(analyzeShell('git status; git log --oneline 2>&1 | head')).toMatchObject({ pushes: false });
  });
  it('flags writes to .jurator/ but not reads', () => {
    expect(analyzeShell('cat .jurator/rules.json').writesJurator).toBe(false);
    expect(analyzeShell('cp .jurator/rules.json /tmp/r.json').writesJurator).toBe(false);
    expect(analyzeShell('cp /tmp/r.json .jurator/rules.json').writesJurator).toBe(true);
    expect(analyzeShell('git checkout -- .jurator').writesJurator).toBe(true);
    expect(analyzeShell('jq . .jurator/rules.json | tee .jurator/rules.json').writesJurator).toBe(true);
  });
});
