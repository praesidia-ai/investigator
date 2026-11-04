import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agentPushTarget, choosePushTarget, gitHooksDir, installHook, makeHookGit, shellQuote, stableNodePath } from '../../src/integrations/index.js';

const launcher = { node: '/usr/local/bin/node', bin: "/opt/key word/it's/dist/bin.js" };
let repo = '';

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } }).trim();
}

beforeEach(() => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'kw-hooks-')));
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'T');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(repo, 'a.txt'), 'one\n');
  git('add', '.');
  git('commit', '-q', '-m', 'one');
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

describe('hook install', () => {
  it('writes an executable pre-push hook once, and never replaces someone else\'s', async () => {
    const hooksDir = await gitHooksDir(repo);
    expect(hooksDir).toBe(join(repo, '.git', 'hooks'));
    const first = await installHook('pre-push', { repoRoot: repo, hooksDir, launcher });
    expect(first.status).toBe('installed');
    const text = readFileSync(first.path, 'utf8');
    expect(text.startsWith('#!/bin/sh')).toBe(true);
    expect(text).toContain(`JURATOR_BIN=${shellQuote(launcher.bin)}`);
    expect(text).toContain('hook run pre-push "$@"');
    expect(statSync(first.path).mode & 0o111).not.toBe(0);
    expect((await installHook('pre-push', { repoRoot: repo, hooksDir, launcher })).status).toBe('already');

    writeFileSync(first.path, '#!/bin/sh\nmake lint\n');
    const manual = await installHook('pre-push', { repoRoot: repo, hooksDir, launcher });
    expect(manual.status).toBe('manual');
    expect(readFileSync(first.path, 'utf8')).toBe('#!/bin/sh\nmake lint\n');
    expect(manual.lines.join('\n')).toContain('hook run pre-push "$@" || exit 1');
  });

  it('merges a Claude Code PreToolUse hook into existing settings without clobbering', async () => {
    mkdirSync(join(repo, '.claude'));
    const existing = {
      permissions: { allow: ['Bash(npm test)'] },
      hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo hi' }] }], Stop: [] },
    };
    writeFileSync(join(repo, '.claude', 'settings.json'), JSON.stringify(existing));
    const result = await installHook('claude', { repoRoot: repo, hooksDir: null, launcher });
    expect(result.status).toBe('installed');
    const merged = JSON.parse(readFileSync(join(repo, '.claude', 'settings.json'), 'utf8'));
    expect(merged.permissions).toEqual(existing.permissions);
    expect(merged.hooks.Stop).toEqual([]);
    expect(merged.hooks.PreToolUse).toHaveLength(2);
    expect(merged.hooks.PreToolUse[0]).toEqual(existing.hooks.PreToolUse[0]);
    expect(merged.hooks.PreToolUse[1].matcher).toBe('Bash|Edit|Write|MultiEdit|NotebookEdit');
    expect(merged.hooks.PreToolUse[1].hooks[0].command).toBe(`${shellQuote(launcher.node)} ${shellQuote(launcher.bin)} hook run claude`);
    expect((await installHook('claude', { repoRoot: repo, hooksDir: null, launcher })).status).toBe('already');
  });

  it('writes .claude/settings.local.json with --local and refuses a broken settings file', async () => {
    const local = await installHook('claude', { repoRoot: repo, hooksDir: null, launcher, local: true });
    expect(local.path).toBe(join(repo, '.claude', 'settings.local.json'));
    writeFileSync(join(repo, '.claude', 'settings.json'), '{ not json');
    await expect(installHook('claude', { repoRoot: repo, hooksDir: null, launcher })).rejects.toThrow(/not a JSON object/u);
    expect(readFileSync(join(repo, '.claude', 'settings.json'), 'utf8')).toBe('{ not json');
  });

  it('writes a Muse Code project hook file with only documented handler fields', async () => {
    const result = await installHook('muse', { repoRoot: repo, hooksDir: null, launcher });
    expect(result.path).toBe(join(repo, '.muse', 'hooks.json'));
    const file = JSON.parse(readFileSync(result.path, 'utf8'));
    const handler = file.hooks.PreToolUse[0].hooks[0];
    expect(Object.keys(handler).sort()).toEqual(['command', 'statusMessage', 'timeout', 'type']);
    expect(handler.type).toBe('command');
    expect(Number.isInteger(handler.timeout)).toBe(true);
    expect(handler.command).toContain('hook run muse');
  });
});

describe('hook git reads on a real repo', () => {
  it('picks main...HEAD for an agent push and the merge-base for a new pushed branch', async () => {
    const base = git('rev-parse', 'HEAD');
    git('checkout', '-q', '-b', 'feature');
    writeFileSync(join(repo, 'b.txt'), 'two\n');
    git('add', '.');
    git('commit', '-q', '-m', 'two');
    const head = git('rev-parse', 'HEAD');
    const hg = makeHookGit(repo);
    expect(await agentPushTarget(hg)).toEqual({ kind: 'diff', base, head });
    const update = { localRef: 'refs/heads/feature', localSha: head, remoteRef: 'refs/heads/feature', remoteSha: '0'.repeat(40) };
    expect(await choosePushTarget(update, hg, 'origin')).toEqual({ kind: 'diff', base, head });
    expect(await hg.resolveCommit('f'.repeat(40))).toBeNull();
  });
});

describe('stableNodePath', () => {
  it('prefers a PATH entry that is the same binary, else keeps execPath', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'kw-node-')));
    const real = join(dir, 'real-node');
    writeFileSync(real, '');
    mkdirSync(join(dir, 'bin'));
    symlinkSync(real, join(dir, 'bin', 'node'));
    expect(stableNodePath(real, `/nope:${join(dir, 'bin')}`)).toBe(join(dir, 'bin', 'node'));
    expect(stableNodePath(real, '/nope')).toBe(real);
    rmSync(dir, { recursive: true, force: true });
  });
});
