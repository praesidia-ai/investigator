// Owner: WP-R. Regular expressions for rules: a syntax check that rejects the worst forms (back-references, repeated
// groups that themselves repeat), with caps on pattern, line and file length. The check alone cannot rule out slow
// patterns (`.*.*.*x` passes it and still backtracks for minutes on a long line), so every rule pattern also runs in
// a worker with a time budget (src/rules/sandbox.ts): a pattern that runs past it stops and the rule is an error.
import { JuratorError } from '../util/errors.js';

export const MAX_PATTERN_LENGTH = 400;
/** Lines longer than this are matched on their first MAX_LINE_LENGTH characters (minified files, data blobs). */
export const MAX_LINE_LENGTH = 2000;
/** Whole-file patterns (flags s or m) see at most this many characters of a file. */
export const MAX_FILE_LENGTH = 500_000;

/** Why a pattern is not safe to run, or null when it is. Pure syntax check; `new RegExp` still validates after. */
export function unsafeReason(pattern: string): string | null {
  if (pattern.length === 0) return 'the pattern is empty';
  if (pattern.length > MAX_PATTERN_LENGTH) return `the pattern is longer than ${MAX_PATTERN_LENGTH} characters`;
  /** One entry per open group: whether a quantifier or an alternative (|) occurs anywhere inside it. */
  const groups: boolean[] = [];
  let inClass = false;
  /** True right after a group that contains a quantifier was closed. */
  let closedRepeatingGroup = false;
  for (let i = 0; i < pattern.length; i += 1) {
    const c = pattern[i] as string;
    if (c === '\\') {
      const next = pattern[i + 1];
      if (next === undefined) return 'the pattern ends with a lone backslash';
      if (!inClass && (/[1-9]/u.test(next) || next === 'k')) return 'the pattern uses a back-reference';
      i += 1;
      closedRepeatingGroup = false;
      continue;
    }
    if (inClass) {
      if (c === ']') inClass = false;
      continue;
    }
    if (c === '[') {
      inClass = true;
      closedRepeatingGroup = false;
      continue;
    }
    if (c === '(') {
      groups.push(false);
      if (pattern[i + 1] === '?') {
        const rest = pattern.slice(i + 1);
        const prefix = /^\?(?::|=|!|<=|<!|<[A-Za-z_$][\w$]*>)/u.exec(rest);
        if (!prefix) return 'the pattern has a group form that is not supported';
        i += prefix[0].length;
      }
      closedRepeatingGroup = false;
      continue;
    }
    if (c === ')') {
      const hadQuantifier = groups.pop();
      if (hadQuantifier === undefined) return 'the pattern has unbalanced parentheses';
      if (hadQuantifier && groups.length > 0) groups[groups.length - 1] = true;
      closedRepeatingGroup = hadQuantifier;
      continue;
    }
    const brace = c === '{' ? /^\{(\d+)(,(\d*))?\}/u.exec(pattern.slice(i)) : null;
    if (c === '*' || c === '+' || c === '?' || brace) {
      let repeats = c === '*' || c === '+';
      if (brace) {
        const min = Number(brace[1]);
        const max = brace[2] === undefined ? min : brace[3] === '' ? Infinity : Number(brace[3]);
        repeats = max > 1;
        i += brace[0].length - 1;
      }
      if (repeats && closedRepeatingGroup) {
        return 'the pattern repeats a group that has its own repeats or alternatives (like (a+)+ or (a|ab)*), which can hang';
      }
      if (groups.length > 0) groups[groups.length - 1] = true;
      if (pattern[i + 1] === '?') i += 1; // lazy modifier
      closedRepeatingGroup = false;
      continue;
    }
    if (c === '|' && groups.length > 0) groups[groups.length - 1] = true;
    closedRepeatingGroup = false;
  }
  if (inClass) return 'the pattern has an unclosed [ character class';
  if (groups.length > 0) return 'the pattern has unbalanced parentheses';
  return null;
}

/** Keeps only the flags rules allow (i m s u), without duplicates; throws on anything else. */
export function normalizeFlags(flags: string | null | undefined): string {
  const raw = (flags ?? '').replace(/[\sgy]/gu, '');
  if (!/^[imsu]*$/u.test(raw)) throw new JuratorError('BAD_PATTERN', `flags "${flags}" are not allowed (use i, m, s or u)`);
  return [...new Set(raw)].sort().join('');
}

/** Compiles a rule pattern after the safety check. `extraFlags` (e.g. 'g') are added by the engine, never by rules. */
export function compileSafe(pattern: string, flags = '', extraFlags = ''): RegExp {
  const reason = unsafeReason(pattern);
  if (reason) throw new JuratorError('UNSAFE_PATTERN', `/${pattern}/ is not safe to run: ${reason}`);
  const all = normalizeFlags(flags) + extraFlags;
  try {
    return new RegExp(pattern, all);
  } catch (error) {
    throw new JuratorError('BAD_PATTERN', `/${pattern}/ is not a valid pattern: ${(error as Error).message}`);
  }
}

/** A pattern as people read it: `requireAdmin\(` -> `requireAdmin(`; anything with regex syntax stays `/.../`. */
export function displayPattern(pattern: string): string {
  if (/^(?:[^\\.*+?()[\]{}|^$]|\\[^A-Za-z0-9])+$/u.test(pattern)) return pattern.replace(/\\(.)/gu, '$1');
  return `/${pattern}/`;
}
