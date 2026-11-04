// Owner: WP-B. Finding a binding again at another commit: same lines, the same quote moved, or the same symbol changed.
import type { Binding, GitRepo } from '../contracts.js';
import { sha256 } from '../util/json.js';
import { declaredName, hasWord, keyName, wordRe } from './symbols.js';

export type AnchorStatus = 'same' | 'moved' | 'changed';
export interface Anchored {
  readonly startLine: number;
  readonly endLine: number;
  readonly quote: string;
  readonly status: AnchorStatus;
}

const splitLines = (text: string): string[] => text.split(/\r?\n/u);
const VALUE_KINDS = new Set<Binding['kind']>(['constant', 'config', 'allowlist']);
const IMPORT = /^\s*(?:import\b|export\s+(?:\*|\{[^}]*\})\s+from\b|(?:const|let|var)\s+\{[^}]*\}\s*=\s*require\()/u;

/** Where `quote` (one or more whole lines) occurs in `lines`: every start line, 1-based. */
function findBlock(lines: readonly string[], quote: readonly string[]): number[] {
  const out: number[] = [];
  if (quote.length === 0) return out;
  for (let i = 0; i + quote.length <= lines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < quote.length && ok; j += 1) ok = lines[i + j] === quote[j];
    if (ok) out.push(i + 1);
  }
  return out;
}
const nearest = (candidates: readonly number[], to: number): number =>
  [...candidates].sort((a, b) => Math.abs(a - to) - Math.abs(b - to) || a - b)[0] as number;

/** The same binding located in a file's text (pure; `reanchor` reads the file from git). */
export function anchorIn(binding: Binding, text: string): Anchored | null {
  const lines = splitLines(text);
  const quote = splitLines(binding.quote);
  const span = quote.length;
  const at = (start: number): string => lines.slice(start - 1, start - 1 + span).join('\n');
  if (binding.startLine + span - 1 <= lines.length && at(binding.startLine) === binding.quote) {
    return { startLine: binding.startLine, endLine: binding.startLine + span - 1, quote: binding.quote, status: 'same' };
  }
  const moved = findBlock(lines, quote);
  if (moved.length > 0) {
    const start = nearest(moved, binding.startLine);
    return { startLine: start, endLine: start + span - 1, quote: binding.quote, status: 'moved' };
  }
  const symbol = binding.symbol;
  if (!symbol) return null;
  // The symbol's line inside the old quote, so a multi-line binding (route .. guard) keeps its shape.
  const offset = Math.max(0, quote.findIndex((l) => hasWord(l, symbol)));
  const declares = (l: string): boolean => declaredName(l) === symbol || keyName(l) === symbol;
  const call = new RegExp(`${wordRe(symbol).source}\\s*\\(`, 'u');
  const all: number[] = [];
  const decl: number[] = [];
  const calls: number[] = [];
  lines.forEach((l, i) => {
    if (!hasWord(l, symbol) || IMPORT.test(l)) return;
    all.push(i + 1);
    if (declares(l)) decl.push(i + 1);
    if (call.test(l)) calls.push(i + 1);
  });
  // A value binding follows its declaration only (a usage like `CHAT_TTL_DAYS * 24` is not where the value lives); a
  // guard or call follows a call of the same name (an import line is never where a promise is kept).
  const pool = VALUE_KINDS.has(binding.kind)
    ? decl
    : binding.kind === 'guard' || binding.kind === 'call'
      ? calls
      : decl.length > 0
        ? decl
        : all;
  if (pool.length === 0) return null;
  const symbolLine = nearest(pool, binding.startLine + offset);
  const start = Math.max(1, symbolLine - offset);
  const end = Math.min(lines.length, start + span - 1);
  return { startLine: start, endLine: end, quote: lines.slice(start - 1, end).join('\n'), status: 'changed' };
}

/** Finds a binding's lines at another commit (same quote moved, or same symbol); null when lost. */
export async function reanchor(binding: Binding, repo: GitRepo, commit: string): Promise<Anchored | null> {
  let text: string;
  try {
    text = await repo.readFile(commit, binding.path);
  } catch {
    return null;
  }
  return anchorIn(binding, text);
}

/** A binding moved to where it is at `commit` (same id, new lines, quote copied from git there). */
export function movedTo(binding: Binding, anchored: Anchored, commit: string): Binding {
  return {
    ...binding,
    startLine: anchored.startLine,
    endLine: anchored.endLine,
    quote: anchored.quote,
    quoteSha256: sha256(anchored.quote),
    anchoredAt: commit,
  };
}

/**
 * Every binding re-anchored at `commit` (for a diff: at its old side, before `touchedBindings`). Lost bindings keep
 * their old position and come back with status 'lost', so callers can still say what went missing.
 */
export async function anchorAll(
  bindings: readonly Binding[],
  repo: GitRepo,
  commit: string,
): Promise<Array<{ binding: Binding; status: AnchorStatus | 'lost' }>> {
  const files = new Map<string, string | null>();
  const out: Array<{ binding: Binding; status: AnchorStatus | 'lost' }> = [];
  for (const b of bindings) {
    if (!files.has(b.path)) files.set(b.path, await repo.readFile(commit, b.path).catch(() => null));
    const text = files.get(b.path) ?? null;
    const a = text === null ? null : anchorIn(b, text);
    out.push(a ? { binding: a.status === 'same' ? b : movedTo(b, a, commit), status: a.status } : { binding: b, status: 'lost' });
  }
  return out;
}
