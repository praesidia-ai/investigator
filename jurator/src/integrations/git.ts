// Owner: WP-D. The few git reads the hooks need, through the git CLI (execFile, never a shell).
import { execFile } from 'node:child_process';
import { isAbsolute, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { HookGit } from './prepush.js';

const run = promisify(execFile);

async function git(cwd: string, args: readonly string[]): Promise<string | null> {
  try {
    const { stdout } = await run('git', [...args], { cwd, maxBuffer: 4 * 1024 * 1024 });
    return stdout.trim();
  } catch {
    return null;
  }
}

export function makeHookGit(cwd: string): HookGit {
  return {
    async resolveCommit(ref) {
      const sha = await git(cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
      return sha && /^[0-9a-f]{40,64}$/u.test(sha) ? sha : null;
    },
    async mergeBase(a, b) {
      const sha = await git(cwd, ['merge-base', a, b]);
      return sha && /^[0-9a-f]{40,64}$/u.test(sha) ? sha : null;
    },
  };
}

/** Repo top level for `cwd`, or null outside a git repo. */
export async function gitTopLevel(cwd: string): Promise<string | null> {
  const top = await git(cwd, ['rev-parse', '--show-toplevel']);
  return top && top.length > 0 ? top : null;
}

/** Where git looks for hooks: core.hooksPath when set, else the (common) .git/hooks folder. */
export async function gitHooksDir(cwd: string): Promise<string | null> {
  const top = await gitTopLevel(cwd);
  if (!top) return null;
  const configured = await git(top, ['config', '--get', 'core.hooksPath']);
  if (configured) return isAbsolute(configured) ? configured : resolve(top, configured);
  const hooks = await git(top, ['rev-parse', '--git-common-dir']);
  if (!hooks) return null;
  return resolve(top, hooks, 'hooks');
}
