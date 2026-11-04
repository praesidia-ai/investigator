// R4-FIX: "breaks now" is a finding, not a failure. When a proposed rule fails on today's code, the program derives the
// smallest in-memory fix it can (a value brought within the limit, the forbidden line removed, the guard line added),
// re-runs the rule on that fixed copy, and when it passes there the rule is kept and the promise is reported BROKEN NOW
// with the evidence (file:line, actual vs allowed). Every quote is copied from the code; model text is never evidence.
import type { Rule, RuleRunResult, SourceFile } from '../contracts.js';
import { codeView, describeLimit, inUnit, keeps, nameUnit, unitSeconds, valueAssigned } from './code-text.js';
import { filesForRule, isWholeFile, requiredName, runRule, splitLines } from './engine.js';
import { compileSafe, normalizeFlags } from './regex.js';
import { scanLines } from './sandbox.js';
import { proveValueChecked, type NumericConstraint } from './values.js';

/** One line of today's code that breaks the promise, copied by the program. */
export interface BrokenNowEvidence {
  readonly path: string;
  readonly line: number;
  /** The line as git stores it (trimmed, capped at 160 characters). */
  readonly quote: string;
  /** What the code has, e.g. "172800" or "no guard within 3 lines". */
  readonly actual?: string;
  /** What the promise allows, e.g. "at most 24 hours". */
  readonly allowed?: string;
}

/** The finding: the rule fails on today's code and passes on a copy the program fixed in memory. */
export interface BrokenNow {
  /** The rule's own message on today's code. */
  readonly message: string;
  readonly evidence: readonly BrokenNowEvidence[];
  /** What the program changed in memory to get a copy that keeps the promise. */
  readonly fix: string;
}

export interface DerivedFix {
  readonly files: SourceFile[];
  readonly fix: string;
  readonly evidence: BrokenNowEvidence[];
  /** R5-A: how many lines the fix changes, adds or removes (a finding needs a small one). */
  readonly changedLines: number;
  /** R5-A: the files the fix changes. */
  readonly paths: string[];
}

export interface FixOptions {
  readonly constraint: NumericConstraint | null;
  /** Lines the model says keep the promise (the fixed line first when it said the code breaks the promise today). */
  readonly keptExamples: readonly string[];
}

const MAX_EVIDENCE = 10;
const NUMBER = /(?<![\w$.])\d[\d_]*(?:\.\d+)?(?![\w$])/gu;
const capQuote = (s: string): string => {
  const t = s.trim();
  return t.length > 160 ? `${t.slice(0, 159)}…` : t;
};
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
const indentOf = (line: string): string => /^\s*/u.exec(line)?.[0] ?? '';
/**
 * AC-A: a number that stands alone, not a factor of a product (`CHAT_TTL_DAYS * 24 * 60 * 60`: 24 and 60 are unit
 * factors, not the value, so they are never reported or swapped as the broken number).
 */
function standalone(line: string, m: RegExpMatchArray): boolean {
  const at = m.index ?? 0;
  const before = line.slice(0, at).trimEnd().slice(-1);
  const after = line.slice(at + m[0].length).trimStart().slice(0, 1);
  return !['*', '/'].includes(before) && !['*', '/'].includes(after);
}

/** A copy of `files` with `path` replaced by `lines`. */
function withLines(files: readonly SourceFile[], path: string, lines: readonly string[]): SourceFile[] {
  return files.map((f) => (f.path === path ? { path: f.path, text: lines.join('\n') } : f));
}
function linesOf(files: readonly SourceFile[], path: string): string[] {
  const f = files.find((x) => x.path === path);
  return f ? splitLines(f.text) : [];
}
/**
 * The fixed copy must pass as check runs the rule, and, for a value promise, still fail when the value breaks the
 * promise (so a limit written in another unit, e.g. 24 for a ttl in seconds, is not taken as the fix).
 */
const passes = (rule: Rule, files: readonly SourceFile[], commit: string, o: FixOptions): boolean =>
  runRule(rule, files, commit, { constraint: o.constraint }).outcome === 'pass' &&
  (o.constraint === null || proveValueChecked(rule, files, commit, o.constraint).ok);

/** True when `pattern` (one line at a time) matches `text`. */
function matchesLine(rule: Rule, pattern: string, text: string): boolean {
  try {
    const flags = normalizeFlags(rule.flags).replace(/[sm]/gu, '');
    compileSafe(pattern, flags);
    return scanLines(pattern, flags, [[text]]).length > 0;
  } catch {
    return false;
  }
}

/** The constraint's limit in the unit a constant's name carries (CHAT_TTL_DAYS with "<= 24 hours" -> 1). */
function limitFor(name: string | null, c: NumericConstraint): number {
  const from = name ? nameUnit(name) : null;
  const to = unitSeconds(c.unit);
  const v = from !== null && to !== null && from !== to ? (c.value * to) / from : c.value;
  if (Number.isInteger(v)) return v;
  return c.op === '>=' ? Math.ceil(v) : Math.floor(v * 1000) / 1000;
}

/** The leading identifier of a kept example (`CACHE_TTL = 86400` -> CACHE_TTL), when it assigns one. */
function assignedName(example: string): string | null {
  const m = /^\s*(?:(?:export\s+)?(?:const|let|var|final|static|readonly)\s+)?["']?([A-Za-z_$][\w$]*)["']?\s*(?::[^=]*)?[:=]/u.exec(example);
  return m ? (m[1] as string) : null;
}

/**
 * Where today's code names what a must-match rule needs: the rule's own failure hits, plus lines that assign the name
 * the rule requires or the name a kept example assigns. Sorted, unique, at most 20.
 */
function targetLines(rule: Rule, files: readonly SourceFile[], failed: RuleRunResult, o: FixOptions): Array<{ path: string; line: number; name: string | null }> {
  const names = [requiredName(rule.pattern), ...o.keptExamples.map(assignedName)].filter((n): n is string => n !== null);
  const out = new Map<string, { path: string; line: number; name: string | null }>();
  for (const h of failed.hits) out.set(`${h.path}:${h.startLine}`, { path: h.path, line: h.startLine, name: names[0] ?? null });
  for (const f of filesForRule(rule, files)) {
    const view = codeView(f.path, f.text);
    view.code.forEach((line, i) => {
      for (const name of names) {
        if (valueAssigned(line, name)) {
          out.set(`${f.path}:${i + 1}`, { path: f.path, line: i + 1, name });
          return;
        }
      }
    });
  }
  return [...out.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.line - b.line)).slice(0, 20);
}

/** Evidence for a line: its quote and, for a value promise, the value it sets against the limit. */
function evidenceAt(files: readonly SourceFile[], path: string, line: number, name: string | null, c: NumericConstraint | null): BrokenNowEvidence {
  const raw = linesOf(files, path)[line - 1] ?? '';
  const base = { path, line, quote: capQuote(raw) };
  if (!c) return base;
  const f = files.find((x) => x.path === path);
  const code = f ? (codeView(f.path, f.text).code[line - 1] ?? raw) : raw;
  const read = name ? valueAssigned(code, name) : null;
  if (read?.kind === 'number') {
    const v = name ? inUnit(read.value, name, c.unit) : read.value;
    const shown = v !== read.value && c.unit ? `${read.text} (${Math.round(v * 1000) / 1000} ${c.unit})` : read.text;
    return { ...base, actual: shown, allowed: describeLimit(c) };
  }
  if (read?.kind === 'expression') return { ...base, actual: `not a literal (${capQuote(read.text)})`, allowed: describeLimit(c) };
  const nums = [...code.matchAll(NUMBER)].filter((m) => standalone(code, m)).map((m) => m[0]);
  const bad = nums.find((n) => !keeps(c, Number(n.replace(/_/gu, ''))));
  return bad ? { ...base, actual: bad, allowed: describeLimit(c) } : { ...base, allowed: describeLimit(c) };
}

/** Swaps the number on one line that breaks the constraint (or the only number) for `to`. */
function swapNumber(line: string, name: string | null, c: NumericConstraint | null, to: string): string | null {
  const nums = [...line.matchAll(NUMBER)];
  if (nums.length === 0) return null;
  const breaks = (n: string): boolean => (c ? !keeps(c, name ? inUnit(Number(n.replace(/_/gu, '')), name, c.unit) : Number(n.replace(/_/gu, ''))) : false);
  const pick = nums.find((m) => standalone(line, m) && breaks(m[0])) ?? (nums.length === 1 ? nums[0] : undefined);
  if (!pick || pick.index === undefined || pick[0] === to) return null;
  return `${line.slice(0, pick.index)}${to}${line.slice(pick.index + pick[0].length)}`;
}

function mustMatchFix(rule: Rule, files: readonly SourceFile[], commit: string, failed: RuleRunResult, o: FixOptions): DerivedFix | null {
  const targets = targetLines(rule, files, failed, o);
  const evidence = targets.slice(0, MAX_EVIDENCE).map((t) => evidenceAt(files, t.path, t.line, t.name, o.constraint));
  const kept = o.keptExamples.filter((k) => matchesLine(rule, rule.pattern, k));
  const keptNumbers = kept.flatMap((k) => [...k.matchAll(NUMBER)].map((m) => m[0]));
  // 1. A value brought within the limit, on every line that names it (or toward the kept example's number).
  const values: Array<{ to: (name: string | null) => string; why: (name: string | null) => string }> = [];
  if (o.constraint) {
    const c = o.constraint;
    values.push({ to: (name) => String(limitFor(name, c)), why: () => `the value set to the limit (${describeLimit(c)})` });
  }
  for (const n of [...new Set(keptNumbers)].slice(0, 3)) values.push({ to: () => n, why: () => `the value set to ${n}, as in the kept example` });
  for (const v of values) {
    let copy = [...files];
    const changed: string[] = [];
    for (const t of targets) {
      const lines = linesOf(copy, t.path);
      const next = swapNumber(lines[t.line - 1] ?? '', t.name, o.constraint, v.to(t.name));
      if (next === null) continue;
      lines[t.line - 1] = next;
      copy = withLines(copy, t.path, lines);
      changed.push(`${t.path}:${t.line}`);
    }
    if (changed.length > 0 && passes(rule, copy, commit, o)) {
      return {
        files: copy,
        fix: `${v.why(targets[0]?.name ?? null)} at ${changed.slice(0, 3).join(', ')}${changed.length > 3 ? ', ...' : ''}`,
        evidence,
        changedLines: changed.length,
        paths: [...new Set(changed.map((c) => c.slice(0, c.lastIndexOf(':'))))],
      };
    }
  }
  // 2. The line that names it replaced by a kept example (indentation kept).
  for (const t of targets.slice(0, 5)) {
    for (const k of kept) {
      const lines = linesOf(files, t.path);
      lines[t.line - 1] = `${indentOf(lines[t.line - 1] ?? '')}${k.trim()}`;
      const copy = withLines(files, t.path, lines);
      if (passes(rule, copy, commit, o)) return { files: copy, fix: `${t.path}:${t.line} replaced by \`${capQuote(k)}\``, evidence, changedLines: 1, paths: [t.path] };
    }
  }
  // 3. The missing line added (the guard, setting or call the promise needs). SC-3 fix 6: never for a number: an added
  // constant nobody uses is no fix (.20), and a value finding needs a line of today's code that sets the value.
  if (o.constraint) return null;
  const where = targets[0]?.path ?? failed.hits[0]?.path ?? filesForRule(rule, files)[0]?.path;
  if (!where) return null;
  for (const k of kept) {
    const lines = linesOf(files, where);
    const copy = withLines(files, where, [...lines, k.trim()]);
    if (passes(rule, copy, commit, o)) return { files: copy, fix: `the line \`${capQuote(k)}\` added to ${where}`, evidence, changedLines: 1, paths: [where] };
  }
  return null;
}

function mustNotMatchFix(rule: Rule, files: readonly SourceFile[], commit: string, o: FixOptions): DerivedFix | null {
  let copy = [...files];
  const removed: Array<{ path: string; line: number; quote: string }> = [];
  for (let round = 0; round < 5; round += 1) {
    const run = runRule(rule, copy, commit, { constraint: o.constraint });
    if (run.outcome === 'pass') break;
    if (run.outcome === 'error' || run.hits.length === 0) return null;
    for (const h of run.hits) {
      const lines = linesOf(copy, h.path);
      for (let n = h.startLine; n <= h.endLine; n += 1) {
        if ((lines[n - 1] ?? '') === '') continue;
        removed.push({ path: h.path, line: n, quote: linesOf(files, h.path)[n - 1] ?? lines[n - 1] ?? '' });
        lines[n - 1] = '';
      }
      copy = withLines(copy, h.path, lines);
    }
  }
  if (removed.length === 0 || !passes(rule, copy, commit, o)) return null;
  const shown = removed.slice(0, 3).map((r) => `${r.path}:${r.line}`).join(', ') + (removed.length > 3 ? `, +${removed.length - 3}` : '');
  return {
    files: copy,
    fix: `${plural(removed.length, 'forbidden line')} removed (${shown})`,
    evidence: removed.slice(0, MAX_EVIDENCE).map((r) => ({ path: r.path, line: r.line, quote: capQuote(r.quote), actual: 'a line the promise forbids' })),
    changedLines: removed.length,
    paths: [...new Set(removed.map((r) => r.path))],
  };
}

function eachNearFix(rule: Rule, files: readonly SourceFile[], commit: string, failed: RuleRunResult, o: FixOptions): DerivedFix | null {
  // The guard to add: a kept example that matches the guard pattern, else a guard line this code already has.
  const guards = o.keptExamples.filter((k) => matchesLine(rule, rule.pattern, k)).map((k) => k.trim());
  for (const f of filesForRule(rule, files)) {
    const live = codeView(f.path, f.text).live;
    const i = live.findIndex((line) => matchesLine(rule, rule.pattern, line));
    if (i >= 0) {
      guards.push((splitLines(f.text)[i] ?? '').trim());
      break;
    }
  }
  const within = rule.within ?? 3;
  const missing = failed.hits;
  for (const guard of [...new Set(guards)].slice(0, 3)) {
    if (guard === '') continue;
    let copy = [...files];
    // Bottom-up per file, so inserting a line does not move the anchors still to fix.
    const byFile = new Map<string, number[]>();
    for (const h of missing) byFile.set(h.path, [...(byFile.get(h.path) ?? []), h.startLine]);
    for (const [path, at] of byFile) {
      const lines = linesOf(copy, path);
      for (const n of [...new Set(at)].sort((a, b) => b - a)) {
        const anchor = lines[n - 1] ?? '';
        if (within === 0) lines[n - 1] = `${anchor} ${guard}`;
        else lines.splice(n, 0, `${indentOf(anchor)}${guard}`);
      }
      copy = withLines(copy, path, lines);
    }
    if (passes(rule, copy, commit, o)) {
      return {
        files: copy,
        fix: `\`${capQuote(guard)}\` added ${within === 0 ? 'on' : 'after'} ${plural(missing.length, 'unguarded line')}`,
        evidence: missing.slice(0, MAX_EVIDENCE).map((h) => ({
          path: h.path,
          line: h.startLine,
          quote: capQuote(h.quote.split('\n')[0] ?? ''),
          actual: `no guard within ${plural(within, 'line')}`,
        })),
        changedLines: [...byFile.values()].reduce((n, at) => n + new Set(at).size, 0),
        paths: [...byFile.keys()],
      };
    }
  }
  return null;
}

/**
 * The smallest fix the program can derive for a rule that fails on today's code, or null when no fixed copy makes the
 * rule pass (then the rule, not the code, is wrong, and the rule is dropped).
 */
export function deriveFix(rule: Rule, files: readonly SourceFile[], commit: string, failed: RuleRunResult, options: FixOptions): DerivedFix | null {
  if (failed.outcome !== 'fail') return null;
  try {
    if (rule.mode === 'must-not-match') return mustNotMatchFix(rule, files, commit, options);
    if (rule.mode === 'each-near') return eachNearFix(rule, files, commit, failed, options);
    if (isWholeFile(rule)) {
      // A whole-file must-match: only the missing text added can fix it.
      const where = failed.hits[0]?.path ?? filesForRule(rule, files)[0]?.path;
      if (!where) return null;
      for (const k of options.keptExamples) {
        const copy = withLines(files, where, [...linesOf(files, where), k.trim()]);
        if (passes(rule, copy, commit, options)) return { files: copy, fix: `the line \`${capQuote(k)}\` added to ${where}`, evidence: [], changedLines: 1, paths: [where] };
      }
      return null;
    }
    return mustMatchFix(rule, files, commit, failed, options);
  } catch {
    return null;
  }
}

/** "cache_service.py:19 `ttl=172800`: 172800, allowed at most 24 hours" (one evidence line, plain). */
export function describeEvidence(e: BrokenNowEvidence): string {
  const vs = e.actual && e.allowed ? `: ${e.actual}, allowed ${e.allowed}` : e.actual ? `: ${e.actual}` : e.allowed ? ` (allowed ${e.allowed})` : '';
  return `${e.path}:${e.line} \`${e.quote}\`${vs}`;
}
