// R4-WS: multi-repo workspaces. A temp folder holds the acme-notes demo repo and a tiny second repo plus policies/;
// init -> compile (scripted) -> check -> a change in the second repo -> check --diff, all in-process, no network.
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import accept from '../../src/cli/commands/accept.js';
import check from '../../src/cli/commands/check.js';
import compile from '../../src/cli/commands/compile.js';
import init from '../../src/cli/commands/init.js';
import status from '../../src/cli/commands/status.js';
import verify from '../../src/cli/commands/verify.js';
import type { Command } from '../../src/cli/context.js';
import type { CheckRun, Config, Rule } from '../../src/contracts.js';
import { compositeOf, isWorkspaceRepo, openRepo, openSingleRepo } from '../../src/git/index.js';
import { makeStyle } from '../../src/util/term.js';
import { findRepoRoot, openStore } from '../../src/workspace/index.js';
import { detectRepoCodeScope, detectWorkspaceRepos, expandRepoGlobs, isProductCode } from '../../src/workspace/multi.js';

const ROOT = join(import.meta.dirname, '../..');
const SCRIPTED = join(ROOT, 'fixtures/scripted/acme');

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
  });
}

async function run(cmd: Command, cwd: string, argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await cmd.run({
    cwd,
    argv,
    env: { PATH: process.env.PATH ?? '' },
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    style: makeStyle(false),
    now: () => new Date(),
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

const RULE: Rule = {
  id: 'R-privacy.01-1',
  promiseId: 'privacy.01',
  description: 'Chat TTL constants stay at 30 days or less',
  mode: 'must-not-match',
  pattern: 'TTL_DAYS\\s*=\\s*(?:3[1-9]|[4-9]\\d|\\d{3,})\\b',
  // Unprefixed on purpose: in a workspace it means "in every repo".
  globs: ['src/**'],
  provenBy: { mutation: 'set to 90', failedAsExpected: true, at: '2026-11-04T08:00:00.000Z' },
  status: 'accepted',
  author: 'human',
  createdAt: '2026-11-04T08:00:00.000Z',
};

describe('multi-repo workspace end to end', () => {
  let tmp: string;
  let ws: string;
  let widget: string;
  let firstRun: CheckRun;

  beforeAll(() => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), 'jurator-ws-')));
    ws = join(tmp, 'investigator');
    mkdirSync(join(ws, 'policies'), { recursive: true });
    execFileSync('bash', [join(ROOT, 'scripts/make-demo-repo.sh'), '-q', join(ws, 'acme-notes')]);
    cpSync(join(ROOT, 'examples/acme-notes/docs/privacy.md'), join(ws, 'policies/privacy.md'));
    cpSync(join(ROOT, 'examples/acme-notes/docs/security.md'), join(ws, 'policies/security.md'));
    widget = join(ws, 'widget');
    mkdirSync(join(widget, 'src'), { recursive: true });
    mkdirSync(join(widget, 'tests'), { recursive: true });
    writeFileSync(join(widget, 'src/chats.ts'), 'export const WIDGET_CHAT_TTL_DAYS = 30;\n');
    writeFileSync(join(widget, 'src/panel.ts'), "export const panel = 'memory only';\n");
    writeFileSync(join(widget, 'tests/chats.test.ts'), "import '../src/chats.js';\n");
    git(widget, 'init', '-q', '-b', 'main');
    git(widget, 'add', '-A');
    git(widget, 'commit', '-qm', 'widget 1.0');
  }, 60_000);
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  it('detects the folder as a workspace of two repos', async () => {
    expect(await detectWorkspaceRepos(ws)).toEqual([
      { name: 'acme-notes', path: 'acme-notes' },
      { name: 'widget', path: 'widget' },
    ]);
    // A code repo is never a workspace, even with a stray clone inside.
    expect(await detectWorkspaceRepos(widget)).toEqual([]);
  });

  it('init makes the folder a git repo with prefixed code scope and policies/ sources', async () => {
    const r = await run(init, ws, ['--json']);
    expect(r.code).toBe(0);
    const out = JSON.parse(r.out) as { sources: Array<{ alias: string; locator: string }>; codeScope: string[]; workspace: { gitInit: boolean } };
    expect(out.workspace.gitInit).toBe(true);
    expect(out.sources.map((s) => `${s.alias}=${s.locator}`)).toEqual(['privacy=policies/privacy.md', 'security=policies/security.md']);
    expect(out.codeScope).toEqual(['acme-notes/src/**', 'widget/src/**']);
    expect(existsSync(join(ws, '.git'))).toBe(true);
    expect(readFileSync(join(ws, '.gitignore'), 'utf8')).toContain('/acme-notes/\n/widget/\n');
    const config = JSON.parse(readFileSync(join(ws, '.jurator/config.json'), 'utf8')) as Config;
    expect(config.repos).toEqual([
      { name: 'acme-notes', path: 'acme-notes' },
      { name: 'widget', path: 'widget' },
    ]);
    // The code repos are not part of the workspace repo.
    expect(git(ws, 'status', '--porcelain')).not.toContain('widget');
    // A second init changes nothing.
    await expect(run(init, ws, [])).rejects.toThrow(/already exists/u);
  });

  it('finds the workspace from inside a code repo and opens the multi-repo view', async () => {
    expect(await findRepoRoot(join(widget, 'src'))).toBe(ws);
    const repo = await openRepo(ws);
    expect(isWorkspaceRepo(repo)).toBe(true);
    const snap = await repo.snapshot();
    const acmeHead = (await openSingleRepo(join(ws, 'acme-notes'))).resolve('HEAD');
    const widgetHead = (await openSingleRepo(widget)).resolve('HEAD');
    const commits = [
      { name: 'acme-notes', commit: await acmeHead },
      { name: 'widget', commit: await widgetHead },
    ];
    expect(snap.commit).toBe(compositeOf(commits));
    expect(snap.repos?.map((r) => r.name)).toEqual(['acme-notes', 'widget']);
    expect(snap.branch).toBe('main');
    expect(await repo.resolve('HEAD')).toBe(snap.commit);
    expect(await repo.listFiles(snap.commit, ['widget/src/**'])).toEqual(['widget/src/chats.ts', 'widget/src/panel.ts']);
    expect(await repo.readFile(snap.commit, 'widget/src/chats.ts')).toContain('= 30');
    await expect(repo.readFile(snap.commit, 'src/chats.ts')).rejects.toThrow(/not in any repo/u);
    expect(existsSync(join(ws, '.jurator/local/snapshots', `${snap.commit}.json`))).toBe(true);
  });

  it('compiles (scripted), checks with a rule, and verifies the record', async () => {
    const c = await run(compile, join(widget, 'src'), ['--scripted', SCRIPTED]);
    expect(c.code).toBe(0);
    expect((await run(accept, ws, ['--all'])).code).toBe(0);
    const store = openStore(ws);
    await store.writeRules([RULE]);
    expect((await store.readRules())[0]?.globs).toEqual(['acme-notes/src/**', 'widget/src/**']);

    const r = await run(check, ws, ['--no-ai', '--json']);
    expect(r.code).toBe(0);
    firstRun = JSON.parse(r.out) as CheckRun;
    expect(firstRun.results.find((x) => x.promiseId === 'privacy.01')?.verdict).toBe('holds');
    expect(firstRun.snapshot.repos).toHaveLength(2);
    expect(Object.keys(firstRun.repoCommits ?? {})).toContain(firstRun.snapshot.commit);

    const s = await run(status, ws, ['--json']);
    const st = JSON.parse(s.out) as { workspace?: { repos: Array<{ name: string }> }; verified: { codeChanged: boolean } };
    expect(st.workspace?.repos.map((x) => x.name)).toEqual(['acme-notes', 'widget']);
    expect(st.verified.codeChanged).toBe(false);
  });

  it('a change in the second repo: check --diff last, per repo, and a ref only one repo has', async () => {
    writeFileSync(join(widget, 'src/chats.ts'), 'export const WIDGET_CHAT_TTL_DAYS = 90;\n');
    git(widget, 'commit', '-qam', 'keep chats for 90 days');

    const r = await run(check, ws, ['--diff', 'last', '--no-ai', '--json']);
    expect(r.code).toBe(1);
    const diffRun = JSON.parse(r.out) as CheckRun;
    expect(diffRun.target.changedFiles).toEqual(['widget/src/chats.ts']);
    const broken = diffRun.results.find((x) => x.promiseId === 'privacy.01');
    expect(broken?.verdict).toBe('broken');
    expect(broken?.citations[0]).toMatchObject({ path: 'widget/src/chats.ts', startLine: 1, commit: diffRun.snapshot.commit });
    expect(diffRun.snapshot.commit).not.toBe(firstRun.snapshot.commit);
    expect(Object.keys(diffRun.repoCommits ?? {}).sort()).toEqual([diffRun.snapshot.commit, firstRun.snapshot.commit].sort());

    // verify re-reads the citation through the composite map embedded in the record, even with no local snapshots.
    const runFile = join(ws, '.jurator/local/runs', diffRun.id, 'run.json');
    rmSync(join(ws, '.jurator/local/snapshots'), { recursive: true, force: true });
    const v = await run(verify, ws, [runFile]);
    expect(v.code).toBe(0);
    expect(v.out).toMatch(/1 code quote/u);

    // Per repo: only widget moves back one commit.
    const per = JSON.parse((await run(check, ws, ['--diff', 'widget=HEAD~1', '--no-ai', '--json', '--full'])).out) as CheckRun;
    expect(per.target.changedFiles).toEqual(['widget/src/chats.ts']);
    // acme-notes has a single commit, so HEAD~1 applies to widget only; acme-notes uses its last verified commit.
    const shared = JSON.parse((await run(check, ws, ['--diff', 'HEAD~1', '--no-ai', '--json', '--full'])).out) as CheckRun;
    expect(shared.target.changedFiles).toEqual(['widget/src/chats.ts']);
    await expect(run(check, ws, ['--diff', 'no-such-branch', '--no-ai'])).rejects.toThrow(/No repo in this workspace knows/u);
    await expect(run(check, ws, ['--diff', 'nope=HEAD', '--no-ai'])).rejects.toThrow(/repo=ref/u);
  });
});

describe('workspace helpers', () => {
  it('infers where product code lives from tracked files', () => {
    const files = [
      ...Array.from({ length: 12 }, (_, i) => `ai-mode/src/panel/p${i}.ts`),
      'ai-mode/build.mjs',
      'ai-mode/test/panel.test.ts',
      'ai-mode/scripts/release.mjs',
      'src/contentScript/a.ts',
      'src/api/b.ts',
      'config/webpack.config.js',
      'config/paths.js',
      'public/frames/x.js',
      'pack.js',
      'tailwind.config.js',
    ];
    expect(detectRepoCodeScope(files)).toEqual(['ai-mode/src/**', 'src/**']);
    const py = [
      ...Array.from({ length: 30 }, (_, i) => `src/core/m${i}.py`),
      ...Array.from({ length: 10 }, (_, i) => `workers/w${i}.py`),
      ...Array.from({ length: 5 }, (_, i) => `load_tests/l${i}.py`),
      ...Array.from({ length: 20 }, (_, i) => `tests/test_${i}.py`),
      'run_e2e_tests.py',
    ];
    expect(detectRepoCodeScope(py)).toEqual(['src/**', 'workers/**']);
    expect(detectRepoCodeScope(['main.go', 'handlers.go'])).toEqual(['*.go']);
    expect(isProductCode('src/core/test_cache.py')).toBe(false);
    expect(isProductCode('src/latest/cache.py')).toBe(true);
  });

  it('expands unprefixed globs to every repo', () => {
    expect(expandRepoGlobs(['src/**', 'api/src/**', '**/*.ts', './lib/x.ts'], ['api', 'web'])).toEqual([
      'api/src/**',
      'web/src/**',
      '**/*.ts',
      'api/lib/x.ts',
      'web/lib/x.ts',
    ]);
  });
});
