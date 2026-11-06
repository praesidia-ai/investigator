// Owner: WP-P. Deterministic contradiction check (no AI): compares promises by their typed facets.
// Two promises clash when they are about the same subject and action and their constraints cannot both hold, e.g.
// "support chats: keep <= 30 days" (privacy.01) and "support chats: keep <= 90 days" (praesidia.01).
// Obligations decide the meaning: a configured value breaks a stricter requirement; two compatible maxima leave the
// stricter one; subjects linked only by a synonym list need a person. Each pair is 'conflict', 'ok' (the program is sure there is no clash) or 'undecided' (the model reads it).
import type { PromiseFacets, PromiseRecord } from '../contracts.js';
import { describeConstraint, durationDays, normaliseFacets, numeric } from './facets.js';
import { interval, intersect, obligationOf, type ObligationView } from './obligations.js';

type Constraint = NonNullable<PromiseFacets['constraint']>;

/** incompatible-requirements: two requirements cannot both hold. configuration-violation: a configured value breaks a requirement. */
export type ConflictKind = 'incompatible-requirements' | 'configuration-violation';
/** What two compatible limits leave: 'at most 30 days' (max 30). */
export interface EffectiveLimit {
  readonly text: string;
  readonly max?: number;
  readonly min?: number;
}

export type PairVerdict =
  | { readonly verdict: 'conflict'; readonly kind: ConflictKind; readonly basis: string; readonly example: string }
  | { readonly verdict: 'ok'; readonly why: string; readonly effective?: EffectiveLimit }
  /** needsPerson: scope, applicability, exceptions or a setting's meaning need a person; a model must not decide it. */
  | { readonly verdict: 'undecided'; readonly why: string; readonly needsPerson?: boolean };

export interface StructuredConflict {
  readonly kind: ConflictKind;
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
  /** The undecided pairs only a person may decide (a model must not read them). */
  readonly needsPerson: Array<[string, string]>;
  /** Pairs that can both hold, with what is left of the limits. */
  readonly compatible: Array<{ promiseIds: [string, string]; effective: EffectiveLimit }>;
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

/** Phrases a team may use for the same data. A match here is only a hint: a person decides the scope. */
const SYNONYM_GROUPS: ReadonlyArray<ReadonlySet<string>> = [
  new Set(
    ['chats', 'chat messages', 'chat transcripts', 'chat history', 'support chats', 'support conversations', 'customer data', 'notes'].map(key),
  ),
];

/** same: identical, singular/plural or one contains the other's words. unresolved: only a synonym list links them. */
export function subjectIdentity(a: string, b: string): 'same' | 'unresolved' | 'unrelated' {
  const ka = key(a);
  const kb = key(b);
  if (ka === kb || containsWords(ka, kb) || containsWords(kb, ka)) return 'same';
  return SYNONYM_GROUPS.some((g) => g.has(ka) && g.has(kb)) ? 'unresolved' : 'unrelated';
}

export function subjectsOverlap(a: string, b: string): boolean {
  return subjectIdentity(a, b) === 'same';
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

function kindOf(a: ObligationView, b: ObligationView): ConflictKind {
  return a.role === 'fact' || b.role === 'fact' ? 'configuration-violation' : 'incompatible-requirements';
}

function amount(c: Constraint): string {
  return `${c.value ?? '?'}${c.unit ? ` ${c.unit}` : ''}`;
}

type LimitVerdict =
  | { verdict: 'conflict'; kind: ConflictKind; basis: string }
  | { verdict: 'ok'; why: string; effective?: EffectiveLimit }
  | { verdict: 'undecided'; why: string };

function compareLimits(a: Constraint, b: Constraint, oa: ObligationView, ob: ObligationView): LimitVerdict {
  const da = durationDays(a);
  const db = durationDays(b);
  const kind: ConflictKind = oa.role === 'fact' || ob.role === 'fact' ? 'configuration-violation' : 'incompatible-requirements';
  let na: number | null;
  let nb: number | null;
  let unit: string | null = 'days';
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
          : { verdict: 'conflict', kind, basis: `${a.name} ${a.value ?? '?'} with ${a.name} ${b.value ?? '?'}` };
      }
      return { verdict: 'undecided', why: 'values that are not numbers' };
    }
    if ((a.unit ?? '') !== (b.unit ?? '')) return { verdict: 'undecided', why: `different units (${a.unit}, ${b.unit})` };
    unit = a.unit;
  }
  const basis = `${amount(a)} with ${amount(b)}`;
  if (oa.role === 'fact' && ob.role === 'fact') return { verdict: 'ok', why: 'two settings, neither is a requirement' };
  const both = intersect(interval(a.op, na), interval(b.op, nb));
  if (!both) return { verdict: 'conflict', kind, basis };
  if (oa.role === 'fact' || ob.role === 'fact') return { verdict: 'ok', why: 'the configured value meets the requirement' };
  const [lo, hi] = both;
  const u = unit ?? undefined;
  const mk = (op: Constraint['op'], n: number) => describeConstraint({ name: a.name, op, value: String(n), unit: u ?? null });
  const effective: EffectiveLimit | undefined =
    hi !== Infinity && lo !== -Infinity
      ? { text: lo === hi ? mk('==', lo) : `between ${lo} and ${hi}${u ? ` ${u}` : ''}`, min: lo, max: hi }
      : hi !== Infinity
        ? { text: mk('<=', hi), max: hi }
        : lo !== -Infinity
          ? { text: mk('>=', lo), min: lo }
          : undefined;
  return { verdict: 'ok', why: 'both limits can hold', ...(effective ? { effective } : {}) };
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

function violationExample(subject: string, req: { id: string; days: number }, cfg: { id: string; days: number }): string {
  return `${oneOf(subject)} from 1 March must be gone by ${dayAfter(req.days)} under ${req.id}, but ${cfg.id} is set to keep it ${cfg.days} days (until ${dayAfter(cfg.days)}).`;
}

/* ------------------------------ pairs ------------------------------ */

export function comparePromises(a: PromiseRecord, b: PromiseRecord): PairVerdict {
  const fa = normaliseFacets(a.facets);
  const fb = normaliseFacets(b.facets);
  if (!fa || !fb) return { verdict: 'undecided', why: 'a promise has no typed facets' };
  const oa = obligationOf(a, fa.constraint);
  const ob = obligationOf(b, fb.constraint);
  // Scope: a different reviewed tenant or resource is a different dataset; the same reviewed resource is the same one.
  const differs = (x: string | null, y: string | null) => x !== null && y !== null && x !== y;
  if (differs(oa.tenant, ob.tenant) || differs(oa.resource, ob.resource)) return { verdict: 'ok', why: 'different tenant or resource' };
  const sameResource = oa.resource !== null && oa.resource === ob.resource;
  const identity = sameResource ? 'same' : subjectIdentity(fa.subject, fb.subject);
  if (identity === 'unrelated') return { verdict: 'ok', why: `different subjects (${fa.subject}, ${fb.subject})` };
  if (!sameAction(fa.action, fb.action)) return { verdict: 'ok', why: `different actions (${fa.action}, ${fb.action})` };
  if (identity === 'unresolved') {
    return { verdict: 'undecided', needsPerson: true, why: `a person must decide if "${fa.subject}" and "${fb.subject}" are the same data` };
  }
  if (oa.applicability === 'ambiguous' || ob.applicability === 'ambiguous') {
    return { verdict: 'undecided', needsPerson: true, why: 'where one of the promises applies is ambiguous; a person must review it' };
  }
  if (oa.exceptions.length || ob.exceptions.length) {
    return { verdict: 'undecided', needsPerson: true, why: 'a promise has exceptions the program cannot evaluate' };
  }
  if (oa.role === 'unresolved' || ob.role === 'unresolved') {
    return { verdict: 'undecided', needsPerson: true, why: 'a setting is set to a value but its source does not say what that means (a configured value or a declared maximum)' };
  }
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
        kind: kindOf(oa, ob),
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
        kind: kindOf(oa, ob),
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
  const limits = compareLimits(sa.c, sb.c, oa, ob);
  if (limits.verdict !== 'conflict') return limits;
  const daysA = durationDays(sa.c);
  const daysB = durationDays(sb.c);
  const factA = oa.role === 'fact';
  const factB = ob.role === 'fact';
  let example: string;
  if (action === 'keep' && daysA !== null && daysB !== null && Math.min(daysA, daysB) >= 1 && factA !== factB) {
    const cfgIsA = factA;
    const [req, cfg] = cfgIsA ? [{ id: b.id, days: daysB }, { id: a.id, days: daysA }] : [{ id: a.id, days: daysA }, { id: b.id, days: daysB }];
    example = factA !== factB && cfg.days > req.days ? violationExample(subject, req, cfg) : `${capital(subject)} (${action}): ${a.id} says ${describeConstraint(sa.c)}, but ${b.id} says ${describeConstraint(sb.c)}.`;
  } else {
    example = `${capital(subject)} (${action}): ${a.id} says ${describeConstraint(sa.c)}, but ${b.id} says ${describeConstraint(sb.c)}.`;
  }
  return { verdict: 'conflict', kind: limits.kind, basis: limits.basis, example };
}

/** Every pair of live promises, in input order. */
export function compareAll(promises: readonly PromiseRecord[]): CompareAllResult {
  const live = promises.filter((p) => p.status !== 'retired');
  const conflicts: StructuredConflict[] = [];
  const undecided: Array<[string, string]> = [];
  const needsPerson: Array<[string, string]> = [];
  const compatible: CompareAllResult['compatible'] = [];
  let pairs = 0;
  for (let i = 0; i < live.length; i += 1) {
    for (let j = i + 1; j < live.length; j += 1) {
      const a = live[i] as PromiseRecord;
      const b = live[j] as PromiseRecord;
      if (a.id === b.id) continue;
      pairs += 1;
      const r = comparePromises(a, b);
      if (r.verdict === 'conflict') conflicts.push({ kind: r.kind, promiseIds: [a.id, b.id], basis: r.basis, example: r.example });
      else if (r.verdict === 'undecided') {
        undecided.push([a.id, b.id]);
        if (r.needsPerson) needsPerson.push([a.id, b.id]);
      } else if (r.effective) compatible.push({ promiseIds: [a.id, b.id], effective: r.effective });
    }
  }
  return { pairs, decided: pairs - undecided.length, conflicts, undecided, needsPerson, compatible };
}

/** For display: what the program compared for a structured conflict ('30 days with 90 days'), in the given order. */
export function structuredBasis(a: PromiseRecord, b: PromiseRecord): string | null {
  const r = comparePromises(a, b);
  return r.verdict === 'conflict' ? r.basis : null;
}
