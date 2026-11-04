// Owner: R4-WS. Multi-repo workspaces: a folder holding several git repos (`investigator/` with `backend-api/`
// and `chrome-extension/`) plus `policies/`. The folder becomes its own git repo for .jurator/ and policies/; the code
// repos stay separate and are listed in config `repos`. Filesystem and git only, no AI.
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { extname, join, relative, resolve, sep } from 'node:path';
import { BRAND } from '../brand.js';
import { openSingleRepo, REPO_NAME, runGit, type RepoRef } from '../git/index.js';
import { JuratorError } from '../util/errors.js';

const CODE_EXT = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'go', 'py', 'rb', 'java', 'kt', 'rs', 'php', 'cs', 'swift', 'ex', 'exs',
  'scala', 'vue', 'svelte', 'prisma',
]);
/** Folders that never hold the product's code: tests, docs, tooling, vendored, built or bundled output. */
const NOT_CODE_DIRS = new Set([
  'node_modules', '.git', BRAND.folder, 'dist', 'build', 'vendor', 'vendors', 'third_party', 'third-party', 'docs', 'doc',
  'test', 'tests', '__tests__', '__mocks__', 'spec', 'specs', 'e2e', 'examples', 'example', 'fixtures', 'scripts',
  'coverage', 'out', 'target', 'public', 'static', 'assets', 'bundle', 'bundles', 'generated', '__generated__',
  '__pycache__', 'site-packages', 'venv', 'env', 'storybook-static',
]);
/** `load_tests`, `e2e-tests`, `test_utils`, `integration-test`. */
const TESTISH_DIR = /^(?:.*[-_])?tests?(?:[-_].*)?$/iu;
/** Test files and bundled output by name. */
const NOT_CODE_FILE = /(?:\.(?:test|spec|stories|min|bundle)\.[a-z]+$)|(?:^test_.*\.py$)|(?:_test\.(?:py|go)$)|(?:^conftest\.py$)/iu;
/** Code roots one level down inside a package folder (`ai-mode/src`). */
const CODE_ROOTS = new Set(['src', 'app', 'lib']);
/** A top folder needs this many code files to count on its own (build glue like `config/webpack.js` does not). */
const MIN_FILES = 10;

/** Is this tracked path product code (not a test, doc, script, or vendored/built file)? */
export function isProductCode(path: string): boolean {
  const parts = path.split('/');
  const file = parts[parts.length - 1] as string;
  if (!CODE_EXT.has(extname(file).slice(1).toLowerCase())) return false;
  if (NOT_CODE_FILE.test(file)) return false;
  for (const dir of parts.slice(0, -1)) {
    if (dir.startsWith('.') || NOT_CODE_DIRS.has(dir.toLowerCase()) || TESTISH_DIR.test(dir)) return false;
  }
  return true;
}

/**
 * Where a repo's product code lives, from its tracked files (repo-relative globs, sorted). Each top folder with code
 * is `top/**`, or `top/src/**` when a package folder keeps (nearly) all its code under src/, app/ or lib/; folders with
 * fewer than 10 code files are left out unless they are src/app/lib; root files count only in a flat repo.
 */
export function detectRepoCodeScope(files: readonly string[]): string[] {
  const groups = new Map<string, string[]>();
  const rootExts = new Set<string>();
  for (const path of files) {
    if (!isProductCode(path)) continue;
    const slash = path.indexOf('/');
    if (slash < 0) {
      rootExts.add(extname(path).slice(1).toLowerCase());
      continue;
    }
    const top = path.slice(0, slash);
    const list = groups.get(top) ?? [];
    list.push(path.slice(slash + 1));
    groups.set(top, list);
  }
  const globsOf = (top: string, inner: readonly string[]): string[] => {
    if (CODE_ROOTS.has(top)) return [`${top}/**`];
    const bySub = new Map<string, number>();
    for (const p of inner) {
      const s = p.indexOf('/');
      if (s > 0 && CODE_ROOTS.has(p.slice(0, s))) bySub.set(p.slice(0, s), (bySub.get(p.slice(0, s)) ?? 0) + 1);
    }
    const covered = [...bySub.values()].reduce((a, b) => a + b, 0);
    if (covered > 0 && covered >= 0.8 * inner.length) return [...bySub.keys()].sort().map((sub) => `${top}/${sub}/**`);
    return [`${top}/**`];
  };
  const kept = [...groups.entries()].filter(([top, inner]) => CODE_ROOTS.has(top) || inner.length >= MIN_FILES);
  const chosen = kept.length > 0 ? kept : [...groups.entries()];
  const globs = chosen.flatMap(([top, inner]) => globsOf(top, inner));
  if (globs.length === 0) for (const ext of rootExts) globs.push(`*.${ext}`);
  return [...new Set(globs)].sort();
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** The git top folder `dir` is in, or null. */
async function gitTop(dir: string): Promise<string | null> {
  const out = await runGit(dir, ['rev-parse', '--show-toplevel']).catch(() => null);
  return out && out.code === 0 ? resolve(out.stdout.trim()) : null;
}

/**
 * The git repos directly inside `dir` (depth 1) that make it a workspace, sorted by name; [] when it is not one.
 *  - `dir` not in git: every child folder with its own `.git`.
 *  - `dir` is the top of a git repo that tracks no code itself (a workspace root made by init, or `git init` by hand):
 *    the child repos it does not track (not submodules).
 *  - otherwise (a code repo, or a folder inside one): [] so a single repo behaves as before.
 */
export async function detectWorkspaceRepos(dir: string): Promise<RepoRef[]> {
  const root = resolve(dir);
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const names: string[] = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules' || !REPO_NAME.test(e.name)) continue;
    if (await exists(join(root, e.name, '.git'))) names.push(e.name);
  }
  names.sort();
  if (names.length === 0) return [];
  const top = await gitTop(root);
  if (top !== null) {
    if (top !== root) return [];
    const tracked = await runGit(root, ['ls-files', '-z']);
    if (tracked.code !== 0) return [];
    const paths = tracked.stdout.split('\0').filter((p) => p.length > 0);
    if (paths.some((p) => isProductCode(p) && !names.some((n) => p.startsWith(`${n}/`)))) return [];
    const inside = new Set(paths.map((p) => p.split('/')[0] as string));
    return names.filter((n) => !inside.has(n)).map((name) => ({ name, path: name }));
  }
  return names.map((name) => ({ name, path: name }));
}

/** Parses `--repo name=path` (path relative to the workspace root, or absolute). */
export function parseRepoFlag(value: string): RepoRef {
  const m = /^([^=]+)=(.+)$/u.exec(value);
  const name = m?.[1]?.trim() ?? '';
  if (!m || !REPO_NAME.test(name)) {
    throw new JuratorError('BAD_ARGS', `--repo "${value}" should look like name=path, e.g. chrome-extension=./chrome-extension.`);
  }
  return { name, path: (m[2] as string).trim() };
}

export interface RepoInfo {
  readonly name: string;
  readonly path: string;
  readonly dir: string;
  readonly branch: string | null;
  readonly commit: string;
  readonly files: number;
  readonly codeScope: string[];
}

/** Opens each repo at HEAD: branch, commit, tracked files and its code scope (repo-prefixed globs). */
export async function inspectRepos(root: string, repos: readonly RepoRef[]): Promise<RepoInfo[]> {
  const out: RepoInfo[] = [];
  for (const r of repos) {
    const dir = resolve(root, r.path);
    let repo;
    try {
      repo = await openSingleRepo(dir);
    } catch {
      throw new JuratorError('NOT_A_GIT_REPO', `Repo "${r.name}" (${dir}) is not a git repository.`);
    }
    if (resolve(repo.root) !== dir) {
      throw new JuratorError('NOT_A_GIT_REPO', `Repo "${r.name}" (${dir}) is not the top folder of a git repository.`);
    }
    const snap = await repo.snapshot().catch(() => {
      throw new JuratorError('UNKNOWN_REF', `Repo "${r.name}" has no commits yet. Commit something there first.`);
    });
    const files = await repo.listFiles(snap.commit, ['**']);
    const scope = detectRepoCodeScope(files);
    out.push({
      name: r.name,
      path: r.path,
      dir,
      branch: snap.branch,
      commit: snap.commit,
      files: files.length,
      codeScope: (scope.length > 0 ? scope : ['**']).map((g) => `${r.name}/${g}`),
    });
  }
  return out;
}

/**
 * Makes the workspace root its own git repo when it is not one (`git init`), and makes sure its .gitignore lists the
 * code repo folders inside it, so `.jurator/` and `policies/` are versioned there and the code repos stay separate.
 * Returns whether git init ran and which .gitignore lines were added.
 */
export async function prepareWorkspaceRoot(root: string, repos: readonly RepoRef[]): Promise<{ gitInit: boolean; ignored: string[] }> {
  const dir = resolve(root);
  let gitInit = false;
  if ((await gitTop(dir)) !== dir) {
    const out = await runGit(dir, ['init', '-q']);
    if (out.code !== 0) throw new JuratorError('GIT_FAILED', `git init failed in ${dir}: ${out.stderr.trim()}`);
    gitInit = true;
  }
  const file = join(dir, '.gitignore');
  let text = '';
  try {
    text = await readFile(file, 'utf8');
  } catch {
    text = '';
  }
  const have = new Set(text.split(/\r?\n/u).map((l) => l.trim()));
  const added: string[] = [];
  for (const r of repos) {
    const rel = relative(dir, resolve(dir, r.path)).split(sep).join('/');
    if (rel === '' || rel.startsWith('..') || rel.startsWith('/')) continue; // outside the workspace folder
    const line = `/${rel}/`;
    if (have.has(line) || have.has(`${rel}/`) || have.has(`/${rel}`) || have.has(rel)) continue;
    added.push(line);
  }
  if (added.length > 0) {
    const head = text.length === 0 ? `# Code repos of this ${BRAND.name} workspace (each is its own git repo)\n` : text.endsWith('\n') ? '' : '\n';
    await writeFile(file, `${text}${head}${added.join('\n')}\n`, 'utf8');
  }
  return { gitInit, ignored: added };
}

/**
 * Unprefixed globs in a workspace (`src/**`, written by a model or by hand) mean "in any repo": each becomes one glob
 * per repo. Globs that start with a repo name or a wildcard (`**`, `*`) stay as they are.
 */
export function expandRepoGlobs(globs: readonly string[], names: readonly string[]): string[] {
  const out: string[] = [];
  for (const g of globs) {
    const first = g.replace(/^\.\//u, '').split('/')[0] ?? '';
    if (names.includes(first) || /[*?]/u.test(first)) out.push(g);
    else for (const n of names) out.push(`${n}/${g.replace(/^\.\//u, '')}`);
  }
  return [...new Set(out)];
}
