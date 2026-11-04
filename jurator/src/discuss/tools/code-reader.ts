// Owner: DS-A. Code as the discuss tools see it: git objects at one commit (never the working tree, so untracked .env
// files are never seen), secret files refused, every line masked (src/model/secrets.ts keeps line numbers).
import { isAbsolute, relative, sep } from 'node:path';
import type { Citation, GitRepo } from '../../contracts.js';
import { repoParts, runGit } from '../../git/index.js';
import { BRAND } from '../../brand.js';
import { isSecretFile, maskSecrets } from '../../model/secrets.js';
import { JuratorError } from '../../util/errors.js';
import { matchesAny } from '../../util/glob.js';

export interface GrepHit {
  readonly path: string;
  readonly line: number;
  /** The masked line, copied from git. */
  readonly text: string;
}

export interface GrepResult {
  readonly hits: readonly GrepHit[];
  /** Files with at least one hit (before the caps). */
  readonly files: number;
  /** Hits found before the caps (per-file cap applied by git). */
  readonly total: number;
  readonly truncated: boolean;
  /** Files with hits per top folder (two path segments), most first, when the hits were cut. */
  readonly folders: ReadonlyArray<{ readonly folder: string; readonly files: number }>;
}

export interface GrepOptions {
  readonly query: string;
  readonly regex: boolean;
  readonly caseSensitive: boolean;
  readonly glob: string | null;
  readonly maxHits: number;
  readonly maxPerFile: number;
  /** Globs of the code that matters most (the config's code scope): their hits come first. */
  readonly prefer?: readonly string[];
}

/** Tests, docs, fixtures and lock files: their hits come after the code's. */
const SIDE_PATH = /(?:^|\/)(?:tests?|__tests__|specs?|e2e|fixtures?|docs?|examples?|mocks?|__mocks__|dist|build)\/|\.(?:test|spec)\.[A-Za-z]+$|(?:^|\/)[^/]*\.lock$|(?:^|\/)package-lock\.json$/u;

/** 0: in the preferred scope, 1: other code, 2: tests, docs and lock files. */
export function hitRank(path: string, prefer: readonly string[] = []): number {
  if (SIDE_PATH.test(path)) return 2;
  return prefer.length > 0 && matchesAny(path, prefer) ? 0 : 1;
}

/** `*.py` means any .py file; a glob with a folder in it is taken as written. */
export function widenGlob(glob: string): string {
  const g = glob.trim().replace(/^\.\//u, '');
  return g.includes('/') ? g : `**/${g}`;
}

export class CodeReader {
  readonly repo: GitRepo;
  readonly root: string;
  /** The session snapshot commit (composite in a workspace). */
  readonly commit: string;
  readonly #files = new Map<string, Promise<string[]>>();

  constructor(repo: GitRepo, root: string, commit: string) {
    this.repo = repo;
    this.root = root;
    this.commit = commit;
  }

  /** A repo path the tools accept: relative, '/' separators, no '..'. Throws BAD_INPUT otherwise. */
  normalize(raw: string): string {
    let p = raw.trim().replace(/\\/gu, '/');
    if (isAbsolute(p)) {
      const rel = relative(this.root, p);
      if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new JuratorError('BAD_INPUT', `${raw} is outside the workspace.`);
      p = rel.split(sep).join('/');
    }
    p = p.replace(/^(?:\.\/)+/u, '').replace(/\/{2,}/gu, '/');
    if (!p || p.includes('\0') || /[\r\n]/u.test(p) || p.startsWith('-') || /^[A-Za-z]:/u.test(p)) {
      throw new JuratorError('BAD_INPUT', `"${raw}" is not a repo path.`);
    }
    if (p.split('/').some((seg) => seg === '..')) throw new JuratorError('BAD_INPUT', `"${raw}" goes outside the repo ('..' is not allowed).`);
    return p;
  }

  /** The file's lines at `commit`, masked. Throws SECRET_FILE for .env/.pem/.key files, FILE_NOT_IN_COMMIT when absent. */
  lines(path: string, commit: string = this.commit): Promise<string[]> {
    if (isSecretFile(path)) {
      return Promise.reject(new JuratorError('SECRET_FILE', `${path} is a secret file (.env, key or certificate); it is never read.`));
    }
    const key = `${commit}\0${path}`;
    let got = this.#files.get(key);
    if (!got) {
      got = this.repo.readFile(commit, path).then((text) => {
        const lines = maskSecrets(text, path).text.split('\n');
        if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
        return lines.map((l) => l.replace(/\r$/u, ''));
      });
      got.catch(() => this.#files.delete(key));
      this.#files.set(key, got);
    }
    return got;
  }

  /** Lines start..end copied from git at `commit` (masked), as a citation; null when out of range. */
  async copy(path: string, start: number, end: number, commit: string = this.commit): Promise<Citation | null> {
    const lines = await this.lines(path, commit);
    if (start < 1 || end < start || end > lines.length) return null;
    return { path, commit, startLine: start, endLine: end, quote: lines.slice(start - 1, end).join('\n') };
  }

  /** Tracked files at the snapshot matching any glob, secret files left out. */
  async listFiles(globs: readonly string[]): Promise<string[]> {
    const files = await this.repo.listFiles(this.commit, globs.map(widenGlob));
    return files.filter((f) => !isSecretFile(f));
  }

  /** `git grep` at the snapshot in every repo of the workspace; hit lines re-copied from git and masked. */
  async grep(options: GrepOptions): Promise<GrepResult> {
    const parts = await repoParts(this.repo, this.commit);
    const raw: Array<{ path: string; line: number }> = [];
    for (const part of parts) {
      const root = part.repo.root;
      const args = ['grep', '-n', '-I', '--null', '--no-color', `--max-count=${options.maxPerFile}`];
      if (!options.caseSensitive) args.push('-i');
      args.push(options.regex ? '-P' : '-F');
      args.push('-e', options.query, part.commit, '--');
      let out = await runGit(root, args);
      if (out.code > 1 && options.regex) {
        // git built without PCRE: extended regular expressions instead
        args[args.indexOf('-P')] = '-E';
        out = await runGit(root, args);
      }
      if (out.code > 1) {
        throw new JuratorError('BAD_INPUT', `git grep could not use that ${options.regex ? 'regular expression' : 'text'}.`);
      }
      for (const row of out.stdout.split('\n')) {
        if (!row) continue;
        const a = row.indexOf('\0');
        const b = a < 0 ? -1 : row.indexOf('\0', a + 1);
        if (a < 0 || b < 0) continue;
        const where = row.slice(0, a);
        const prefix = `${part.commit}:`;
        const repoPath = where.startsWith(prefix) ? where.slice(prefix.length) : where.slice(where.indexOf(':') + 1);
        const path = `${part.prefix}${repoPath}`;
        const line = Number(row.slice(a + 1, b));
        if (!Number.isInteger(line) || line < 1 || isSecretFile(path) || path.startsWith(`${BRAND.folder}/`)) continue;
        if (options.glob && !matchesAny(path, [widenGlob(options.glob)])) continue;
        raw.push({ path, line });
      }
    }
    const prefer = options.prefer ?? [];
    const rank = new Map<string, number>();
    const rankOf = (p: string): number => {
      let r = rank.get(p);
      if (r === undefined) rank.set(p, (r = hitRank(p, prefer)));
      return r;
    };
    raw.sort((x, y) => rankOf(x.path) - rankOf(y.path) || (x.path === y.path ? x.line - y.line : x.path < y.path ? -1 : 1));
    const fileSet = new Set(raw.map((h) => h.path));
    const files = fileSet.size;
    const byFolder = new Map<string, number>();
    for (const f of fileSet) {
      const folder = f.split('/').slice(0, 2).join('/');
      byFolder.set(folder, (byFolder.get(folder) ?? 0) + 1);
    }
    const folders = [...byFolder.entries()]
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
      .slice(0, 12)
      .map(([folder, n]) => ({ folder, files: n }));
    const hits: GrepHit[] = [];
    for (const h of raw.slice(0, options.maxHits)) {
      let text: string | undefined;
      try {
        text = (await this.lines(h.path))[h.line - 1];
      } catch {
        text = undefined;
      }
      if (text !== undefined) hits.push({ path: h.path, line: h.line, text });
    }
    const truncated = raw.length > options.maxHits;
    return { hits, files, total: raw.length, truncated, folders: truncated ? folders : [] };
  }
}
