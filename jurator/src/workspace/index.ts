// Owner: WP-W. Public entry of the .jurator/ store.
import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import type { z } from 'zod';
import { BRAND } from '../brand.js';
import {
  alias as aliasSchema,
  checkRunSchema,
  configSchema,
  contradictionSchema,
  DEFAULT_CONFIG,
  itemsFile,
  lockEntrySchema,
  promiseSchema,
  ruleSchema,
  type CheckRun,
  type Config,
  type Contradiction,
  type LockEntry,
  type PolicyDocument,
  type PromiseRecord,
  type Rule,
  type Store,
} from '../contracts.js';
import { JuratorError } from '../util/errors.js';
import { prettyJson } from '../util/json.js';
import { detectCodeScope } from './detect.js';
import { readWorkspaceRepos } from '../git/index.js';
import { expandRepoGlobs } from './multi.js';

const lockFile = itemsFile(lockEntrySchema);
const promisesFile = itemsFile(promiseSchema);
const contradictionsFile = itemsFile(contradictionSchema);
const rulesFile = itemsFile(ruleSchema);

/** Natural, locale-free id order: privacy.2 < privacy.10, C-9 < C-10. */
export function compareIds(a: string, b: string): number {
  const pa = a.match(/\d+|\D+/gu) ?? [];
  const pb = b.match(/\d+|\D+/gu) ?? [];
  for (let i = 0; i < Math.min(pa.length, pb.length); i += 1) {
    const x = pa[i] as string;
    const y = pb[i] as string;
    if (x === y) continue;
    const nx = /^\d/u.test(x);
    const ny = /^\d/u.test(y);
    if (nx && ny) {
      const d = Number(x) - Number(y);
      if (d !== 0) return d;
      return x.length - y.length;
    }
    return x < y ? -1 : 1;
  }
  return pa.length - pb.length;
}

function byKey<T>(key: (item: T) => string): (a: T, b: T) => number {
  return (a, b) => compareIds(key(a), key(b));
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Writes via a temp file + rename so a crash never leaves half a JSON file. */
async function writeAtomic(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, text, 'utf8');
  await rename(tmp, path);
}

function describeIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 3)
    .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('; ');
}

function extFor(mediaType: PolicyDocument['mediaType']): string {
  if (mediaType === 'text/markdown') return 'md';
  if (mediaType === 'application/json') return 'json';
  return 'txt';
}

class FileStore implements Store {
  readonly dir: string;
  readonly repoRoot: string;
  /** R4-WS: the workspace's repo names (null for a single repo), read once from config.json. */
  private repoNames: Promise<string[] | null> | undefined;

  constructor(repoRoot: string) {
    this.repoRoot = resolve(repoRoot);
    this.dir = join(this.repoRoot, BRAND.folder);
  }

  private rel(path: string): string {
    return `${BRAND.folder}/${relative(this.dir, path).split(sep).join('/')}`;
  }

  /** Reads and validates a JSON file; `undefined` when it does not exist. */
  private async readJson<T>(path: string, schema: z.ZodType<T>): Promise<T | undefined> {
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      throw new JuratorError('BAD_WORKSPACE_FILE', `${this.rel(path)} is not valid JSON. Fix it or restore it from git.`);
    }
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      throw new JuratorError('BAD_WORKSPACE_FILE', `${this.rel(path)} does not match the expected shape: ${describeIssues(parsed.error)}`);
    }
    return parsed.data;
  }

  private async writeJson<T>(path: string, schema: z.ZodType<T>, value: T): Promise<void> {
    const parsed = schema.safeParse(value);
    if (!parsed.success) {
      throw new JuratorError('BAD_WORKSPACE_WRITE', `Refusing to write ${this.rel(path)}: ${describeIssues(parsed.error)}`);
    }
    await writeAtomic(path, prettyJson(parsed.data));
  }

  private async readItems<T>(name: string, schema: z.ZodType<{ schemaVersion: 1; items: T[] }>): Promise<T[]> {
    const file = await this.readJson(join(this.dir, name), schema);
    return file ? file.items : [];
  }

  private async writeItems<T>(
    name: string,
    schema: z.ZodType<{ schemaVersion: 1; items: T[] }>,
    items: readonly T[],
    key: (item: T) => string,
  ): Promise<void> {
    const sorted = [...items].sort(byKey(key));
    await this.writeJson(join(this.dir, name), schema, { schemaVersion: 1 as const, items: sorted });
  }

  async exists(): Promise<boolean> {
    return fileExists(join(this.dir, 'config.json'));
  }

  /** In a workspace, unprefixed globs apply in every repo (`src/**` -> `api/src/**`, `web/src/**`). */
  private async expand(globs: readonly string[]): Promise<string[]> {
    this.repoNames ??= readWorkspaceRepos(this.repoRoot)
      .then((r) => (r ? r.map((x) => x.name) : null))
      .catch(() => null);
    const names = await this.repoNames;
    return names ? expandRepoGlobs(globs, names) : [...globs];
  }

  async readConfig(): Promise<Config> {
    const config = await this.readJson(join(this.dir, 'config.json'), configSchema);
    if (!config) {
      throw new JuratorError('NO_WORKSPACE', `No ${BRAND.folder}/ in ${this.repoRoot}. Run ${BRAND.command} init first.`);
    }
    if (!config.repos || config.repos.length === 0) return config;
    this.repoNames = Promise.resolve(config.repos.map((r) => r.name));
    return { ...config, codeScope: expandRepoGlobs(config.codeScope, config.repos.map((r) => r.name)) };
  }

  async writeConfig(config: Config): Promise<void> {
    this.repoNames = undefined;
    await this.writeJson(join(this.dir, 'config.json'), configSchema, config);
  }

  async readLock(): Promise<LockEntry[]> {
    return this.readItems('sources.lock.json', lockFile);
  }

  async writeLock(items: LockEntry[]): Promise<void> {
    await this.writeItems('sources.lock.json', lockFile, items, (e) => e.alias);
  }

  async saveSourceText(doc: PolicyDocument): Promise<string> {
    const a = aliasSchema.parse(doc.alias);
    const textPath = `sources/${a}.${extFor(doc.mediaType)}`;
    await writeAtomic(join(this.dir, textPath), doc.text);
    return textPath;
  }

  async readSourceText(entry: LockEntry): Promise<string> {
    const path = resolve(this.dir, entry.textPath);
    if (!path.startsWith(`${this.dir}${sep}`)) {
      throw new JuratorError('BAD_WORKSPACE_FILE', `Lock entry ${entry.alias} points outside ${BRAND.folder}/.`);
    }
    try {
      return await readFile(path, 'utf8');
    } catch {
      throw new JuratorError('SOURCE_TEXT_MISSING', `${this.rel(path)} is missing. Run ${BRAND.command} pull.`);
    }
  }

  async readPromises(): Promise<PromiseRecord[]> {
    const dir = join(this.dir, 'promises');
    let names: string[];
    try {
      names = (await readdir(dir)).filter((n) => n.endsWith('.json')).sort();
    } catch {
      return [];
    }
    const all: PromiseRecord[] = [];
    for (const name of names) all.push(...(await this.readItems(`promises/${name}`, promisesFile)));
    for (const [i, p] of all.entries()) if (p.scope.length > 0) all[i] = { ...p, scope: await this.expand(p.scope) };
    return all.sort(byKey((p) => p.id));
  }

  async writePromises(sourceAlias: string, items: PromiseRecord[]): Promise<void> {
    const a = aliasSchema.parse(sourceAlias);
    const foreign = items.find((p) => !p.id.startsWith(`${a}.`));
    if (foreign) {
      throw new JuratorError('BAD_WORKSPACE_WRITE', `Promise ${foreign.id} does not belong to source "${a}".`);
    }
    await this.writeItems(`promises/${a}.json`, promisesFile, items, (p) => p.id);
  }

  async readContradictions(): Promise<Contradiction[]> {
    return this.readItems('contradictions.json', contradictionsFile);
  }

  async writeContradictions(items: Contradiction[]): Promise<void> {
    await this.writeItems('contradictions.json', contradictionsFile, items, (c) => c.id);
  }

  async readRules(): Promise<Rule[]> {
    const rules = await this.readItems('rules.json', rulesFile);
    const out: Rule[] = [];
    for (const r of rules) out.push({ ...r, globs: await this.expand(r.globs) });
    return out;
  }

  async writeRules(items: Rule[]): Promise<void> {
    await this.writeItems('rules.json', rulesFile, items, (r) => r.id);
  }

  async writeRun(run: CheckRun): Promise<string> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(run.id)) {
      throw new JuratorError('BAD_WORKSPACE_WRITE', `Run id "${run.id}" is not safe as a folder name.`);
    }
    const path = join(this.dir, 'local', 'runs', run.id, 'run.json');
    await this.writeJson(path, checkRunSchema, run);
    return path;
  }
}

export function openStore(repoRoot: string): Store {
  return new FileStore(repoRoot);
}

/**
 * Creates .jurator/ with config.json, .gitignore, empty lists. Fails if it already exists. A config that still has
 * the default code scope (`src/**`, `app/**`, `lib/**`) gets the repo's real code folders instead when it has none
 * of those (a Go repo with code at the root, a monorepo under `apps/` and `packages/`).
 */
export async function initWorkspace(repoRoot: string, config: Config): Promise<Store> {
  const store = openStore(repoRoot);
  if (await store.exists()) {
    throw new JuratorError('WORKSPACE_EXISTS', `${BRAND.folder}/config.json already exists in ${store.repoRoot}. Nothing changed.`);
  }
  const isDefaultScope =
    config.codeScope.length === DEFAULT_CONFIG.codeScope.length && config.codeScope.every((g, i) => g === DEFAULT_CONFIG.codeScope[i]);
  if (isDefaultScope) config = { ...config, codeScope: await detectCodeScope(store.repoRoot, config.codeScope) };
  await mkdir(join(store.dir, 'promises'), { recursive: true });
  await mkdir(join(store.dir, 'sources'), { recursive: true });
  await writeAtomic(join(store.dir, '.gitignore'), 'local/\n');
  await store.writeLock([]);
  await store.writeContradictions([]);
  await store.writeRules([]);
  await store.writeConfig(config);
  return store;
}

/**
 * Walks up from cwd to the git root that contains (or will contain) .jurator/. R4-WS: a multi-repo workspace root wins
 * when cwd is inside it (its .jurator/config.json lists `repos`), also from inside one of its code repos.
 */
export async function findRepoRoot(cwd: string): Promise<string> {
  let dir = resolve(cwd);
  let firstGit: string | null = null;
  for (;;) {
    if (firstGit === null) {
      if (await fileExists(join(dir, '.git'))) {
        firstGit = dir;
        if (await fileExists(join(dir, BRAND.folder, 'config.json'))) return dir;
      } else if (await listsRepo(dir, null)) return dir;
    } else if (await listsRepo(dir, firstGit)) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  if (firstGit !== null) return firstGit;
  throw new JuratorError('NOT_A_GIT_REPO', `${cwd} is not inside a git repository. Run ${BRAND.command} inside your repo.`);
}

/** Is `dir` a multi-repo workspace root (one that lists `member` among its repos, when given)? Never throws. */
async function listsRepo(dir: string, member: string | null): Promise<boolean> {
  let repos;
  try {
    repos = await readWorkspaceRepos(dir);
  } catch {
    return false;
  }
  if (!repos) return false;
  return member === null || repos.some((r) => resolve(dir, r.path) === member);
}

/** Every saved check run (newest last). Not part of the Store contract: local/ is per machine. */
export async function listRuns(store: Store): Promise<CheckRun[]> {
  const dir = join(store.dir, 'local', 'runs');
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const runs: CheckRun[] = [];
  for (const name of names) {
    try {
      const raw: unknown = JSON.parse(await readFile(join(dir, name, 'run.json'), 'utf8'));
      const parsed = checkRunSchema.safeParse(raw);
      if (parsed.success) runs.push(parsed.data);
    } catch {
      // A broken or half-written local run is skipped; local/ is a cache, not the record.
    }
  }
  return runs.sort((a, b) => (a.createdAt === b.createdAt ? compareIds(a.id, b.id) : a.createdAt < b.createdAt ? -1 : 1));
}
