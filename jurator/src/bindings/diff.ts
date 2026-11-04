// Owner: WP-B. Which lines a change touched (git diff -U0) and which bindings sit on them.
import type { Binding, GitRepo } from '../contracts.js';
import { isWorkspaceRepo, repoParts, resolveBase, runGit } from '../git/index.js';
import { JuratorError } from '../util/errors.js';
import { byBindingId } from './store.js';
import { excerpt } from './symbols.js';

/** Changed line ranges per file between two commits (git diff -U0), new-side and old-side line numbers. */
export interface LineChange {
  readonly path: string;
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
}

/** Undoes git's C-style quoting of unusual paths ("a/x\tb" -> a/x<TAB>b, octal escapes for raw bytes). */
export function unquotePath(raw: string): string {
  if (!raw.startsWith('"') || !raw.endsWith('"')) return raw;
  const body = raw.slice(1, -1);
  const bytes: number[] = [];
  const simple: Record<string, number> = { n: 10, t: 9, r: 13, '"': 34, '\\': 92, a: 7, b: 8, f: 12, v: 11 };
  for (let i = 0; i < body.length; i += 1) {
    const c = body[i] as string;
    if (c !== '\\') {
      bytes.push(...Buffer.from(c, 'utf8'));
      continue;
    }
    const next = body[i + 1] ?? '';
    if (/[0-7]/u.test(next)) {
      bytes.push(parseInt(body.slice(i + 1, i + 4), 8));
      i += 3;
    } else {
      bytes.push(simple[next] ?? next.charCodeAt(0));
      i += 1;
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

/** `--- a/src/x.ts` / `+++ b/src/x.ts` / `/dev/null` -> repo path or null. */
function sidePath(raw: string, prefix: 'a/' | 'b/'): string | null {
  const text = unquotePath(raw.replace(/\t$/u, ''));
  if (text === '/dev/null') return null;
  return text.startsWith(prefix) ? text.slice(prefix.length) : text;
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u;

/**
 * Parses `git diff -U0` output into hunks. The path is the new path, or the old one for a deleted file, so bindings
 * (stored with old-side line numbers) can be matched. Binary files have no hunks and are skipped.
 */
export function parseUnifiedDiff(text: string): LineChange[] {
  const out: LineChange[] = [];
  let oldPath: string | null = null;
  let newPath: string | null = null;
  // Inside a hunk, a removed line `-- x` reads as `--- x`: headers count only before the first hunk of a file.
  let inHunk = false;
  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) {
      oldPath = null;
      newPath = null;
      inHunk = false;
    } else if (!inHunk && line.startsWith('--- ')) oldPath = sidePath(line.slice(4), 'a/');
    else if (!inHunk && line.startsWith('+++ ')) newPath = sidePath(line.slice(4), 'b/');
    else if (line.startsWith('@@')) {
      inHunk = true;
      const m = HUNK.exec(line);
      const path = newPath ?? oldPath;
      if (!m || path === null) continue;
      out.push({
        path,
        oldStart: Number(m[1]),
        oldLines: m[2] === undefined ? 1 : Number(m[2]),
        newStart: Number(m[3]),
        newLines: m[4] === undefined ? 1 : Number(m[4]),
      });
    }
  }
  return out;
}

/**
 * `git diff -U0 base...head` (what head changed since it left base, the same range as GitRepo.changedFiles), run with
 * execFile (no shell). Renames are shown as delete + add, so a binding in a moved file counts as touched.
 */
export async function changedLines(repo: GitRepo, base: string, head: string): Promise<LineChange[]> {
  if (isWorkspaceRepo(repo)) {
    // R4-WS: each repo's diff between its own commits, paths prefixed with the repo name.
    const before = new Map((await repoParts(repo, await resolveBase(repo, base))).map((p) => [p.prefix, p.commit] as const));
    const out: LineChange[] = [];
    for (const part of await repoParts(repo, head)) {
      const was = before.get(part.prefix);
      if (was === undefined || was === part.commit) continue;
      for (const c of await changedLines(part.repo, was, part.commit)) out.push({ ...c, path: `${part.prefix}${c.path}` });
    }
    return out;
  }
  const b = await repo.resolve(base);
  const h = await repo.resolve(head);
  const out = await runGit(repo.root, [
    'diff',
    '-U0',
    '--no-color',
    '--no-ext-diff',
    '--no-textconv',
    '--no-renames',
    '--src-prefix=a/',
    '--dst-prefix=b/',
    `${b}...${h}`,
  ]);
  if (out.code !== 0) throw new JuratorError('GIT_FAILED', `git diff failed: ${out.stderr.trim()}`);
  return parseUnifiedDiff(out.stdout);
}

/**
 * True when a hunk touches lines start..end on the old side. A pure insertion (oldLines 0, after line oldStart)
 * touches the range only when it lands between two of its lines.
 */
export function overlaps(change: LineChange, start: number, end: number): boolean {
  if (change.oldLines === 0) return change.oldStart >= start && change.oldStart < end;
  const last = change.oldStart + change.oldLines - 1;
  return change.oldStart <= end && start <= last;
}

/** "touched CHAT_TTL_DAYS = 30 at src/agent/chats.ts:2 (bound to privacy.01)". */
export function touchReason(binding: Binding): string {
  const lines = binding.startLine === binding.endLine ? `${binding.startLine}` : `${binding.startLine}-${binding.endLine}`;
  return `touched ${excerpt(binding)} at ${binding.path}:${lines} (bound to ${binding.promiseId})`;
}

/**
 * Bindings whose line range (old side) overlaps a change, with a human reason per hit, sorted by binding id. The
 * bindings must be anchored at the diff's old side (re-anchor them there first when they were bound elsewhere).
 */
export function touchedBindings(bindings: readonly Binding[], changes: readonly LineChange[]): Array<{ binding: Binding; reason: string }> {
  const out: Array<{ binding: Binding; reason: string }> = [];
  for (const binding of bindings) {
    if (changes.some((c) => c.path === binding.path && overlaps(c, binding.startLine, binding.endLine))) {
      out.push({ binding, reason: touchReason(binding) });
    }
  }
  return out.sort((a, b) => byBindingId(a.binding, b.binding));
}
