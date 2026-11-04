// Owner: R4-WS. A workspace of several git repos seen as one GitRepo ("documents live only in the extension's
// memory" spans the extension and the backend). Every path is prefixed with its repo's name
// (`chrome-extension/src/...`), and a commit is a composite: the first 40 hex of sha256 over the sorted `name:commit`
// lines. The composite -> per-repo map is kept in memory, in .jurator/local/snapshots/<composite>.json, and in each
// CheckRun (`repoCommits`), so any citation can be re-read later. Code repos stay separate git repos; nothing here
// writes to them.
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, join, resolve as resolvePath } from 'node:path';
import type { CodeSnapshot, GitRepo } from '../contracts.js';
import { JuratorError } from '../util/errors.js';
import { globToRegExp } from '../util/glob.js';
import { sha256 } from '../util/json.js';
import { BRAND } from '../brand.js';

/** One entry of config `repos`. */
export interface RepoRef {
  readonly name: string;
  readonly path: string;
}
export interface RepoCommit {
  readonly name: string;
  readonly commit: string;
}
export interface Member {
  readonly name: string;
  readonly repo: GitRepo;
}

/** The workspace view of several repos. Not part of the shared contract: use `isWorkspaceRepo` to tell. */
export interface WorkspaceRepo extends GitRepo {
  readonly kind: 'workspace';
  readonly members: readonly Member[];
  /** Each repo's commit in a composite commit (sorted by name). */
  commitsOf(composite: string): Promise<RepoCommit[]>;
  /**
   * A diff base: a ref applies to every repo that has it, the others use their last verified commit, else HEAD.
   * `name=ref,name=ref` sets it per repo; `last` is the whole last verified state.
   */
  resolveBase(ref: string): Promise<string>;
  /** Teaches the repo a composite read from a record; false when the map does not hash to that composite. */
  remember(composite: string, commits: readonly RepoCommit[]): Promise<boolean>;
}

export const REPO_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const COMPOSITE = /^[0-9a-f]{40}$/u;
const SHORT_HEX = /^[0-9a-f]{7,39}$/u;

export function isWorkspaceRepo(repo: GitRepo): repo is WorkspaceRepo {
  return (repo as Partial<WorkspaceRepo>).kind === 'workspace';
}

/** The composite commit of several repos: first 40 hex of sha256 over the sorted `name:commit` lines. */
export function compositeOf(commits: readonly RepoCommit[]): string {
  const lines = commits.map((c) => `${c.name}:${c.commit}`).sort();
  return sha256(lines.join('\n')).slice(0, 40);
}

/** `chrome-extension/src/a.ts` -> ['chrome-extension', 'src/a.ts']; null without a prefix. */
export function splitRepoPath(path: string): [string, string] | null {
  const clean = path.replace(/^\.\//u, '');
  const slash = clean.indexOf('/');
  if (slash <= 0 || slash === clean.length - 1) return null;
  return [clean.slice(0, slash), clean.slice(slash + 1)];
}

function errorCode(error: unknown): string | undefined {
  return error instanceof JuratorError ? error.code : (error as { code?: string } | null)?.code;
}

async function writeAtomic(path: string, text: string): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, text, 'utf8');
  await rename(tmp, path);
}

function parseCommits(raw: unknown): RepoCommit[] | null {
  if (!Array.isArray(raw)) return null;
  const out: RepoCommit[] = [];
  for (const item of raw) {
    const name = (item as { name?: unknown } | null)?.name;
    const commit = (item as { commit?: unknown } | null)?.commit;
    if (typeof name !== 'string' || !REPO_NAME.test(name) || typeof commit !== 'string' || !/^[0-9a-f]{40,64}$/u.test(commit)) return null;
    out.push({ name, commit });
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * Opens a workspace: `root` holds .jurator/ (and usually its own git repo for .jurator/ and policies/), `repos` are the
 * code repos. `openSingle` opens one plain repo (src/git's single-repo GitRepo).
 */
export async function openWorkspaceRepo(
  root: string,
  repos: readonly RepoRef[],
  openSingle: (dir: string) => Promise<GitRepo>,
): Promise<WorkspaceRepo> {
  const wsRoot = resolvePath(root);
  if (repos.length === 0) throw new JuratorError('BAD_WORKSPACE_FILE', `${BRAND.folder}/config.json has an empty "repos" list.`);
  const members: Member[] = [];
  for (const r of [...repos].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    if (!REPO_NAME.test(r.name)) throw new JuratorError('BAD_WORKSPACE_FILE', `Repo name "${r.name}" in ${BRAND.folder}/config.json is not a plain folder name.`);
    if (members.some((m) => m.name === r.name)) throw new JuratorError('BAD_WORKSPACE_FILE', `Repo "${r.name}" is listed twice in ${BRAND.folder}/config.json.`);
    const dir = resolvePath(wsRoot, r.path);
    let repo: GitRepo;
    try {
      repo = await openSingle(dir);
    } catch {
      throw new JuratorError('NOT_A_GIT_REPO', `Repo "${r.name}" (${dir}) is not a git repository. Fix "repos" in ${BRAND.folder}/config.json.`);
    }
    if (resolvePath(repo.root) !== dir) {
      throw new JuratorError('NOT_A_GIT_REPO', `Repo "${r.name}" (${dir}) is not the top folder of a git repository (that is ${repo.root}).`);
    }
    members.push({ name: r.name, repo });
  }
  const byName = new Map(members.map((m) => [m.name, m] as const));
  const composites = new Map<string, RepoCommit[]>();
  const written = new Set<string>();
  const local = join(wsRoot, BRAND.folder, 'local');
  const snapshotPath = (c: string): string => join(local, 'snapshots', `${c}.json`);

  const register = async (commits: readonly RepoCommit[]): Promise<string> => {
    const sorted = [...commits].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const c = compositeOf(sorted);
    composites.set(c, sorted);
    if (!written.has(c)) {
      written.add(c);
      try {
        await writeAtomic(snapshotPath(c), `${JSON.stringify({ schemaVersion: 1, composite: c, repos: sorted }, null, 2)}\n`);
      } catch {
        // local/ is a cache: the map is also embedded in every check run.
      }
    }
    return c;
  };

  const fromFile = async (c: string): Promise<RepoCommit[] | null> => {
    try {
      const raw = JSON.parse(await readFile(snapshotPath(c), 'utf8')) as { repos?: unknown };
      const commits = parseCommits(raw.repos);
      if (!commits || compositeOf(commits) !== c) return null;
      composites.set(c, commits);
      written.add(c);
      return commits;
    } catch {
      return null;
    }
  };

  const known = async (ref: string): Promise<string | null> => {
    if (COMPOSITE.test(ref)) return composites.has(ref) || (await fromFile(ref)) ? ref : null;
    if (!SHORT_HEX.test(ref)) return null;
    // A short composite as printed by status or a report (7 hex): unique among the states this machine has seen.
    const seen = new Set([...composites.keys()].filter((c) => c.startsWith(ref)));
    try {
      for (const name of await readdir(join(local, 'snapshots'))) {
        const c = name.replace(/\.json$/u, '');
        if (COMPOSITE.test(c) && c.startsWith(ref)) seen.add(c);
      }
    } catch {
      // no snapshots yet
    }
    if (seen.size !== 1) return null;
    const c = [...seen][0] as string;
    return composites.has(c) || (await fromFile(c)) ? c : null;
  };

  const commitsOf = async (composite: string): Promise<RepoCommit[]> => {
    const hit = composites.get(composite) ?? (COMPOSITE.test(composite) ? await fromFile(composite) : null);
    if (!hit) {
      throw new JuratorError(
        'UNKNOWN_REF',
        `${composite.slice(0, 7)} is not a workspace state this machine knows (no ${BRAND.folder}/local/snapshots/${composite.slice(0, 12)}...json).`,
      );
    }
    return hit;
  };

  /** The last verified state (local/verified.json), as each repo's commit. */
  const lastVerified = async (): Promise<{ composite: string; commits: RepoCommit[] } | null> => {
    try {
      const raw = JSON.parse(await readFile(join(local, 'verified.json'), 'utf8')) as { commit?: unknown };
      if (typeof raw.commit !== 'string' || !COMPOSITE.test(raw.commit)) return null;
      const commits = composites.get(raw.commit) ?? (await fromFile(raw.commit));
      return commits ? { composite: raw.commit, commits } : null;
    } catch {
      return null;
    }
  };

  const headOf = async (m: Member): Promise<string> => {
    try {
      return await m.repo.resolve('HEAD');
    } catch {
      throw new JuratorError('UNKNOWN_REF', `Repo ${m.name} has no commits yet. Commit something there first.`);
    }
  };

  const resolveIn = async (ref: string, fallback: 'head' | 'base'): Promise<string> => {
    if (ref.length === 0 || ref.startsWith('-') || ref.includes('\0')) throw new JuratorError('UNKNOWN_REF', `Not a valid ref: "${ref}".`);
    const hit = await known(ref);
    if (hit) return hit;
    if (ref === 'last') {
      const v = await lastVerified();
      if (!v) throw new JuratorError('UNKNOWN_REF', `No verified state yet. Run ${BRAND.command} check once, then --diff last.`);
      return v.composite;
    }
    const explicit = new Map<string, string>();
    let shared: string | null = null;
    if (ref.includes('=')) {
      for (const part of ref.split(',')) {
        const m = /^([^=]+)=(.+)$/u.exec(part.trim());
        const name = m?.[1]?.trim();
        if (!m || !name || !byName.has(name)) {
          throw new JuratorError(
            'UNKNOWN_REF',
            `"${part}" should look like repo=ref, with repo one of: ${members.map((x) => x.name).join(', ')}.`,
          );
        }
        explicit.set(name, (m[2] as string).trim());
      }
    } else shared = ref;
    const last = fallback === 'base' ? new Map(((await lastVerified())?.commits ?? []).map((c) => [c.name, c.commit] as const)) : null;
    const commits: RepoCommit[] = [];
    let anyKnown = false;
    for (const m of members) {
      const wanted = explicit.get(m.name) ?? shared;
      if (wanted !== null && wanted !== undefined) {
        try {
          commits.push({ name: m.name, commit: await m.repo.resolve(wanted) });
          anyKnown = true;
          continue;
        } catch (error) {
          if (explicit.has(m.name) || errorCode(error) !== 'UNKNOWN_REF') {
            throw new JuratorError(errorCode(error) ?? 'UNKNOWN_REF', `${m.name}: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      }
      const prev = last?.get(m.name);
      if (prev) {
        try {
          commits.push({ name: m.name, commit: await m.repo.resolve(prev) });
          continue;
        } catch {
          // the verified commit is gone (rewritten history): use HEAD
        }
      }
      commits.push({ name: m.name, commit: await headOf(m) });
    }
    if (shared !== null && !anyKnown) {
      throw new JuratorError(
        'UNKNOWN_REF',
        `No repo in this workspace knows "${shared}". Check the branch or commit name, or name it per repo: ${(members[0] as Member).name}=<ref>.`,
      );
    }
    return register(commits);
  };

  const repoOf = (name: string): Member | undefined => byName.get(name);

  return {
    kind: 'workspace',
    root: wsRoot,
    members,
    commitsOf,
    resolveBase: (ref) => resolveIn(ref, 'base'),
    async remember(composite, commits) {
      const parsed = parseCommits(commits);
      if (!parsed || !COMPOSITE.test(composite) || compositeOf(parsed) !== composite) return false;
      composites.set(composite, parsed);
      return true;
    },
    async snapshot(): Promise<CodeSnapshot> {
      const snaps = [];
      for (const m of members) {
        try {
          snaps.push({ name: m.name, ...(await m.repo.snapshot()) });
        } catch (error) {
          throw new JuratorError(errorCode(error) ?? 'GIT_FAILED', `${m.name}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      const commit = await register(snaps.map((s) => ({ name: s.name, commit: s.commit })));
      const branches = [...new Set(snaps.map((s) => s.branch).filter((b): b is string => b !== null))];
      const branch =
        branches.length === 0 ? null : branches.length === 1 && snaps.every((s) => s.branch !== null) ? (branches[0] as string) : snaps.map((s) => `${s.name}:${s.branch ?? 'detached'}`).join(' ');
      return {
        repo: basename(wsRoot),
        branch,
        commit,
        dirty: snaps.some((s) => s.dirty),
        repos: snaps.map((s) => ({ name: s.name, branch: s.branch, commit: s.commit, dirty: s.dirty })),
      };
    },
    resolve: (ref) => resolveIn(ref, 'head'),
    async listFiles(commit, globs) {
      const parts = await commitsOf(await resolveIn(commit, 'head'));
      const res = globs.map((g) => globToRegExp(g));
      const out: string[] = [];
      for (const p of parts) {
        const m = repoOf(p.name);
        if (!m) continue; // a repo that left the workspace since
        for (const f of await m.repo.listFiles(p.commit, ['**'])) {
          const full = `${p.name}/${f}`;
          if (res.some((re) => re.test(full))) out.push(full);
        }
      }
      return out.sort();
    },
    async readFile(commit, path) {
      const parts = await commitsOf(await resolveIn(commit, 'head'));
      const split = splitRepoPath(path);
      const part = split ? parts.find((p) => p.name === split[0]) : undefined;
      const m = split ? repoOf(split[0]) : undefined;
      if (!split || !part || !m) {
        throw new JuratorError('FILE_NOT_IN_COMMIT', `${path} is not in any repo of this workspace (paths start with ${members.map((x) => `${x.name}/`).join(' or ')}).`);
      }
      return m.repo.readFile(part.commit, split[1]);
    },
    async changedFiles(base, head) {
      const before = new Map((await commitsOf(await resolveIn(base, 'base'))).map((c) => [c.name, c.commit] as const));
      const after = await commitsOf(await resolveIn(head, 'head'));
      const out: string[] = [];
      for (const p of after) {
        const m = repoOf(p.name);
        if (!m) continue;
        const was = before.get(p.name);
        if (was === p.commit) continue;
        const files = was === undefined ? await m.repo.listFiles(p.commit, ['**']) : await m.repo.changedFiles(was, p.commit);
        for (const f of files) out.push(`${p.name}/${f}`);
      }
      return out.sort();
    },
  };
}

/** One repo's part of a (composite) commit: paths in it are `prefix + path`. */
export interface RepoPart {
  readonly prefix: string;
  readonly repo: GitRepo;
  readonly commit: string;
}

/** The plain repos behind `commit`: one part with no prefix for a single repo, one per code repo in a workspace. */
export async function repoParts(repo: GitRepo, commit: string): Promise<RepoPart[]> {
  if (!isWorkspaceRepo(repo)) return [{ prefix: '', repo, commit }];
  const parts = await repo.commitsOf(await repo.resolve(commit));
  const out: RepoPart[] = [];
  for (const p of parts) {
    const m = repo.members.find((x) => x.name === p.name);
    if (m) out.push({ prefix: `${p.name}/`, repo: m.repo, commit: p.commit });
  }
  return out;
}

/** A diff base: `resolveBase` in a workspace, `resolve` otherwise. */
export function resolveBase(repo: GitRepo, ref: string): Promise<string> {
  return isWorkspaceRepo(repo) ? repo.resolveBase(ref) : repo.resolve(ref);
}

/** The map a CheckRun embeds (`repoCommits`) for the composites it used; undefined for a single repo. */
export async function repoCommitsFor(repo: GitRepo, commits: readonly string[]): Promise<Record<string, RepoCommit[]> | undefined> {
  if (!isWorkspaceRepo(repo)) return undefined;
  const out: Record<string, RepoCommit[]> = {};
  for (const c of [...new Set(commits)].sort()) {
    try {
      out[c] = (await repo.commitsOf(c)).map((x) => ({ name: x.name, commit: x.commit }));
    } catch {
      // not a composite (should not happen): nothing to embed for it
    }
  }
  return out;
}

/** Teaches a workspace repo the composites a record embeds (no-op for a single repo). */
export async function rememberRepoCommits(repo: GitRepo, map: Record<string, readonly RepoCommit[]> | undefined): Promise<void> {
  if (!map || !isWorkspaceRepo(repo)) return;
  for (const [c, commits] of Object.entries(map)) await repo.remember(c, commits);
}

/** The `repos` list of `<dir>/.jurator/config.json`, or null when there is none (a single repo, or no workspace). */
export async function readWorkspaceRepos(dir: string): Promise<RepoRef[] | null> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(join(dir, BRAND.folder, 'config.json'), 'utf8'));
  } catch {
    return null;
  }
  const repos = (raw as { repos?: unknown } | null)?.repos;
  if (!Array.isArray(repos) || repos.length === 0) return null;
  const out: RepoRef[] = [];
  for (const r of repos) {
    const name = (r as { name?: unknown } | null)?.name;
    const path = (r as { path?: unknown } | null)?.path;
    if (typeof name !== 'string' || typeof path !== 'string' || !REPO_NAME.test(name) || path.length === 0) {
      throw new JuratorError('BAD_WORKSPACE_FILE', `${BRAND.folder}/config.json: each "repos" entry needs a plain "name" and a "path".`);
    }
    out.push({ name, path });
  }
  return out;
}
