// Owner: WP-R. Rules for promises that set a value (typed facets, e.g. retention <= 30 days): a ready-made number
// pattern for the model, and a program proof that the rule notices the number changing (30 -> 31 must fail).
import type { PromiseFacets, PromiseRecord, Rule, SourceFile } from '../contracts.js';
import { codeView, nameUnit, unitSeconds } from './code-text.js';
import { filesForRule, isWholeFile, runRule, splitLines } from './engine.js';
import { compileSafe, normalizeFlags } from './regex.js';
import { scanLines } from './sandbox.js';

export type Constraint = NonNullable<PromiseFacets['constraint']>;
/** A constraint with a number the program can reason about. */
export interface NumericConstraint {
  readonly name: string;
  readonly op: '<=' | '>=' | '==';
  readonly value: number;
  readonly unit: string | null;
}

/** The promise's constraint when it has a number and a comparing op (<=, >=, ==), else null. */
export function numericConstraint(promise: Pick<PromiseRecord, 'facets'>): NumericConstraint | null {
  const c = promise.facets?.constraint;
  if (!c || c.value === null || (c.op !== '<=' && c.op !== '>=' && c.op !== '==')) return null;
  const raw = c.value.trim().replace(/_/gu, '');
  if (!/^\d+(?:\.\d+)?$/u.test(raw)) return null;
  return { name: c.name, op: c.op, value: Number(raw), unit: c.unit };
}

export const describeConstraint = (c: Constraint | NumericConstraint): string =>
  [c.name, c.op, c.value === null ? '' : String(c.value), c.unit ?? ''].filter((s) => s !== '').join(' ');

const cls = (lo: number, hi: number): string => (lo === hi ? String(lo) : hi === lo + 1 ? `[${lo}${hi}]` : `[${lo}-${hi}]`);
const anyDigits = (n: number): string => (n === 0 ? '' : n === 1 ? '[0-9]' : `[0-9]{${n}}`);

/** Regex alternatives (no leading zeros) for whole numbers 0..n. */
function upTo(n: number): string[] {
  const s = String(n);
  const len = s.length;
  const out: string[] = [];
  for (let k = 1; k < len; k += 1) out.push(k === 1 ? '[0-9]' : `[1-9]${anyDigits(k - 1)}`);
  for (let i = 0; i < len; i += 1) {
    const d = Number(s[i]);
    const lo = i === 0 && len > 1 ? 1 : 0;
    if (d > lo) out.push(`${s.slice(0, i)}${cls(lo, d - 1)}${anyDigits(len - 1 - i)}`);
  }
  out.push(s);
  return out;
}
/** Regex alternatives (no leading zeros) for whole numbers >= n. */
function atLeast(n: number): string[] {
  const s = String(n);
  const len = s.length;
  const out: string[] = [s];
  for (let i = 0; i < len; i += 1) {
    const d = Number(s[i]);
    if (d < 9) out.push(`${s.slice(0, i)}${cls(d + 1, 9)}${anyDigits(len - 1 - i)}`);
  }
  out.push(`[1-9][0-9]{${len},}`);
  return out;
}

/**
 * A safe pattern that matches exactly the whole numbers that keep the constraint, e.g. <= 30 ->
 * `(?:[0-9]|[12][0-9]|30)\b`. Null for non-integers or very large values.
 */
export function keptNumberPattern(c: NumericConstraint): string | null {
  if (!Number.isInteger(c.value) || c.value < 0 || c.value > 1_000_000_000) return null;
  if (c.op === '==') return `${c.value}\\b`;
  const alts = c.op === '<=' ? upTo(c.value) : atLeast(c.value);
  return `(?:${alts.join('|')})\\b`;
}

/** A value that breaks the constraint, starting from the number found in code. */
export function breakingValue(c: NumericConstraint, inCode: number): number | null {
  if (c.op === '<=') return Math.max(c.value, inCode) + 1;
  if (c.op === '>=') {
    const v = Math.min(c.value, inCode) - 1;
    return v >= 0 ? v : null;
  }
  return inCode === c.value ? c.value + 1 : null;
}

/**
 * AC-B (SC-3 fix 6): the breaking value in the unit of the name the number is assigned to (`ttl = 3600` against
 * "<= 24 hours" counts seconds, so 86401, not 3601, which still keeps it). `name` null or no time unit: breakingValue.
 */
export function breakingValueFor(c: NumericConstraint, inCode: number, name: string | null): number | null {
  const from = name ? nameUnit(name) : null;
  const to = unitSeconds(c.unit);
  if (from === null || to === null || from === to) return breakingValue(c, inCode);
  const limit = (c.value * to) / from;
  if (c.op === '<=') return Math.max(Math.floor(limit), inCode) + 1;
  if (c.op === '>=') {
    const v = Math.min(Math.ceil(limit), inCode) - 1;
    return v >= 0 ? v : null;
  }
  return Number.isInteger(limit) && inCode === limit ? limit + 1 : null;
}

/** The name a number at `index` of `line` is assigned to (`EXTRACTION_RESULT_CACHE_TTL: int = 1209600`, `ttl=3600`). */
function nameBefore(line: string, index: number): string | null {
  const m = /([A-Za-z_$][\w$]*)["']?\s*(?::\s*[A-Za-z_$][\w$<>[\]|., ]*)?\s*(?:=|:)\s*$/u.exec(line.slice(Math.max(0, index - 200), index));
  return m ? (m[1] as string) : null;
}

/** Lines for the rule prompt: the typed facets and, for a number, how to check the value itself. */
export function constraintPromptLines(promise: Pick<PromiseRecord, 'facets'>): string[] {
  const f = promise.facets;
  if (!f) return [];
  const lines = [`Typed facets: subject "${f.subject}", action "${f.action}", constraint ${f.constraint ? describeConstraint(f.constraint) : 'none'}.`];
  const c = numericConstraint(promise);
  if (!c) return lines;
  const kept = keptNumberPattern(c);
  const brk = breakingValue(c, c.value);
  const seconds = inSeconds(c);
  lines.push(
    `This promise sets a value (${describeConstraint(c)}). Prefer a must-match rule on the constant or setting that holds it, ` +
      'and check the number itself, not only the name.' +
      (kept ? ` Numbers that keep it are matched by ${kept}, e.g. NAME\\s*=\\s*${kept} (use the real name from the code).` : '') +
      (seconds
        ? ` If the code counts in seconds (a ttl, expire or max_age usually does), ${c.value} ${c.unit} is ${seconds.value} seconds: ` +
          `match ${seconds.pattern} instead, e.g. NAME\\s*[:=]\\s*${seconds.pattern}.`
        : '') +
      ' The pattern must contain that name; a pattern that names no setting (\\w*ttl\\w*) is rejected.' +
      (brk === null
        ? ''
        : ` The program changes the number on the matched line to ${brk}${seconds ? ` (${breakingValue({ ...c, value: seconds.value }, seconds.value)} in seconds)` : ''}; the rule must then fail.`),
  );
  return lines;
}

/**
 * AC-B (SC-3 fix 6): the constraint in seconds when its unit is a longer time unit (24 hours -> 86400) and the
 * pattern that keeps it, for code that counts in seconds (a ttl). Null for seconds, non-time units and non-integers.
 */
export function inSeconds(c: NumericConstraint): { value: number; pattern: string } | null {
  const per = unitSeconds(c.unit);
  if (per === null || per <= 1) return null;
  const value = c.value * per;
  const pattern = keptNumberPattern({ ...c, value, unit: 'seconds' });
  return pattern ? { value, pattern } : null;
}

const NUMBER = /(?<![\w$.])\d+(?:\.\d+)?(?![\w$])/gu;

export interface ValueProof {
  /** False when no matched line has a number to change, so the value proof does not apply. */
  readonly applies: boolean;
  readonly ok: boolean;
  readonly mutation: string;
}

/**
 * For a must-match rule on a promise with a number: change the number on each matched line to a value that breaks
 * the constraint (in memory) and require the rule to fail. Catches rules that check only a name (`CHAT_TTL_DAYS`),
 * which would still pass after an agent sets 90.
 */
/**
 * The program's simulated value break for a must-match rule: the number on each matched line changed to one that
 * breaks the promise (30 -> 31). Null when the rule does not read a number. FU-1: a repaired rule must fail on it too.
 */
export function valueMutant(rule: Rule, files: readonly SourceFile[], c: NumericConstraint): { files: SourceFile[]; changes: string[] } | null {
  if (rule.mode !== 'must-match' || isWholeFile(rule)) return null;
  const flags = normalizeFlags(rule.flags).replace(/[sm]/gu, '');
  compileSafe(rule.pattern, flags);
  const changes: string[] = [];
  let mutated = [...files];
  const secs = inSeconds(c)?.value;
  for (const file of filesForRule(rule, files)) {
    const lines = splitLines(file.text);
    // AC-B: numbers are read from the code view (comments blanked, same columns): `86400  # 24 hours` changes 86400.
    const code = codeView(file.path, file.text).code;
    let changed = false;
    // The rule's pattern runs in the sandbox (time budget), like every rule pattern.
    const matched = new Set(scanLines(rule.pattern, flags, [lines]).map(([, i]) => i));
    lines.forEach((line, i) => {
      if (!matched.has(i)) return;
      const nums = [...(code[i] ?? line).matchAll(NUMBER)];
      const pick = nums.find((m) => Number(m[0]) === c.value || Number(m[0]) === secs) ?? (nums.length === 1 ? nums[0] : undefined);
      if (!pick || pick.index === undefined) return;
      const to = breakingValueFor(c, Number(pick[0]), nameBefore(line, pick.index));
      if (to === null) return;
      lines[i] = `${line.slice(0, pick.index)}${to}${line.slice(pick.index + pick[0].length)}`;
      changes.push(`${pick[0]} to ${to} at ${file.path}:${i + 1}`);
      changed = true;
    });
    if (changed) mutated = mutated.map((f) => (f.path === file.path ? { path: f.path, text: lines.join('\n') } : f));
  }
  return changes.length === 0 ? null : { files: mutated, changes };
}

export function proveValueChecked(rule: Rule, files: readonly SourceFile[], commit: string, c: NumericConstraint): ValueProof {
  const none = { applies: false, ok: true, mutation: '' };
  const m = valueMutant(rule, files, c);
  if (!m) return none;
  const { files: mutated, changes } = m;
  const shown = changes.slice(0, 2).join(', ') + (changes.length > 2 ? `, +${changes.length - 2}` : '');
  const after = runRule(rule, mutated, commit);
  return after.outcome === 'fail'
    ? { applies: true, ok: true, mutation: `changed ${shown} (breaks ${describeConstraint(c)}); the rule failed too` }
    : {
        applies: true,
        ok: false,
        mutation: `changed ${shown} (breaks ${describeConstraint(c)}), but the rule still passed, so it does not check the value`,
      };
}
