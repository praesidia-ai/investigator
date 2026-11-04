// scripts/make-demo-repo.sh builds the demo repo from examples/acme-notes (main + the two planted breaks, the same
// shas on every build), and the folders that ship with the repo name no local home path.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '../..');
const SCRIPT = join(ROOT, 'scripts/make-demo-repo.sh');
const tmp = mkdtempSync(join(tmpdir(), 'kw-demo-repo-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function build(name: string): string {
  const dir = join(tmp, name);
  execFileSync('bash', [SCRIPT, '-q', dir], { stdio: 'pipe' });
  return dir;
}

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
}

const heads = (dir: string) => git(dir, 'for-each-ref', '--format=%(refname:short) %(objectname)', 'refs/heads');

describe('scripts/make-demo-repo.sh', () => {
  it('builds main and the two planted-break branches, and leaves main checked out and clean', () => {
    const dir = build('one');
    expect(git(dir, 'for-each-ref', '--format=%(refname:short)', 'refs/heads').split('\n').sort()).toEqual([
      'agent/retention',
      'feature/csv-export',
      'main',
    ]);
    expect(git(dir, 'branch', '--show-current')).toBe('main');
    expect(git(dir, 'status', '--porcelain')).toBe('');
    expect(git(dir, 'ls-files')).not.toContain('branches/');
    expect(git(dir, 'ls-files')).toContain('policies/praesidia-support-agent.json');

    for (const branch of ['feature/csv-export', 'agent/retention']) {
      expect(git(dir, 'rev-list', '--count', `main..${branch}`)).toBe('1');
      expect(git(dir, 'merge-base', 'main', branch)).toBe(git(dir, 'rev-parse', 'main'));
    }
    expect(git(dir, 'diff', '--name-only', 'main', 'feature/csv-export')).toBe('src/routes/export.ts');
    expect(git(dir, 'diff', 'main', 'feature/csv-export')).toContain("+router.get('/export.csv'");
    expect(git(dir, 'diff', '--name-only', 'main', 'agent/retention')).toBe('src/agent/chats.ts');
    expect(git(dir, 'show', 'main:src/agent/chats.ts')).toContain('CHAT_TTL_DAYS = 30;');
    expect(git(dir, 'show', 'agent/retention:src/agent/chats.ts')).toContain('CHAT_TTL_DAYS = 90;');
  });

  it('gives the same commit shas on every build', () => {
    expect(heads(build('two'))).toBe(heads(build('three')));
  });

  it('refuses a folder that is not empty', () => {
    const dir = build('four');
    expect(() => execFileSync('bash', [SCRIPT, '-q', dir], { stdio: 'pipe' })).toThrow();
  });
});

describe('published folders', () => {
  it('name no local home path (/Users/...)', () => {
    const hits: string[] = [];
    const visit = (path: string): void => {
      if (statSync(path).isDirectory()) {
        for (const entry of readdirSync(path)) visit(join(path, entry));
        return;
      }
      readFileSync(path, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (line.includes('/Users/')) hits.push(`${relative(ROOT, path)}:${i + 1}`);
        });
    };
    for (const top of ['scripts', 'docs', 'README.md', 'fixtures', 'templates', 'src', 'examples']) visit(join(ROOT, top));
    expect(hits).toEqual([]);
  });
});
