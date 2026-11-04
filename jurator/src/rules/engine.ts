// Owner: WP-R. The rules engine: deterministic, no AI, same answer every time (principle 2).
// FX-1: rules read code, not comments (src/rules/code-text.ts); every rule pattern runs in a worker with a time budget
// (src/rules/sandbox.ts); an each-near rule with nothing to check is an error, never a pass; a must-match rule on a
// promise with a number reads the value the constant is set to (a literal, or arithmetic on literals) and fails when
// it breaks the number or is not a literal.
import type { Citation, Rule, RuleRunResult, SourceFile } from '../contracts.js';
import { matchesAny } from '../util/glob.js';
import { codeView, valueAssigned, valueProblem, type ValueConstraint } from './code-text.js';
import { compileSafe, displayPattern, MAX_FILE_LENGTH, MAX_LINE_LENGTH, normalizeFlags } from './regex.js';
import { removeMatches, scanLines, scanText } from './sandbox.js';
import { isTestPath, ruleReadsTests } from './select.js';

/** At most this many citations per result; the message still counts every hit. */
export const MAX_HITS = 50;
export const DEFAULT_WITHIN = 3;
/** How an each-near rule whose anchor matches nothing starts its error message (check falls back on it). */
export const NOTHING_TO_CHECK = 'rule found nothing to check';

/** What else `runRule` may know: the promise's number (from its typed facets), for value rules. */
export interface RunOptions {
  readonly constraint?: ValueConstraint | null;
}

interface View {
  readonly file: SourceFile;
  /** The lines as git stores them (citations quote these). */
  readonly lines: string[];
  /** Comments blanked. */
  readonly code: string[];
  /** Comments blanked and string-only lines emptied: what can satisfy a rule. */
  readonly live: string[];
  /** Comments and docstrings blanked, and the words of messages inside strings: what can break a must-not-match rule. */
  readonly text: string[];
}
interface Match {
  readonly file: SourceFile;
  readonly view: number;
  readonly lines: readonly string[];
  readonly startLine: number;
  readonly endLine: number;
  readonly text: string;
}

export function splitLines(text: string): string[] {
  return text.split(/\r?\n/u);
}
const capLine = (line: string): string => (line.length > MAX_LINE_LENGTH ? line.slice(0, MAX_LINE_LENGTH) : line);

/** Patterns run per line unless the rule has the s or m flag (each-near always runs per line). */
export function isWholeFile(rule: Rule): boolean {
  return rule.mode !== 'each-near' && /[sm]/u.test(rule.flags ?? '');
}
/** The flags used per line: s and m only make sense over a whole file. */
function lineFlags(rule: Rule): string {
  return normalizeFlags(rule.flags).replace(/[sm]/gu, '');
}
export function filesForRule(rule: Rule, files: readonly SourceFile[]): SourceFile[] {
  // R5-A: tests and fixtures are never the product's code; a rule reads them only when its globs name them.
  const tests = ruleReadsTests(rule.globs);
  return files.filter((f) => matchesAny(f.path, rule.globs) && (tests || !isTestPath(f.path))).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
function viewsOf(files: readonly SourceFile[]): View[] {
  return files.map((file) => ({ file, lines: splitLines(file.text), ...codeView(file.path, file.text) }));
}

function cite(m: Match, commit: string): Citation {
  return {
    path: m.file.path,
    commit,
    startLine: m.startLine,
    endLine: m.endLine,
    quote: m.lines.slice(m.startLine - 1, m.endLine).join('\n'),
  };
}
const where = (m: Pick<Match, 'file' | 'startLine'>): string => `${m.file.path}:${m.startLine}`;

/** Every place a rule pattern matches (in the sandbox): per line, or over the whole file for s/m patterns. */
function findMatches(views: readonly View[], pattern: string, flags: string, wholeFile: boolean, which: 'code' | 'live' | 'text'): Match[] {
  const at = (f: number, startLine: number, endLine: number, text: string): Match => {
    const v = views[f] as View;
    return { file: v.file, view: f, lines: v.lines, startLine, endLine, text };
  };
  if (!wholeFile) {
    return scanLines(pattern, flags, views.map((v) => v[which].map(capLine))).map(([f, i, text]) => at(f, i + 1, i + 1, text));
  }
  const texts = views.map((v) => {
    const t = v[which].join('\n');
    return t.length > MAX_FILE_LENGTH ? t.slice(0, MAX_FILE_LENGTH) : t;
  });
  return scanText(pattern, flags, texts, 1000).map(([f, index, text]) => {
    const t = texts[f] as string;
    const startLine = countNewlines(t, 0, index) + 1;
    return at(f, startLine, startLine + countNewlines(t, index, index + Math.max(text.length - 1, 0)), text);
  });
}
/** Matches of a program-built pattern (an escaped name), run here: such patterns cannot hang. */
function localMatches(views: readonly View[], re: RegExp, which: 'code' | 'live'): Match[] {
  const out: Match[] = [];
  views.forEach((v, f) =>
    v[which].forEach((line, i) => {
      const m = re.exec(capLine(line));
      if (m) out.push({ file: v.file, view: f, lines: v.lines, startLine: i + 1, endLine: i + 1, text: m[0] });
    }),
  );
  return out;
}
function countNewlines(text: string, from: number, to: number): number {
  let n = 0;
  for (let i = from; i < to; i += 1) if (text.charCodeAt(i) === 10) n += 1;
  return n;
}
/**
 * The longest name a pattern always requires (outside groups, classes and escapes, with no top-level |), e.g.
 * `CHAT_TTL_DAYS\s*=\s*30\b` -> `CHAT_TTL_DAYS`. Null when there is none of 4+ characters.
 */
export function requiredName(pattern: string): string | null {
  let depth = 0;
  let inClass = false;
  let run = '';
  const runs: string[] = [];
  const flush = (): void => {
    if (run.length > 0) runs.push(run);
    run = '';
  };
  for (let i = 0; i < pattern.length; i += 1) {
    const c = pattern[i] as string;
    if (c === '\\') {
      flush();
      i += 1;
      continue;
    }
    if (inClass) {
      if (c === ']') inClass = false;
      continue;
    }
    if (/[\w$]/u.test(c) && depth === 0) {
      // A quantifier after this character makes it optional or repeated: end the run before it.
      if (/[?*+{]/u.test(pattern[i + 1] ?? '')) flush();
      else run += c;
      continue;
    }
    flush();
    if (c === '[') inClass = true;
    else if (c === '(') depth += 1;
    else if (c === ')') depth = Math.max(0, depth - 1);
    else if (c === '|' && depth === 0) return null;
  }
  flush();
  const best = runs.filter((r) => r.length >= 4 && /[A-Za-z]/u.test(r)).sort((a, b) => b.length - a.length)[0];
  return best ?? null;
}

/* ------------------------------ a call anchor's own definition (SC-3 fix 8) ------------------------------ */

/** Words that can come before a call but never name a return type, and names that are statements, not calls. */
const NOT_A_TYPE = new Set(
  'return await yield new throw else case typeof delete in of not and or if elif while for with assert raise lambda print puts echo go defer do try then when unless until is as from import export default sizeof'.split(' '),
);
const STATEMENT = new Set('if elif while for switch catch with return match foreach until unless'.split(' '));
const METHOD_MODIFIERS = 'public|private|protected|internal|static|async|override|abstract|final|virtual|readonly|synchronized|open|suspend|inline|unsafe|extern|get|set';
const MODIFIERS = `(?:${METHOD_MODIFIERS}|export|default)`;
/** `def name(`, `async def name(`, `function name(`, `func (r *R) Name(`, `fun Foo.name(`, `pub fn name(`. */
const KEYWORD_DEF = new RegExp(
  `^\\s*(?:@\\w+\\s+)*(?:${MODIFIERS}\\s+|pub(?:\\([^)]*\\))?\\s+|declare\\s+|const\\s+)*(?:def|function\\s*\\*?|func|fun|fn)\\s+(?:\\([^)]*\\)\\s*)?(?:[\\w$]+\\.)?$`,
  'u',
);
const DEF_WORD = new RegExp(`(?<![\\w$])(?:def|function|func|fun|fn|${MODIFIERS})(?![\\w$])`, 'u');
/** A method signature with modifiers before the name (`  async getJobStatus(`, `public static save(`). */
const MODIFIED_METHOD = new RegExp(`^\\s*(?:(?:${METHOD_MODIFIERS})\\s+)+$`, 'u');
/** A typed method (`public JobStatus getJobStatus(`, `Status get(`): modifiers, then one type that is not a keyword. */
const TYPED_METHOD = new RegExp(`^\\s*(?:${MODIFIERS}\\s+)*([A-Za-z_$][\\w$.]*(?:<[^()=]*>)?(?:\\[\\])*\\??)\\s+$`, 'u');

/** The text after the parameter list that `rest` opens (`(a, b): T {` -> `: T {`); null when it does not close here. */
function afterParams(rest: string): string | null {
  const open = rest.indexOf('(');
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < rest.length; i += 1) {
    if (rest[i] === '(') depth += 1;
    else if (rest[i] === ')') {
      depth -= 1;
      if (depth === 0) return rest.slice(i + 1);
    }
  }
  return null;
}

/**
 * Does `line` (comments blanked) define the name that an anchor match `matched` ends by calling? `matched` must end in
 * `name(` (spaces allowed): `async def get_job_status(` and `function save(` define it; `job_manager.get_job_status(`
 * and `await save(` call it. A method with no keyword is a definition when its parameter list opens a body
 * (`save(id: string): Promise<void> {`); a call followed by `.then(` or `;` is not.
 */
export function definesCalledName(line: string, matched: string): boolean {
  const m = /([A-Za-z_$][\w$]*)\s*\($/u.exec(matched);
  if (!m || STATEMENT.has((m[1] as string).toLowerCase())) return false;
  // An anchor that itself matches the keyword (`def\s+\w+_handler\(`) is about definitions: keep them.
  if (DEF_WORD.test(matched.slice(0, m.index))) return false;
  const at = line.indexOf(matched);
  if (at < 0) return false;
  const start = at + m.index;
  const prefix = line.slice(0, start);
  const rest = line.slice(start + (m[1] as string).length);
  if (KEYWORD_DEF.test(prefix)) return true;
  if (MODIFIED_METHOD.test(prefix)) return true;
  const after = afterParams(rest);
  const opensBody = after !== null && /^\s*(?::\s*[^=;{}]+?)?\s*(?:throws\s+[\w$.,\s]+)?\{\s*$/u.test(after);
  if (/^\s*$/u.test(prefix)) return opensBody;
  const typed = TYPED_METHOD.exec(prefix);
  if (!typed) return false;
  const type = (typed[1] as string).replace(/[?[\]]|<.*$/gu, '').toLowerCase();
  // `void` is a Java/C# return type, but in JS/TS `void save(x);` calls save: a type only with a modifier, typed
  // parameters (`void save(String id)`) or a body.
  if (type === 'void') return /\S\s+\S/u.test(prefix.trim()) || /^\(\s*[\w$.<>[\],]+\s+[\w$]+\s*[,)]/u.test(rest.trimStart()) || opensBody;
  if (NOT_A_TYPE.has(type)) return false;
  return opensBody || after === null || /^\s*(?:throws\s+[\w$.,\s]+)?;?\s*$/u.test(after);
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
const more = (n: number): string => (n > 1 ? ` (and ${plural(n - 1, 'more place')})` : '');

/**
 * Runs one rule over files (filtered again to the rule's globs). Synchronous; each pattern scan runs in the sandbox
 * with a time budget (a slow pattern is an `error`). `commit` goes into citations.
 */
export function runRule(rule: Rule, files: readonly SourceFile[], commit: string, options: RunOptions = {}): RuleRunResult {
  const base = { ruleId: rule.id, promiseId: rule.promiseId };
  const scoped = filesForRule(rule, files);
  const views = viewsOf(scoped);
  const globs = rule.globs.join(', ');
  const pat = displayPattern(rule.pattern);
  const inFiles = `${plural(scoped.length, 'file')} under ${globs}`;
  try {
    if (rule.mode === 'each-near') {
      if (!rule.anchor) return { ...base, outcome: 'error', hits: [], message: `${rule.id} is an each-near rule with no anchor` };
      const flags = lineFlags(rule);
      compileSafe(rule.anchor, flags);
      compileSafe(rule.pattern, flags);
      const within = rule.within ?? DEFAULT_WITHIN;
      // Anchors and guards in comments are not code: a commented-out route is not a route, a guard named in a
      // comment does not guard anything. AC-B (SC-3 fix 8): an anchor that ends in a call (`get_job_status\s*\(`)
      // skips the lines that define that name (`async def get_job_status(`): a definition is not a call to check.
      const found = findMatches(views, rule.anchor, flags, false, 'code');
      const anchors = found.filter((a) => !definesCalledName(views[a.view]?.code[a.startLine - 1] ?? '', a.text));
      if (anchors.length === 0) {
        const def = found[0];
        return {
          ...base,
          outcome: 'error',
          hits: [],
          message: def
            ? `${NOTHING_TO_CHECK}: the only lines in ${inFiles} with ${displayPattern(rule.anchor)} define the function it calls (${where(def)}${more(found.length)}), so the rule cannot say the promise holds`
            : `${NOTHING_TO_CHECK}: no code line in ${inFiles} has ${displayPattern(rule.anchor)}, so the rule cannot say the promise holds`,
        };
      }
      const guarded = new Set(scanLines(rule.pattern, flags, views.map((v) => v.live.map(capLine))).map(([f, i]) => `${f}:${i}`));
      const missing: Match[] = [];
      const kept: Match[] = [];
      for (const a of anchors) {
        let guardLine = 0;
        for (let n = a.startLine; n <= Math.min(a.startLine + within, a.lines.length); n += 1) {
          if (guarded.has(`${a.view}:${n - 1}`)) {
            guardLine = n;
            break;
          }
        }
        if (guardLine === 0) missing.push(a);
        else kept.push({ ...a, endLine: guardLine });
      }
      const first = missing[0];
      if (first) {
        return {
          ...base,
          outcome: 'fail',
          hits: missing.slice(0, MAX_HITS).map((m) => cite(m, commit)),
          message: `${where(first)} has ${first.text} with no ${pat} within ${plural(within, 'line')}${more(missing.length)}`,
        };
      }
      const message = `all ${plural(anchors.length, 'line')} with ${displayPattern(rule.anchor)} have ${pat} within ${plural(within, 'line')}`;
      return { ...base, outcome: 'pass', hits: kept.slice(0, MAX_HITS).map((m) => cite(m, commit)), message };
    }

    const wholeFile = isWholeFile(rule);
    const flags = wholeFile ? normalizeFlags(rule.flags) : lineFlags(rule);
    compileSafe(rule.pattern, flags);
    // must-match counts only live code (not comments, not a lone string). must-not-match reads the `text` view (AC-B,
    // SC-3 fix 3): comments, docstrings and the words of a message are not code, so "Caches the clipboard produced"
    // or f"extracted {len(fields)} fields" is no break, while the values a message carries ({clipboard}) still are.
    const matches = findMatches(views, rule.pattern, flags, wholeFile, rule.mode === 'must-match' ? 'live' : 'text');
    const hits = matches.slice(0, MAX_HITS).map((m) => cite(m, commit));
    const first = matches[0];
    if (rule.mode === 'must-match') {
      const name = requiredName(rule.pattern);
      if (first) {
        const bad = options.constraint && name && !wholeFile ? valueProblems(views, matches, name, options.constraint) : [];
        const worst = bad[0];
        if (worst) {
          return {
            ...base,
            outcome: 'fail',
            hits: bad.slice(0, MAX_HITS).map((b) => cite(b.match, commit)),
            message: `${where(worst.match)}: ${worst.why}${more(bad.length)}`,
          };
        }
        return { ...base, outcome: 'pass', hits, message: `${pat} found at ${where(first)}${more(matches.length)}` };
      }
      if (scoped.length === 0) return { ...base, outcome: 'fail', hits: [], message: `no file matches ${globs}, so ${pat} was not found` };
      // Cite the lines that still name what the rule requires (e.g. `CHAT_TTL_DAYS = 90`): that is where it changed.
      const nameRe = name ? new RegExp(`(?<![\\w$])${name.replace(/\$/gu, '\\$')}(?![\\w$])`, lineFlags(rule).includes('i') ? 'iu' : 'u') : null;
      const near = nameRe ? localMatches(views, nameRe, 'code') : [];
      const nearFirst = near[0];
      if (nearFirst) {
        const read = options.constraint && name ? valueAssigned(views[nearFirst.view]?.code[nearFirst.startLine - 1] ?? '', name) : null;
        const why = read && options.constraint && name ? valueProblem(name, read, options.constraint) : null;
        return {
          ...base,
          outcome: 'fail',
          hits: near.slice(0, MAX_HITS).map((m) => cite(m, commit)),
          message: `${where(nearFirst)} has ${name} but no line in ${inFiles} has ${pat}${why ? ` (${why})` : ''}`,
        };
      }
      return { ...base, outcome: 'fail', hits: [], message: `no line in ${inFiles} has ${pat}` };
    }
    // must-not-match
    if (first) {
      return { ...base, outcome: 'fail', hits, message: `${where(first)} has ${pat}, which must not appear in ${globs}${more(matches.length)}` };
    }
    return { ...base, outcome: 'pass', hits: [], message: `no code line in ${inFiles} has ${pat}` };
  } catch (error) {
    return { ...base, outcome: 'error', hits: [], message: `${rule.id} could not run: ${(error as Error).message}` };
  }
}

/** Matched lines that assign `name` a value that breaks the constraint or is not a literal. */
function valueProblems(
  views: readonly View[],
  matches: readonly Match[],
  name: string,
  constraint: ValueConstraint,
): Array<{ match: Match; why: string }> {
  const out: Array<{ match: Match; why: string }> = [];
  for (const m of matches) {
    const read = valueAssigned(views[m.view]?.code[m.startLine - 1] ?? '', name);
    const why = read ? valueProblem(name, read, constraint) : null;
    if (why) out.push({ match: m, why });
  }
  return out;
}

/**
 * The program's simulated break for a must-match or each-near rule: the files with what satisfies `pattern` removed
 * (each-near: only the guard, so an inline anchor stays). Throws when a pattern cannot run. FU-1: a repaired rule must
 * also fail on the older rule's break.
 */
export function removeGuard(rule: Rule, files: readonly SourceFile[]): { files: SourceFile[]; changedAt: string[] } {
  const scoped = filesForRule(rule, files);
  const wholeFile = isWholeFile(rule);
  const changedAt: string[] = [];
  let mutated: SourceFile[] = [...files];
  for (const file of scoped) {
    const lines = splitLines(file.text);
    let changed = false;
    if (rule.mode === 'must-match' && wholeFile) {
      for (const m of findMatches(viewsOf([file]), rule.pattern, normalizeFlags(rule.flags), true, 'live')) {
        for (let n = m.startLine; n <= m.endLine; n += 1) {
          if (lines[n - 1] !== '') {
            lines[n - 1] = '';
            changedAt.push(`${file.path}:${n}`);
            changed = true;
          }
        }
      }
    } else {
      const flags = lineFlags(rule);
      const test = (line: string): boolean => scanLines(rule.pattern, flags, [[capLine(line)]]).length > 0;
      const hit = scanLines(rule.pattern, flags, [lines.map(capLine)]).map(([, i]) => i);
      for (const i of hit) {
        let next = '';
        if (rule.mode === 'each-near') {
          // Remove only the guard, so an anchor on the same line (an inline guard) stays.
          next = lines[i] as string;
          for (let round = 0; round < 3 && test(next); round += 1) next = removeMatches(rule.pattern, flags, [next])[0] ?? '';
          if (test(next)) next = '';
        }
        lines[i] = next;
        changedAt.push(`${file.path}:${i + 1}`);
        changed = true;
      }
    }
    if (changed) mutated = mutated.map((f) => (f.path === file.path ? { path: f.path, text: lines.join('\n') } : f));
  }
  return { files: mutated, changedAt };
}

export interface ProofOptions {
  /** For must-not-match: one line of code that breaks the promise; the proof adds it to a file. */
  readonly violationExample?: string | null;
}
export interface ProofResult {
  readonly ok: boolean;
  /** One line saying what the program changed in memory and what happened. */
  readonly mutation: string;
}

/**
 * Shows the rule can fail: must-match / each-near remove what satisfies `pattern` (in memory) and re-run;
 * must-not-match adds the violation example to the first file the rule covers. The rule must pass before.
 */
export function proveRuleCanFail(
  rule: Rule,
  files: readonly SourceFile[],
  commit: string,
  options: ProofOptions = {},
): ProofResult {
  const before = runRule(rule, files, commit);
  if (before.outcome === 'error') return { ok: false, mutation: `none: ${before.message}` };
  if (before.outcome !== 'pass') {
    return { ok: false, mutation: `none: the rule does not pass on this code (${before.message}), so a break cannot be simulated` };
  }
  const scoped = filesForRule(rule, files);
  const pat = displayPattern(rule.pattern);
  const swap = (target: SourceFile, text: string): SourceFile[] =>
    files.map((f) => (f.path === target.path ? { path: f.path, text } : f));

  if (rule.mode === 'must-not-match') {
    const example = options.violationExample?.trim();
    if (!example) return { ok: false, mutation: 'none: a must-not-match rule needs an example of a bad line to show it can fail' };
    const target = scoped[0];
    if (!target) return { ok: false, mutation: `none: no file matches ${rule.globs.join(', ')}` };
    const text = target.text.endsWith('\n') || target.text === '' ? `${target.text}${example}\n` : `${target.text}\n${example}\n`;
    const after = runRule(rule, swap(target, text), commit);
    const did = `added the line \`${example}\` to ${target.path}`;
    return after.outcome === 'fail'
      ? { ok: true, mutation: `${did}; the rule then failed` }
      : { ok: false, mutation: `${did}, but the rule still passed, so it cannot catch a break` };
  }

  let mutated: SourceFile[];
  let changedAt: string[];
  try {
    ({ files: mutated, changedAt } = removeGuard(rule, files));
  } catch (error) {
    return { ok: false, mutation: `none: ${(error as Error).message}` };
  }
  if (changedAt.length === 0) {
    return { ok: false, mutation: `none: no line has ${pat}, so there was nothing to remove and the rule cannot catch a break` };
  }
  const shown = changedAt.slice(0, 3).join(', ') + (changedAt.length > 3 ? `, +${changedAt.length - 3}` : '');
  const did =
    rule.mode === 'each-near'
      ? `removed ${pat} from ${plural(changedAt.length, 'line')} (${shown})`
      : `removed ${plural(changedAt.length, 'line')} with ${pat} (${shown})`;
  const after = runRule(rule, mutated, commit);
  if (after.outcome !== 'fail') return { ok: false, mutation: `${did}, but the rule still passed, so it cannot catch a break` };
  // each-near: a NEW unguarded line (e.g. a new route a teammate adds) must also fail, so the anchor is not tied to
  // today's exact lines. Added by WP-I after a live anchor `router\.get\('/export'` let '/export.csv' through.
  const example = rule.mode === 'each-near' ? options.violationExample?.trim() : undefined;
  if (example) {
    const target = scoped[0]!;
    const text = target.text.endsWith('\n') || target.text === '' ? `${target.text}${example}\n` : `${target.text}\n${example}\n`;
    const added = runRule(rule, swap(target, text), commit);
    if (added.outcome !== 'fail') {
      return { ok: false, mutation: `${did}; but adding the new unguarded line \`${example}\` to ${target.path} still passed, so the anchor misses new code` };
    }
    return { ok: true, mutation: `${did}; the rule then failed, and it also failed on a new unguarded line \`${example}\`` };
  }
  return { ok: true, mutation: `${did}; the rule then failed` };
}
