// R5-A: which files a model sees, and which files a rule may read. The live workspace run showed both going wrong:
// prompts filled a 30k window with the first repo by sort order (backend promises judged on extension files), and rule
// globs such as `**/*.ts` read tests and fixtures outside the promise's code. No AI here; everything is deterministic.
import type { PromiseRecord } from '../contracts.js';
import { globToRegExp, matchesAny } from '../util/glob.js';

/** Folders that hold tests or test data, never the product's code. */
const TEST_DIR = /^(?:test|tests|__tests__|__mocks__|__fixtures__|fixture|fixtures|e2e)$/iu;
/** Test files and test data by name: `a.test.ts`, `a.spec.js`, `test_a.py`, `a_test.go`, `conftest.py`, `fixtures.ts`. */
const TEST_FILE =
  /(?:\.(?:test|spec)\.[A-Za-z0-9]+$)|(?:^test_[^/]*\.py$)|(?:_test\.(?:py|go)$)|(?:^conftest\.py$)|(?:^fixtures?\.[A-Za-z0-9]+$)|(?:\.fixtures?\.[A-Za-z0-9]+$)/iu;
/** A glob that names tests on purpose (`tests/**`, `**\/*.test.ts`, `**\/fixtures/**`). */
const TEST_GLOB = /(?:^|\/)(?:test|tests|__tests__|__mocks__|__fixtures__|fixtures?|e2e)(?:\/|$)|\.(?:test|spec)\.|(?:^|\/)test_|_test\.|conftest/iu;
/** A promise about tests themselves ("every route has a test"). */
const ABOUT_TESTS = /\b(?:tests?|testing|test suites?|fixtures?|unit tests?|specs?)\b/iu;

/** Is this path a test or test data (the default rule never reads it)? */
export function isTestPath(path: string): boolean {
  const parts = path.split('/');
  const file = parts[parts.length - 1] ?? '';
  if (TEST_FILE.test(file)) return true;
  return parts.slice(0, -1).some((dir) => TEST_DIR.test(dir));
}

/** Does this glob name tests or fixtures on purpose? */
export function globNamesTests(glob: string): boolean {
  return TEST_GLOB.test(glob);
}

/** A rule whose globs name tests reads them; every other rule skips tests and fixtures (R5-A). */
export function ruleReadsTests(globs: readonly string[]): boolean {
  return globs.some(globNamesTests);
}

/** Is the promise about tests themselves? Only then may a rule read tests and fixtures. */
export function promiseAboutTests(promise: Pick<PromiseRecord, 'wording' | 'quote'>): boolean {
  return ABOUT_TESTS.test(promise.wording) || ABOUT_TESTS.test(promise.quote.text);
}

/** The literal folder a glob starts with: `src/agent/**\/*.ts` -> `src/agent`; `**\/*.ts` -> ''. */
export function literalPrefix(glob: string): string {
  const parts = glob.split('/');
  const out: string[] = [];
  for (const part of parts.slice(0, -1)) {
    if (/[*?[\]{}]/u.test(part)) break;
    out.push(part);
  }
  // A glob with no wildcard at all names one file: its folder is the prefix.
  return out.join('/');
}

const hasWildcard = (glob: string): boolean => /[*?]/u.test(glob);
const isUnder = (path: string, dir: string): boolean => dir === '' || path === dir || path.startsWith(`${dir}/`);

/** Is every path this glob can match inside one of the scope globs? (Checked on the glob's literal folder.) */
export function globInside(glob: string, scope: readonly string[]): boolean {
  if (!hasWildcard(glob)) return matchesAny(glob, scope);
  const lit = literalPrefix(glob);
  if (lit === '') return false;
  // `P/**` style scopes: the glob's folder must be P or below it.
  return scope.some((s) => {
    if (!s.endsWith('/**')) return false;
    const p = s.slice(0, -3);
    return !hasWildcard(p) && isUnder(lit, p);
  });
}

/** The file-name part of a glob worth keeping when narrowing (`**\/*.ts` -> `*.ts`; `src/**` -> null). */
function fileTail(glob: string): string | null {
  const last = glob.split('/').pop() ?? '';
  if (last === '' || last === '**') return null;
  return hasWildcard(last) || last.includes('.') ? last : null;
}

/**
 * Narrows one rule glob to the promise's code scope: kept when it is inside the scope, else the scope folders it
 * overlaps with (keeping its file-name part, `*.ts`). Each candidate is kept only when `paths` shows it matches some
 * file and no file the original glob would skip. Returns [] when nothing inside the scope fits.
 */
export function narrowGlob(glob: string, scope: readonly string[], paths: readonly string[]): string[] {
  if (globInside(glob, scope)) return [glob];
  const original = globToRegExp(glob);
  const lit = literalPrefix(glob);
  const tail = fileTail(glob);
  const out: string[] = [];
  for (const s of scope) {
    if (!s.endsWith('/**')) continue;
    const p = s.slice(0, -3);
    if (hasWildcard(p) || !isUnder(p, lit)) continue;
    const candidate = tail ? `${p}/**/${tail}` : s;
    const re = globToRegExp(candidate);
    const hits = paths.filter((x) => re.test(x));
    if (hits.length > 0 && hits.every((x) => original.test(x)) && !out.includes(candidate)) out.push(candidate);
  }
  return out;
}

/** The first folder of a path: the repo in a workspace (`chrome-extension/src/a.ts` -> `chrome-extension`). */
export function groupOf(path: string): string {
  const slash = path.indexOf('/');
  return slash > 0 ? path.slice(0, slash) : '';
}

const STOP = new Set([
  'must', 'never', 'only', 'with', 'that', 'this', 'from', 'into', 'their', 'there', 'when', 'within', 'after', 'before',
  'every', 'each', 'shall', 'should', 'will', 'have', 'been', 'being', 'which', 'other', 'than', 'such', 'they', 'them',
  'user', 'users', 'data', 'keep', 'kept', 'does', 'make', 'made', 'more', 'most', 'least', 'also', 'even', 'were',
]);

/** Words of a promise worth looking for in file paths and text (lowercase, 4+ letters, no stop words). */
export function promiseWords(promise: Pick<PromiseRecord, 'wording'> & { facets?: PromiseRecord['facets'] }): string[] {
  const text = [promise.wording, promise.facets?.subject ?? '', promise.facets?.action ?? ''].join(' ').toLowerCase();
  const words = new Set<string>();
  for (const w of text.split(/[^a-z0-9]+/u)) {
    if (w.length < 4 || STOP.has(w)) continue;
    words.add(w.endsWith('s') && w.length > 4 ? w.slice(0, -1) : w);
  }
  return [...words];
}

export interface FairOrderOptions<T> {
  /** The promise's scope: files inside it come first. */
  readonly scope: readonly string[];
  /** Files that go before everything else (changed files in a check). */
  readonly first?: (item: T) => boolean;
  /** Words to rank files by within a repo (path hits count 3, text hits 1). */
  readonly words?: readonly string[];
  readonly textOf?: (item: T) => string | undefined;
}

/**
 * The order files are shown to a model: `first`, then the promise's scope, then the rest. Within each tier the repos
 * (first folder) take turns, so one repo never fills the window by sort order; within a repo, files that name the
 * promise's words come first, then by path.
 */
export function fairOrder<T>(items: readonly T[], pathOf: (item: T) => string, options: FairOrderOptions<T>): T[] {
  const words = options.words ?? [];
  const score = (item: T): number => {
    if (words.length === 0) return 0;
    const path = pathOf(item).toLowerCase();
    const text = options.textOf?.(item)?.toLowerCase();
    let n = 0;
    for (const w of words) {
      if (path.includes(w)) n += 3;
      else if (text?.includes(w)) n += 1;
    }
    return n;
  };
  const tierOf = (item: T): number =>
    options.first?.(item) ? 0 : options.scope.length > 0 && matchesAny(pathOf(item), options.scope) ? 1 : 2;
  const tiers: T[][] = [[], [], []];
  for (const item of items) tiers[tierOf(item)]!.push(item);
  const out: T[] = [];
  for (const tier of tiers) {
    const groups = new Map<string, Array<{ item: T; score: number; path: string }>>();
    for (const item of tier) {
      const path = pathOf(item);
      const g = groupOf(path);
      const list = groups.get(g) ?? [];
      list.push({ item, score: score(item), path });
      groups.set(g, list);
    }
    const lists = [...groups.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .map(([, list]) => list.sort((a, b) => b.score - a.score || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)));
    for (let i = 0; lists.some((l) => i < l.length); i += 1) {
      for (const l of lists) if (i < l.length) out.push(l[i]!.item);
    }
  }
  return out;
}
