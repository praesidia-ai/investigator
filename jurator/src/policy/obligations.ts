// Obligation view of a promise (no AI): what kind of statement it is, which tenant/resource it is scoped to, and the
// number it carries. compare.ts uses it so a configured value, a declared maximum and a requirement are not mixed up.
// shortcut: no legal-language solver; exceptions are only detected (any exception => a person decides).
import type { PromiseFacets, PromiseRecord } from '../contracts.js';
import { durationDays, numeric } from './facets.js';

type Constraint = NonNullable<PromiseFacets['constraint']>;

/**
 * - requirement: a limit the promise states (also a connector's declared maximum).
 * - fact: a configured value or an observation; it is what a system does, so a stricter requirement can be broken by it.
 * - unresolved: a setting whose meaning the source does not say.
 */
export type ObligationRole = 'requirement' | 'fact' | 'unresolved';

export interface ObligationView {
  readonly role: ObligationRole;
  readonly tenant: string | null;
  readonly resource: string | null;
  readonly applicability: 'stated' | 'reviewed' | 'ambiguous';
  readonly exceptions: readonly string[];
  readonly modality: PromiseRecord['kind'];
  /** The exact policy words the view rests on. */
  readonly citation: string;
  /** Normalised number: durations in days. */
  readonly quantity: { readonly value: number; readonly unit: string | null } | null;
}

export function quantityOf(c: Constraint | null | undefined): { value: number; unit: string | null } | null {
  if (!c || c.op === 'never' || c.op === 'always') return null;
  const days = durationDays(c);
  if (days !== null) return { value: days, unit: 'days' };
  const n = numeric(c.value);
  return n === null ? null : { value: n, unit: c.unit };
}

export function obligationOf(p: PromiseRecord, c?: Constraint | null): ObligationView {
  const o = p.obligation;
  let role: ObligationRole = 'requirement';
  if (o?.statement === 'observation') role = 'fact';
  else if (o?.statement === 'configuration') {
    role = o.interpretation === 'configured-value' ? 'fact' : o.interpretation === 'declared-maximum' ? 'requirement' : 'unresolved';
  }
  return {
    role,
    tenant: o?.tenant ?? null,
    resource: o?.resource ?? null,
    applicability: o?.applicability ?? 'stated',
    exceptions: o?.exceptions ?? [],
    modality: p.kind,
    citation: p.quote.text,
    quantity: quantityOf(c),
  };
}

/** [low, high] that a numeric relation allows (inclusive). */
export function interval(op: Constraint['op'], n: number): [number, number] {
  if (op === '<=') return [-Infinity, n];
  if (op === '>=') return [n, Infinity];
  return [n, n];
}

/** The range both intervals allow, or null when they cannot both hold. */
export function intersect(a: [number, number], b: [number, number]): [number, number] | null {
  const lo = Math.max(a[0], b[0]);
  const hi = Math.min(a[1], b[1]);
  return lo > hi ? null : [lo, hi];
}
