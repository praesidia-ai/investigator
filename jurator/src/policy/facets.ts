// Owner: WP-P. Typed facets beside each promise's exact sentence ("a structured container of unstructured sentences").
// The program normalises what the model (or a connector) wrote, so two policies that say the same thing in different
// words end up with the same subject, action and constraint, and src/policy/compare.ts can compare them with no AI.
import type { PromiseFacets } from '../contracts.js';

type Constraint = NonNullable<PromiseFacets['constraint']>;

/** Raw facets as the model returns them (every field present, maybe null or empty). */
export interface RawFacets {
  readonly subject: string | null;
  readonly action: string | null;
  readonly constraint: {
    readonly name: string | null;
    readonly op: Constraint['op'];
    readonly value: string | null;
    readonly unit: string | null;
  } | null;
}

function clean(text: string | null | undefined): string {
  return (text ?? '')
    .toLowerCase()
    .replace(/\s+/gu, ' ')
    .trim()
    .replace(/[.;:!?,]+$/u, '')
    .trim();
}

const LEADING = /^(?:the|all|any|every|our|your|their|its)\s+/u;

/** 'The support chats.' -> 'support chats'. */
export function normaliseSubject(subject: string | null | undefined): string {
  let s = clean(subject);
  while (LEADING.test(s)) s = s.replace(LEADING, '');
  return s;
}

/** Verb forms people and models use for the same action. Keys are whole phrases. */
const ACTION_WORDS: Readonly<Record<string, string>> = {
  keep: 'keep', kept: 'keep', keeps: 'keep', retain: 'keep', retained: 'keep', retains: 'keep', store: 'keep',
  stored: 'keep', stores: 'keep', hold: 'keep', held: 'keep', save: 'keep', saved: 'keep', 'keep for': 'keep',
  'retain for': 'keep', 'store for': 'keep', retention: 'keep',
  delete: 'delete', deleted: 'delete', deletes: 'delete', remove: 'delete', removed: 'delete', removes: 'delete',
  purge: 'delete', purged: 'delete', erase: 'delete', erased: 'delete', 'delete after': 'delete',
  'deleted after': 'delete', 'are deleted': 'delete', 'is deleted': 'delete', 'be deleted': 'delete',
  'delete within': 'delete', 'deleted within': 'delete', 'remove after': 'delete', 'removed after': 'delete',
  'purged after': 'delete', 'auto-delete': 'delete', 'auto delete': 'delete', 'automatically delete': 'delete',
  'automatically deleted': 'delete', 'delete permanently': 'delete', 'permanently delete': 'delete',
  'permanently deleted': 'delete', expire: 'delete', expires: 'delete', expired: 'delete',
};

/**
 * R4-FIX (backlog 3): a phrase that starts with a keep or delete verb is that action, so "store in cloud storage",
 * "persist to disk" and "write to the database" compare with "keep", and "removed from the server" with "delete".
 * Writing to logs stays "log" (a log line is not the stored record).
 */
const KEEP_VERB = /^(?:store|stores|stored|storing|keep|keeps|kept|keeping|retain|retains|retained|retaining|persist|persists|persisted|persisting|save|saves|saved|saving|hold|holds|held|holding|write|writes|written|wrote|writing)\b/u;
const DELETE_VERB = /^(?:delete|deletes|deleted|deleting|remove|removes|removed|removing|purge|purges|purged|purging|erase|erases|erased|erasing)\b/u;
const AUX = /^(?:to|must|must not|never|always|not|be|is|are|been|being|get|gets|got|will|shall|should|can|may|only)\s+/u;

export function normaliseAction(action: string | null | undefined): string {
  let a = clean(action);
  for (let i = 0; i < 4 && AUX.test(a); i += 1) a = a.replace(AUX, '');
  const exact = ACTION_WORDS[a];
  if (exact) return exact;
  if (KEEP_VERB.test(a)) return /\blog(?:s|ged|ging)?\b/u.test(a) ? 'log' : 'keep';
  if (DELETE_VERB.test(a)) return 'delete';
  return a;
}

/** Durations become days (hours stay hours, so "72 hours" reads as written). Other units are kept, lowercased. */
const UNIT_DAYS: Readonly<Record<string, number>> = {
  d: 1, day: 1, days: 1, w: 7, wk: 7, wks: 7, week: 7, weeks: 7, month: 30, months: 30, mo: 30, y: 365, yr: 365,
  yrs: 365, year: 365, years: 365,
};
const UNIT_HOURS = new Set(['h', 'hr', 'hrs', 'hour', 'hours']);

export function isDuration(unit: string | null): boolean {
  return unit === 'days' || unit === 'hours';
}

/** A duration as a number of days, or null when the value or unit is not a duration. */
export function durationDays(c: { value: string | null; unit: string | null }): number | null {
  const n = numeric(c.value);
  if (n === null) return null;
  if (c.unit === 'days') return n;
  if (c.unit === 'hours') return n / 24;
  return null;
}

export function numeric(value: string | null): number | null {
  if (value === null) return null;
  const v = value.trim().replace(/,/gu, '');
  if (!/^-?\d+(?:\.\d+)?$/u.test(v)) return null;
  return Number(v);
}

function formatNumber(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 1000) / 1000);
}

function normaliseConstraint(c: RawFacets['constraint']): Constraint | null {
  if (!c) return null;
  const op = c.op;
  let value = c.value === null ? null : c.value.trim() || null;
  let unit = clean(c.unit) || null;
  // "30 days" written into the value: split it into number and unit.
  const split = value === null ? null : /^(\d+(?:\.\d+)?)\s*([a-z]+)$/iu.exec(value);
  if (split && (unit === null || clean(split[2]) === unit)) {
    value = split[1] as string;
    unit = clean(split[2]);
  }
  if (unit !== null && UNIT_DAYS[unit] !== undefined) {
    const n = numeric(value);
    if (n !== null) value = formatNumber(n * (UNIT_DAYS[unit] as number));
    unit = 'days';
  } else if (unit !== null && UNIT_HOURS.has(unit)) {
    unit = 'hours';
  }
  if (op === 'never' || op === 'always') {
    // "never" and "always" carry no number; a stray value would only confuse the comparison.
    return { name: clean(c.name) || 'allowed', op, value: null, unit: null };
  }
  const name = clean(c.name) || (unit ?? 'value');
  return { name, op, value: value === null ? null : value.toLowerCase(), unit };
}

/**
 * Normalises facets; undefined when there is no usable subject or action. Idempotent, so stored facets can be
 * normalised again before every comparison.
 *  - subjects and actions: short lowercase phrases ('Support chats' -> 'support chats', 'retained' -> 'keep').
 *  - durations in days ('2 weeks' -> 14 days); hours stay hours.
 *  - "deleted after 30 days" is the same promise as "kept for at most 30 days": delete + duration -> keep <= N.
 *  - keep + duration -> constraint name 'retention', so every retention limit compares with every other.
 */
export function normaliseFacets(raw: RawFacets | PromiseFacets | null | undefined): PromiseFacets | undefined {
  if (!raw) return undefined;
  const subject = normaliseSubject(raw.subject);
  let action = normaliseAction(raw.action);
  if (!subject || !action) return undefined;
  let constraint = normaliseConstraint(raw.constraint);
  if (constraint && isDuration(constraint.unit) && numeric(constraint.value) !== null) {
    if (action === 'delete' && constraint.op !== 'never' && constraint.op !== 'always') {
      action = 'keep';
      constraint = { ...constraint, name: 'retention', op: '<=' };
    } else if (action === 'keep') {
      constraint = { ...constraint, name: 'retention' };
    }
  }
  return { subject: subject.slice(0, 80), action: action.slice(0, 60), constraint };
}

const NOT_A_UNIT = new Set(['and', 'or', 'to', 'of', 'the', 'a', 'an', 'per', 'by', 'in', 'on', 'at', 'for', 'from', 'after', 'before', 'within', 'than', 'is', 'are']);
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

/**
 * R4-FIX (backlog 4): a numeric constraint must carry a unit ("expire within 15 minutes" is not `retention <= 15`).
 * The unit is repaired from the quote (the word after the number); when the quote has none, the constraint is dropped
 * and `note` says so (the promise stays; only its typed number goes).
 */
export function requireUnit(f: PromiseFacets | undefined, quote: string): { facets: PromiseFacets | undefined; note: string | null } {
  const c = f?.constraint;
  if (!f || !c || c.op === 'never' || c.op === 'always' || c.value === null || c.unit !== null || numeric(c.value) === null) {
    return { facets: f, note: null };
  }
  const m = new RegExp(`(?<![\\d.])${escapeRe(c.value)}\\s*(?:-\\s*)?(%|[A-Za-z]+)`, 'u').exec(quote);
  const word = m ? (m[1] as string).toLowerCase() : null;
  if (word && !NOT_A_UNIT.has(word)) {
    return { facets: normaliseFacets({ ...f, constraint: { ...c, unit: word } }), note: null };
  }
  return {
    facets: { ...f, constraint: null },
    note: `the number in "${c.name} ${c.op} ${c.value}" has no unit in the quote, so that typed limit was dropped (the promise stays)`,
  };
}

/** Plain words for a constraint: 'at most 30 days', 'never', 'admin'. */
export function describeConstraint(c: Constraint): string {
  if (c.op === 'never') return 'never';
  if (c.op === 'always') return 'always';
  const amount = `${c.value ?? '?'}${c.unit ? ` ${c.unit}` : ''}`;
  if (c.op === '<=') return `at most ${amount}`;
  if (c.op === '>=') return `at least ${amount}`;
  return amount;
}

/** One line for a person: 'support chats · keep · retention <= 30 days'. */
export function facetsLine(f: PromiseFacets): string {
  const c = f.constraint;
  const tail = !c
    ? ''
    : c.op === 'never' || c.op === 'always'
      ? ` · ${c.op}`
      : ` · ${c.name} ${c.op} ${c.value ?? '?'}${c.unit ? ` ${c.unit}` : ''}`;
  return `${f.subject} · ${f.action}${tail}`;
}
