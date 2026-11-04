// Owner: WP-W. Git access through the git CLI (child_process.execFile, never a shell).
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { basename, join, resolve as resolvePath } from 'node:path';
import { openWorkspaceRepo, readWorkspaceRepos } from './multi.js';
import type { CodeSnapshot, GitRepo } from '../contracts.js';
import { JuratorError } from '../util/errors.js';
import { matchesAny } from '../util/glob.js';
import { BRAND } from '../brand.js';

const MAX_BUFFER = 64 * 1024 * 1024;

interface GitOutput {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs git with an argument list (no shell); never throws for a non-zero exit, the caller decides. */
export function runGit(cwd: string, args: readonly string[]): Promise<GitOutput> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      'git',
      ['-c', 'core.quotepath=off', ...args],
      {
        cwd,
        encoding: 'utf8',
        maxBuffer: MAX_BUFFER,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
      },
      (error, stdout, stderr) => {
        const errCode = error ? (error as NodeJS.ErrnoException).code : undefined;
        if (typeof errCode === 'string') {
          reject(
            errCode === 'ENOENT'
              ? new JuratorError('GIT_NOT_FOUND', 'Could not run git. Is git installed and on PATH?')
              : new JuratorError('GIT_FAILED', `git ${args[0] ?? ''} failed (${errCode}).`),
          );
          return;
        }
        const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
        resolvePromise({ code, stdout, stderr });
      },
    );
  });
}

/** Refs and paths that start with '-' would be read as options by git. */
function safeArg(value: string, what: string): string {
  if (value.length === 0 || value.startsWith('-') || value.includes('\0')) {
    throw new JuratorError(what === 'ref' ? 'UNKNOWN_REF' : 'BAD_PATH', `Not a valid ${what}: "${value}".`);
  }
  return value;
}

function splitZ(out: string): string[] {
  return out.split('\0').filter((s) => s.length > 0);
}

/** Untracked tool folders (Jurator's own, agent settings) that do not make the code dirty. */
const IGNORED_UNTRACKED = [`${BRAND.folder}/`, '.claude/', '.muse/'];

/**
 * True when `git status --porcelain -z` output shows a change that matters for the code. Untracked paths under
 * .jurator/, .claude/ and .muse/ do not count (installing a hook or running init should not print "uncommitted").
 */
export function isDirty(porcelainZ: string): boolean {
  const entries = porcelainZ.split('\0');
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i] ?? '';
    if (entry.length < 4) continue;
    const xy = entry.slice(0, 2);
    const path = entry.slice(3);
    if (xy[0] === 'R' || xy[0] === 'C') i += 1; // a rename or copy is followed by its old path
    if (xy === '??' && IGNORED_UNTRACKED.some((dir) => path === dir.slice(0, -1) || path.startsWith(dir))) continue;
    return true;
  }
  return false;
}

interface Pending {
  readonly resolve: (blob: Buffer | null) => void;
  readonly reject: (error: Error) => void;
}

/**
 * One long-lived `git cat-file --batch` per repo: reading N files costs one process, not 2N (FX-4: a 3,000-file
 * monorepo spent minutes spawning `git show`). Requests are answered in order. The process never keeps Node alive
 * while idle (it is unref'd between requests), and it is restarted if it dies.
 */
export class BlobReader {
  private child: ChildProcessWithoutNullStreams | undefined;
  private buf: Buffer = Buffer.alloc(0);
  private readonly queue: Pending[] = [];
  private readonly root: string;

  // A plain field, not a parameter property: the MCP tests run this file with Node's type stripping.
  constructor(root: string) {
    this.root = root;
  }

  /** Blob bytes of `<commit>:<path>`, or null when it is missing or not a file. */
  read(commitSha: string, path: string): Promise<Buffer | null> {
    const child = this.start();
    return new Promise((resolvePromise, reject) => {
      this.queue.push({ resolve: resolvePromise, reject });
      if (this.queue.length === 1) this.setRef(true);
      child.stdin.write(`${commitSha}:${path}\n`);
    });
  }

  private start(): ChildProcessWithoutNullStreams {
    if (this.child) return this.child;
    const child = spawn('git', ['cat-file', '--batch'], {
      cwd: this.root,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    this.buf = Buffer.alloc(0);
    child.stdout.on('data', (chunk: Buffer) => {
      this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
      this.drain();
    });
    const fail = (error: Error) => {
      if (this.child !== child) return;
      this.child = undefined;
      const waiting = this.queue.splice(0);
      for (const w of waiting) w.reject(error);
    };
    child.on('error', (e: NodeJS.ErrnoException) =>
      fail(e.code === 'ENOENT' ? new JuratorError('GIT_NOT_FOUND', 'Could not run git. Is git installed and on PATH?') : new JuratorError('GIT_FAILED', `git cat-file failed (${e.code ?? e.message}).`)),
    );
    child.on('exit', () => fail(new JuratorError('GIT_FAILED', 'git cat-file stopped unexpectedly.')));
    child.stdin.on('error', () => undefined); // reported through 'exit'
    child.stderr.resume();
    this.setRef(false);
    return child;
  }

  private drain(): void {
    for (;;) {
      const nl = this.buf.indexOf(0x0a);
      if (nl < 0) return;
      const header = this.buf.subarray(0, nl).toString('utf8');
      const head = this.queue[0];
      if (/ (?:missing|ambiguous)$/u.test(header)) {
        this.buf = this.buf.subarray(nl + 1);
        this.queue.shift();
        head?.resolve(null);
      } else {
        const m = / ([a-z]+) (\d+)$/u.exec(header);
        if (!m) {
          // Not a header we understand: drop the process; the waiting reads fail and the next read restarts it.
          this.child?.kill();
          return;
        }
        const size = Number(m[2]);
        if (this.buf.length < nl + 1 + size + 1) return; // wait for the rest of the blob
        const body = this.buf.subarray(nl + 1, nl + 1 + size);
        this.buf = this.buf.subarray(nl + 1 + size + 1);
        this.queue.shift();
        head?.resolve(m[1] === 'blob' ? Buffer.from(body) : null);
      }
      if (this.queue.length === 0) this.setRef(false);
    }
  }

  /** Keep Node alive only while a read is waiting. */
  private setRef(on: boolean): void {
    const c = this.child;
    if (!c) return;
    const items = [c, c.stdin, c.stdout, c.stderr] as Array<{ ref?: () => void; unref?: () => void }>;
    for (const item of items) (on ? item.ref : item.unref)?.call(item);
  }

  close(): void {
    const c = this.child;
    this.child = undefined;
    c?.stdin.end();
  }
}

const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;

/** The commit of .jurator/local/verified.json (the last completed check); UNKNOWN_REF when there is none. */
async function lastVerifiedCommit(root: string): Promise<string> {
  try {
    const raw = JSON.parse(await readFile(join(root, BRAND.folder, 'local', 'verified.json'), 'utf8')) as { commit?: unknown };
    if (typeof raw.commit === 'string' && /^[0-9a-f]{7,64}$/u.test(raw.commit)) return raw.commit;
  } catch {
    // no verified state yet
  }
  throw new JuratorError('UNKNOWN_REF', `No verified state yet. Run ${BRAND.command} check once, then --diff last.`);
}

/**
 * The repo `cwd` is in. R4-WS: when `cwd` (or its git top folder) holds a .jurator/config.json with `repos`, this is
 * the multi-repo workspace view (repo-prefixed paths, composite commits); otherwise the single repo, as before.
 */
export async function openRepo(cwd: string): Promise<GitRepo> {
  const here = resolvePath(cwd);
  const repos = await readWorkspaceRepos(here);
  if (repos) return openWorkspaceRepo(here, repos, openSingleRepo);
  const top = await runGit(here, ['rev-parse', '--show-toplevel']);
  if (top.code === 0) {
    const root = top.stdout.trim();
    if (resolvePath(root) !== here) {
      const outer = await readWorkspaceRepos(root);
      if (outer) return openWorkspaceRepo(root, outer, openSingleRepo);
    }
  }
  return openSingleRepo(cwd);
}

/** One plain git repo (never the workspace view). */
export async function openSingleRepo(cwd: string): Promise<GitRepo> {
  const top = await runGit(cwd, ['rev-parse', '--show-toplevel']);
  if (top.code !== 0) {
    throw new JuratorError('NOT_A_GIT_REPO', `${cwd} is not inside a git repository. Run ${BRAND.command} inside your repo.`);
  }
  const root = top.stdout.trim();
  const git = (args: readonly string[]) => runGit(root, args);

  // A commit sha never changes meaning, so a verified sha resolves without a process, and its file list is read once.
  const knownCommits = new Set<string>();
  const trees = new Map<string, Promise<string[]>>();
  const blobs = new BlobReader(root);

  const resolve = async (ref: string): Promise<string> => {
    safeArg(ref, 'ref');
    if (knownCommits.has(ref)) return ref;
    const out = await git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
    const sha = out.stdout.trim();
    if (out.code !== 0 || !/^[0-9a-f]{40,64}$/u.test(sha)) {
      // R4-WS: `last` (when no branch has that name) is the last verified commit (`check --diff last`).
      if (ref === 'last') return resolve(await lastVerifiedCommit(root));
      throw new JuratorError('UNKNOWN_REF', `git does not know "${ref}". Check the branch or commit name.`);
    }
    if (FULL_SHA.test(sha)) knownCommits.add(sha);
    return sha;
  };

  const tree = (sha: string): Promise<string[]> => {
    let paths = trees.get(sha);
    if (!paths) {
      paths = git(['ls-tree', '-r', '--name-only', '-z', sha]).then((out) => {
        if (out.code !== 0) throw new JuratorError('GIT_FAILED', `git ls-tree failed: ${out.stderr.trim()}`);
        return splitZ(out.stdout);
      });
      paths.catch(() => trees.delete(sha));
      trees.set(sha, paths);
    }
    return paths;
  };

  return {
    root,
    async snapshot(): Promise<CodeSnapshot> {
      const commit = await resolve('HEAD').catch(() => {
        throw new JuratorError('UNKNOWN_REF', 'This repository has no commits yet. Commit something first.');
      });
      const branchOut = await git(['symbolic-ref', '--short', '-q', 'HEAD']);
      const branch = branchOut.code === 0 && branchOut.stdout.trim() ? branchOut.stdout.trim() : null;
      const status = await git(['status', '--porcelain', '-z']);
      if (status.code !== 0) throw new JuratorError('GIT_FAILED', `git status failed: ${status.stderr.trim()}`);
      return { repo: basename(root), branch, commit, dirty: isDirty(status.stdout) };
    },
    resolve,
    async listFiles(commit: string, globs: readonly string[]): Promise<string[]> {
      const sha = await resolve(commit);
      return (await tree(sha))
        .filter((p) => matchesAny(p, globs))
        .sort();
    },
    async readFile(commit: string, path: string): Promise<string> {
      const sha = await resolve(commit);
      const clean = safeArg(path.replace(/^\.\//u, ''), 'path');
      if (/[\n\r]/u.test(clean)) {
        // cat-file --batch reads one request per line; such a path goes through git show.
        const out = await git(['show', `${sha}:${clean}`]);
        if (out.code !== 0) throw new JuratorError('FILE_NOT_IN_COMMIT', `${clean} is not in commit ${sha.slice(0, 7)}.`);
        return out.stdout;
      }
      const blob = await blobs.read(sha, clean);
      if (blob === null) throw new JuratorError('FILE_NOT_IN_COMMIT', `${clean} is not in commit ${sha.slice(0, 7)}.`);
      return blob.toString('utf8');
    },
    async changedFiles(base: string, head: string): Promise<string[]> {
      const b = await resolve(base);
      const h = await resolve(head);
      const out = await git(['diff', '--name-only', '-z', `${b}...${h}`]);
      if (out.code !== 0) throw new JuratorError('GIT_FAILED', `git diff failed: ${out.stderr.trim()}`);
      return splitZ(out.stdout).sort();
    },
  };
}

export {
  compositeOf,
  isWorkspaceRepo,
  openWorkspaceRepo,
  readWorkspaceRepos,
  rememberRepoCommits,
  repoCommitsFor,
  repoParts,
  resolveBase,
  splitRepoPath,
  REPO_NAME,
  type Member,
  type RepoCommit,
  type RepoPart,
  type RepoRef,
  type WorkspaceRepo,
} from './multi.js';
