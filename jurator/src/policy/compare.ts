// Owner: WP-P. Deterministic contradiction check (no AI): compares promises by their typed facets.
// Two promises clash when they are about the same subject and action and their constraints cannot both hold, e.g.
// "support chats: keep <= 30 days" (privacy.01) and "support chats: keep <= 90 days" (praesidia.01).
// Each pair is 'conflict', 'ok' (the program is sure there is no clash) or 'undecided' (the model reads it).
import type { PromiseFacets, PromiseRecord } from '../contracts.js';
import { describeConstraint, durationDays, normaliseFacets, numeric } from './facets.js';

type Constraint = NonNullable<PromiseFacets['constraint']>;

export type PairVerdict =
  | { readonly verdict: 'conflict'; readonly basis: string; readonly example: string }
  | { readonly verdict: 'ok'; readonly why: string }
  | { readonly verdict: 'undecided'; readonly why: string };

export interface StructuredConflict {
  readonly promiseIds: [string, string];
  /** What the program compared, e.g. '30 days with 90 days'. */
  readonly basis: string;
  readonly example: string;
}
export interface CompareAllResult {
  readonly pairs: number;
  /** Pairs the program decided (conflict or ok) with no AI. */
  readonly decided: number;
  readonly conflicts: StructuredConflict[];
  /** Pairs the program could not decide (a promise has no facets, or the constraints are of a kind it cannot weigh). */
  readonly undecided: Array<[string, string]>;
}

/* ------------------------------ subjects and actions ------------------------------ */

function singular(word: string): string {
  if (word.length <= 3 || word.endsWith('ss') || word.endsWith('us')) return word;
  if (word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  return word.endsWith('s') ? word.slice(0, -1) : word;
}
function key(phrase: string): string {
  return phrase.split(' ').map(singular).join(' ');
}
function containsWords(outer: string, inner: string): boolean {
  return ` ${outer} `.includes(` ${inner} `);
}

/** Phrases that name the same data in this product (whole phrases only). */
const SYNONYM_GROUPS: ReadonlyArray<ReadonlySet<string>> = [
  new Set(
    ['chats', 'chat messages', 'chat transcripts', 'chat history', 'support chats', 'support conversations', 'customer data', 'notes'].map(key),
  ),
];

export function subjectsOverlap(a: string, b: string): boolean {
  const ka = key(a);
  const kb = key(b);
  if (ka === kb || containsWords(ka, kb) || containsWords(kb, ka)) return true;
  return SYNONYM_GROUPS.some((g) => g.has(ka) && g.has(kb));
}

export function sameAction(a: string, b: string): boolean {
  return a === b || containsWords(a, b) || containsWords(b, a);
}

/* ------------------------------ constraints ------------------------------ */

type Stance =
  | { readonly kind: 'never' }
  | { readonly kind: 'always' }
  | { readonly kind: 'may' }
  | { readonly kind: 'none' }
  | { readonly kind: 'limit'; readonly c: Constraint };

function stanceOf(p: PromiseRecord, f: PromiseFacets): Stance {
  const c = f.constraint;
  if (c?.op === 'never') return { kind: 'never' };
  if (c?.op === 'always') return { kind: 'always' };
  if (c) return { kind: 'limit', c };
  if (p.kind === 'must-not') return { kind: 'never' };
  if (p.kind === 'may') return { kind: 'may' };
  return { kind: 'none' };
}

function amount(c: Constraint): string {
  return `${c.value ?? '?'}${c.unit ? ` ${c.unit}` : ''}`;
}

/** [low, high] that a constraint allows (inclusive). */
function interval(op: Constraint['op'], n: number): [number, number] {
  if (op === '<=') return [-Infinity, n];
  if (op === '>=') return [n, Infinity];
  return [n, n];
}

type LimitVerdict = { verdict: 'conflict'; basis: string } | { verdict: 'ok'; why: string } | { verdict: 'undecided'; why: string };

function compareLimits(a: Constraint, b: Constraint, action: string): LimitVerdict {
  const da = durationDays(a);
  const db = durationDays(b);
  let na: number | null;
  let nb: number | null;
  if (da !== null || db !== null) {
    if (da === null || db === null) return a.name === b.name ? { verdict: 'undecided', why: 'a duration and a non-duration' } : { verdict: 'ok', why: 'different limits' };
    na = da;
    nb = db;
  } else {
    if (a.name !== b.name) return { verdict: 'ok', why: `different limits (${a.name}, ${b.name})` };
    na = numeric(a.value);
    nb = numeric(b.value);
    if (na === null || nb === null) {
      if (a.op === '==' && b.op === '==' && na === null && nb === null) {
        return (a.value ?? '') === (b.value ?? '')
          ? { verdict: 'ok', why: 'same value' }
          : { verdict: 'conflict', basis: `${a.name} ${a.value ?? '?'} with ${a.name} ${b.value ?? '?'}` };
      }
      return { verdict: 'undecided', why: 'values that are not numbers' };
    }
    if ((a.unit ?? '') !== (b.unit ?? '')) return { verdict: 'undecided', why: `different units (${a.unit}, ${b.unit})` };
  }
  const basis = `${amount(a)} with ${amount(b)}`;
  // Two different limits on how long the same data is kept: the policies disagree on the retention, so whichever
  // one a system follows, it breaks the other's wording (Praesidia keeps 90 days while privacy deletes at 30). Only a
  // minimum against a maximum ("at least 7 days", "at most 30 days") is weighed as a range.
  const oneMinimum = (a.op === '>=') !== (b.op === '>=');
  if (action === 'keep' && !oneMinimum && na !== nb) return { verdict: 'conflict', basis };
  const [loA, hiA] = interval(a.op, na);
  const [loB, hiB] = interval(b.op, nb);
  return Math.max(loA, loB) > Math.min(hiA, hiB) ? { verdict: 'conflict', basis } : { verdict: 'ok', why: 'both limits can hold' };
}

/* ------------------------------ examples ------------------------------ */

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
/** A fixed day (1 March, non-leap year) so the same promises always give the same example. */
const START = Date.UTC(2026, 2, 1);
function dayAfter(days: number): string {
  const d = new Date(START + Math.ceil(days) * 86_400_000);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}
function capital(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
/** 'support chats' -> 'A support chat'; 'customer data' -> 'Customer data'. */
function oneOf(subject: string): string {
  if (/\b(?:and|or)\b/u.test(subject)) return capital(subject);
  const words = subject.split(' ');
  const last = words[words.length - 1] ?? '';
  const one = singular(last);
  if (one === last) return capital(subject);
  const phrase = [...words.slice(0, -1), one].join(' ');
  return `${/^[aeiou]/u.test(phrase) ? 'An' : 'A'} ${phrase}`;
}

function retentionExample(subject: string, a: { id: string; days: number }, b: { id: string; days: number }): string {
  const [strict, loose] = a.days <= b.days ? [a, b] : [b, a];
  return `${oneOf(subject)} from 1 March must be gone by ${dayAfter(strict.days)} under ${strict.id} but may stay until ${dayAfter(loose.days)} under ${loose.id}.`;
}

/* ------------------------------ pairs ------------------------------ */

export function comparePromises(a: PromiseRecord, b: PromiseRecord): PairVerdict {
  const fa = normaliseFacets(a.facets);
  const fb = normaliseFacets(b.facets);
  if (!fa || !fb) return { verdict: 'undecided', why: 'a promise has no typed facets' };
  if (!subjectsOverlap(fa.subject, fb.subject)) return { verdict: 'ok', why: `different subjects (${fa.subject}, ${fb.subject})` };
  if (!sameAction(fa.action, fb.action)) return { verdict: 'ok', why: `different actions (${fa.action}, ${fb.action})` };
  const subject = fa.subject.length <= fb.subject.length ? fa.subject : fb.subject;
  const action = fa.action.length <= fb.action.length ? fa.action : fb.action;
  const sa = stanceOf(a, fa);
  const sb = stanceOf(b, fb);

  if (sa.kind === 'never' || sb.kind === 'never') {
    const other = sa.kind === 'never' ? sb : sa;
    const [neverId, otherId] = sa.kind === 'never' ? [a.id, b.id] : [b.id, a.id];
    if (other.kind === 'never') return { verdict: 'ok', why: 'both say never' };
    if (other.kind === 'always' || other.kind === 'may') {
      const word = other.kind;
      return {
        verdict: 'conflict',
        basis: sa.kind === 'never' ? `never with ${word}` : `${word} with never`,
        example: `${neverId} says ${subject}: never ${action}; ${otherId} says ${subject}: ${word} ${action}.`,
      };
    }
    // R4-FIX (backlog 3): "never stores X" against "X is deleted within 30 days" (= kept up to 30 days): the second
    // allows keeping what the first says is never kept.
    const days = other.kind === 'limit' ? durationDays(other.c) : null;
    if (other.kind === 'limit' && action === 'keep' && days !== null && days > 0 && other.c.op !== '>=') {
      return {
        verdict: 'conflict',
        basis: sa.kind === 'never' ? `never with ${describeConstraint(other.c)}` : `${describeConstraint(other.c)} with never`,
        example: `${neverId} says ${subject} are never kept; ${otherId} allows keeping them for ${describeConstraint(other.c)}.`,
      };
    }
    // "never export X" against "only admins export X" or a plain "we export X": the program cannot weigh it.
    return { verdict: 'undecided', why: 'never against a limit or a plain statement' };
  }
  if (sa.kind !== 'limit' || sb.kind !== 'limit') {
    if ((sa.kind === 'always' && sb.kind === 'limit') || (sb.kind === 'always' && sa.kind === 'limit')) {
      return { verdict: 'undecided', why: 'always against a limit' };
    }
    return { verdict: 'ok', why: 'no clashing limits' };
  }
  const limits = compareLimits(sa.c, sb.c, action);
  if (limits.verdict !== 'conflict') return limits;
  const daysA = durationDays(sa.c);
  const daysB = durationDays(sb.c);
  const example =
    action === 'keep' && sa.c.op === '<=' && sb.c.op === '<=' && daysA !== null && daysB !== null && Math.min(daysA, daysB) >= 1
      ? retentionExample(subject, { id: a.id, days: daysA }, { id: b.id, days: daysB })
      : `${capital(subject)} (${action}): ${a.id} says ${describeConstraint(sa.c)}, but ${b.id} says ${describeConstraint(sb.c)}.`;
  return { verdict: 'conflict', basis: limits.basis, example };
}

/** Every pair of live promises, in input order. */
export function compareAll(promises: readonly PromiseRecord[]): CompareAllResult {
  const live = promises.filter((p) => p.status !== 'retired');
  const conflicts: StructuredConflict[] = [];
  const undecided: Array<[string, string]> = [];
  let pairs = 0;
  for (let i = 0; i < live.length; i += 1) {
    for (let j = i + 1; j < live.length; j += 1) {
      const a = live[i] as PromiseRecord;
      const b = live[j] as PromiseRecord;
      if (a.id === b.id) continue;
      pairs += 1;
      const r = comparePromises(a, b);
      if (r.verdict === 'conflict') conflicts.push({ promiseIds: [a.id, b.id], basis: r.basis, example: r.example });
      else if (r.verdict === 'undecided') undecided.push([a.id, b.id]);
    }
  }
  return { pairs, decided: pairs - undecided.length, conflicts, undecided };
}

/** For display: what the program compared for a structured conflict ('30 days with 90 days'), in the given order. */
export function structuredBasis(a: PromiseRecord, b: PromiseRecord): string | null {
  const r = comparePromises(a, b);
  return r.verdict === 'conflict' ? r.basis : null;
}
