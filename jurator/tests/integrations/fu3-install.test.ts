// FU-3: `hook install ... --fail-closed` writes hooks that block when the check cannot run.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installHook } from '../../src/integrations/index.js';

const missing = { node: '/nonexistent/node', bin: '/nonexistent/dist/bin.js' };
let repo = '';
beforeEach(() => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'kw-fu3-')));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

function runHook(path: string, env: Record<string, string> = {}) {
  return spawnSync('/bin/sh', [path, 'origin', 'url'], { input: '', encoding: 'utf8', env: { PATH: '/usr/bin:/bin', ...env } });
}

describe('hook install --fail-closed', () => {
  it('pre-push: blocks when the tool cannot run; the default warns and lets it through', async () => {
    const hooksDir = join(repo, '.git', 'hooks');
    const closed = await installHook('pre-push', { repoRoot: repo, hooksDir, launcher: missing, failClosed: true });
    const text = readFileSync(closed.path, 'utf8');
    expect(text).toContain('JURATOR_FAIL_CLOSED=1');
    expect(text).toContain('hook run pre-push "$@"');
    expect(text).not.toMatch(/\{\{/u);
    expect(closed.lines.join('\n')).toContain('Fail-closed');
    const r = runHook(closed.path);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('blocked (fail-closed is on)');

    rmSync(closed.path);
    const open = await installHook('pre-push', { repoRoot: repo, hooksDir, launcher: missing });
    const o = runHook(open.path);
    expect(o.status).toBe(0);
    expect(o.stderr).toContain('WARNING');
    // the env still turns it on for a default install
    expect(runHook(open.path, { JURATOR_FAIL_CLOSED: '1' }).status).toBe(1);
  });

  it('agent hooks: the command carries --fail-closed; the marker still finds it', async () => {
    const claude = await installHook('claude', { repoRoot: repo, hooksDir: null, launcher: missing, failClosed: true });
    const settings = JSON.parse(readFileSync(claude.path, 'utf8'));
    expect(settings.hooks.PreToolUse[0].hooks[0].command).toMatch(/hook run claude --fail-closed$/u);
    expect((await installHook('claude', { repoRoot: repo, hooksDir: null, launcher: missing })).status).toBe('already');
    const muse = await installHook('muse', { repoRoot: repo, hooksDir: null, launcher: missing });
    const file = JSON.parse(readFileSync(muse.path, 'utf8'));
    expect(file.hooks.PreToolUse[0].hooks[0].command).toMatch(/hook run muse$/u);
    expect(file.hooks.PreToolUse[0].hooks[0].statusMessage).not.toContain('{{');
  });
});
