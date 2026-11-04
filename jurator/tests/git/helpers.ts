// Shared by WP-W tests: temp git repos (never the network, never a real repo).
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { CommandContext } from '../../src/cli/context.js';
import { makeStyle } from '../../src/util/term.js';

export function tempDir(prefix = 'kw-'): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

export function writeFiles(root: string, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
}

/** A repo with one commit on `main` containing `files`. */
export function makeRepo(files: Record<string, string>): string {
  const root = tempDir();
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'commit.gpgsign', 'false');
  writeFiles(root, files);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'init');
  return root;
}

export function cleanup(...dirs: string[]): void {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
}

export const ACME_FILES: Record<string, string> = {
  'docs/privacy.md': '# Privacy\n\n1. Support chats are deleted after 30 days.\n',
  'docs/security.md': '# Security\n\n1. Only admins can export notes.\n',
  'docs/README.md': '# Docs\n',
  'AGENTS.md': '# Agents\n',
  'policies/praesidia-support-agent.json': `${JSON.stringify(
    {
      name: 'Support agent policy',
      version: 7,
      enforcementMode: 'enforce',
      dataRetentionDays: 90,
      allowedTools: ['search_notes', 'export_notes'],
      requireApproval: true,
      blockPii: true,
    },
    null,
    2,
  )}\n`,
  'policies/other.json': '{"hello": 1}\n',
  'src/routes/notes.ts': 'export const notes = 1;\n',
};

export interface FakeCtx {
  readonly ctx: CommandContext;
  readonly out: string[];
  readonly err: string[];
}

export function fakeCtx(cwd: string, argv: string[] = [], env: NodeJS.ProcessEnv = {}): FakeCtx {
  const out: string[] = [];
  const err: string[] = [];
  const ctx: CommandContext = {
    cwd,
    argv,
    env,
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    style: makeStyle(false),
    now: () => new Date('2026-11-04T05:00:00.000Z'),
  };
  return { ctx, out, err };
}
