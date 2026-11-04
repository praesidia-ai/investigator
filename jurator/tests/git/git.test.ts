import { writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { BlobReader, isDirty, openRepo } from '../../src/git/index.js';
import { cleanup, git, makeRepo, tempDir, writeFiles } from './helpers.js';

const root = makeRepo({ 'src/a.ts': 'a\n', 'src/deep/b.ts': 'b\nline2\n', 'docs/x.md': 'x\n', 'weird name.ts': 'w\n' });
git(root, 'checkout', '-q', '-b', 'feature');
writeFiles(root, { 'src/new.ts': 'new\n', 'src/a.ts': 'a changed\n' });
git(root, 'add', '-A');
git(root, 'commit', '-q', '-m', 'feature');
git(root, 'checkout', '-q', 'main');
const plain = tempDir('kw-plain-');

afterAll(() => cleanup(root, plain));

describe('openRepo', () => {
  it('fails outside a git repo', async () => {
    await expect(openRepo(plain)).rejects.toMatchObject({ code: 'NOT_A_GIT_REPO' });
  });

  it('finds the root from a subfolder', async () => {
    const repo = await openRepo(join(root, 'src', 'deep'));
    expect(repo.root).toBe(root);
  });

  it('snapshots branch, commit and dirty state', async () => {
    const repo = await openRepo(root);
    const snap = await repo.snapshot();
    expect(snap).toEqual({ repo: basename(root), branch: 'main', commit: git(root, 'rev-parse', 'HEAD'), dirty: false });
    writeFileSync(join(root, '.env'), 'SECRET=1\n');
    expect((await repo.snapshot()).dirty).toBe(true);
    // Untracked files are never listed: reads come from git objects.
    expect(await repo.listFiles('HEAD', ['**'])).not.toContain('.env');
    cleanup(join(root, '.env'));
  });

  it('ignores untracked .jurator/, .claude/ and .muse/ in the dirty state', async () => {
    const repo = await openRepo(root);
    writeFiles(root, { '.claude/settings.json': '{}\n', '.jurator/config.json': '{}\n', '.muse/hooks.json': '{}\n' });
    expect((await repo.snapshot()).dirty).toBe(false);
    writeFiles(root, { 'src/a.ts': 'a edited\n' });
    expect((await repo.snapshot()).dirty).toBe(true);
    git(root, 'checkout', '-q', '--', 'src/a.ts');
    cleanup(join(root, '.claude'), join(root, '.jurator'), join(root, '.muse'));
    expect((await repo.snapshot()).dirty).toBe(false);
  });

  it('isDirty: only untracked tool folders are ignored', () => {
    expect(isDirty('')).toBe(false);
    expect(isDirty('?? .claude/\0?? .jurator/\0?? .muse/settings.json\0')).toBe(false);
    expect(isDirty('?? .claudeish/x\0')).toBe(true);
    expect(isDirty(' M .claude/settings.json\0')).toBe(true);
    expect(isDirty('?? src/new.ts\0')).toBe(true);
    expect(isDirty('R  .claude/b\0src/a.ts\0')).toBe(true);
  });

  it('reports a detached HEAD as branch null', async () => {
    const repo = await openRepo(root);
    git(root, 'checkout', '-q', '--detach', 'HEAD');
    expect((await repo.snapshot()).branch).toBeNull();
    git(root, 'checkout', '-q', 'main');
  });

  it('resolves refs and rejects unknown or option-like ones', async () => {
    const repo = await openRepo(root);
    expect(await repo.resolve('feature')).toBe(git(root, 'rev-parse', 'feature'));
    await expect(repo.resolve('no-such-branch')).rejects.toMatchObject({ code: 'UNKNOWN_REF' });
    await expect(repo.resolve('--all')).rejects.toMatchObject({ code: 'UNKNOWN_REF' });
  });

  it('lists tracked files by glob, sorted', async () => {
    const repo = await openRepo(root);
    expect(await repo.listFiles('HEAD', ['src/**'])).toEqual(['src/a.ts', 'src/deep/b.ts']);
    expect(await repo.listFiles('feature', ['src/*.ts'])).toEqual(['src/a.ts', 'src/new.ts']);
    expect(await repo.listFiles('HEAD', ['*.ts'])).toEqual(['weird name.ts']);
    expect(await repo.listFiles('HEAD', [])).toEqual([]);
  });

  it('reads a file at a commit, not from disk', async () => {
    const repo = await openRepo(root);
    expect(await repo.readFile('feature', 'src/a.ts')).toBe('a changed\n');
    expect(await repo.readFile('main', 'src/a.ts')).toBe('a\n');
    expect(await repo.readFile('main', 'weird name.ts')).toBe('w\n');
    await expect(repo.readFile('main', 'src/new.ts')).rejects.toMatchObject({ code: 'FILE_NOT_IN_COMMIT' });
  });

  it('reads many files through one cat-file process, in order, with misses and folders (FX-4)', async () => {
    const many: Record<string, string> = {};
    for (let i = 0; i < 300; i += 1) many[`pkg/f${i}.ts`] = `export const v${i} = ${i};\n${'x'.repeat(i * 37)}\n`;
    many['pkg/empty.ts'] = '';
    many['pkg/utf8.ts'] = 'const s = "café ✓";\n';
    const big = makeRepo(many);
    const repo = await openRepo(big);
    const head = await repo.resolve('HEAD');
    const paths = Object.keys(many);
    // Parallel and sequential reads both come back with the right text.
    const texts = await Promise.all(paths.map((p) => repo.readFile(head, p)));
    expect(texts).toEqual(paths.map((p) => many[p]));
    for (const p of paths.slice(0, 20)) expect(await repo.readFile('HEAD', p)).toBe(many[p]);
    await expect(repo.readFile(head, 'pkg/missing.ts')).rejects.toMatchObject({ code: 'FILE_NOT_IN_COMMIT' });
    await expect(repo.readFile(head, 'pkg')).rejects.toMatchObject({ code: 'FILE_NOT_IN_COMMIT' });
    expect(await repo.readFile(head, 'pkg/f7.ts')).toBe(many['pkg/f7.ts']);
    expect(await repo.listFiles(head, ['pkg/f1*.ts'])).toHaveLength(111);
    cleanup(big);
  });

  it('restarts the blob reader after its process is closed', async () => {
    const reader = new BlobReader(root);
    const sha = git(root, 'rev-parse', 'feature');
    expect((await reader.read(sha, 'src/a.ts'))?.toString('utf8')).toBe('a changed\n');
    reader.close();
    expect((await reader.read(sha, 'src/new.ts'))?.toString('utf8')).toBe('new\n');
    expect(await reader.read(sha, 'nope.ts')).toBeNull();
    reader.close();
  });

  it('lists files changed between base and head', async () => {
    const repo = await openRepo(root);
    expect(await repo.changedFiles('main', 'feature')).toEqual(['src/a.ts', 'src/new.ts']);
    expect(await repo.changedFiles('main', 'main')).toEqual([]);
  });
});
