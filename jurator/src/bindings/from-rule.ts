// Owner: WP-B. Bindings from rules (no AI): the lines that made an accepted rule pass on a good commit.
import type { Binding, Citation, GitRepo, PromiseRecord, Rule, RuleRunResult, SourceFile, Store } from '../contracts.js';
import { acceptedRulesFor, loadRuleFiles, runRule } from '../rules/index.js';
import { sha256 } from '../util/json.js';
import { expectedFor, kindFor, patternNames, symbolFor, type BindingKind } from './symbols.js';
import { readBindings, writeBindings } from './store.js';

/** At most this many bindings per rule (a broad rule can pass on many lines; the first ones are enough to notice). */
export const MAX_BINDINGS_PER_RULE = 10;

export const bindingId = (promiseId: string, n: number): string => `B-${promiseId}-${n}`;

/** Gives a promise's bindings the ids B-<promiseId>-1..n in order. */
export function numberBindings(promiseId: string, items: readonly Binding[]): Binding[] {
  return items.map((b, i) => ({ ...b, id: bindingId(promiseId, i + 1) }));
}

/** Makes one binding from program-copied lines (a rule hit or a verified model location). */
export function makeBinding(
  promise: PromiseRecord,
  cite: Citation,
  options: { symbol: string | null; kind: BindingKind; foundBy: Binding['foundBy']; n: number },
): Binding {
  return {
    id: bindingId(promise.id, options.n),
    promiseId: promise.id,
    path: cite.path,
    symbol: options.symbol,
    kind: options.kind,
    startLine: cite.startLine,
    endLine: cite.endLine,
    quote: cite.quote,
    quoteSha256: sha256(cite.quote),
    anchoredAt: cite.commit,
    expected: expectedFor(promise, options.kind),
    foundBy: options.foundBy,
  };
}

/**
 * A passing rule's hits become bindings. each-near: the anchor line through its guard (kind guard, symbol = the guard
 * call, e.g. requireAdmin). must-match: each matching line (symbol from a declaration or a name the pattern spells
 * out; kind constant for `CHAT_TTL_DAYS = 30`). must-not-match passes with no hits: nothing to bind.
 */
export function bindingsFromRule(promise: PromiseRecord, rule: Rule, result: RuleRunResult): Binding[] {
  if (result.outcome !== 'pass' || rule.promiseId !== promise.id || result.ruleId !== rule.id) return [];
  if (rule.mode === 'must-not-match') return [];
  const names = patternNames(rule.pattern);
  const seen = new Set<string>();
  const out: Binding[] = [];
  for (const hit of result.hits) {
    const key = `${hit.path}:${hit.startLine}-${hit.endLine}`;
    if (seen.has(key) || hit.quote.trim() === '') continue;
    seen.add(key);
    const lines = hit.quote.split('\n');
    let symbol: string | null;
    let kind: BindingKind;
    if (rule.mode === 'each-near') {
      const guardLine = lines[lines.length - 1] ?? '';
      symbol = names.find((n) => guardLine.includes(n)) ?? symbolFor(guardLine, names);
      kind = 'guard';
    } else {
      const line = lines[0] ?? '';
      symbol = symbolFor(line, names);
      kind = kindFor(hit.path, line, symbol);
      // A rule on a promise with a number (retention <= 30 days) binds the value itself.
      if (kind === 'other' && promise.facets?.constraint?.value && /\d/u.test(line)) kind = 'constant';
    }
    out.push(makeBinding(promise, hit, { symbol, kind, foundBy: 'rule', n: out.length + 1 }));
    if (out.length >= MAX_BINDINGS_PER_RULE) break;
  }
  return out;
}

/** Bindings from every accepted rule of one promise that passes at `commit` (renumbered across rules). */
export function bindingsFromRules(promise: PromiseRecord, rules: readonly Rule[], files: readonly SourceFile[], commit: string): Binding[] {
  const all: Binding[] = [];
  for (const rule of acceptedRulesFor(promise.id, rules)) {
    for (const b of bindingsFromRule(promise, rule, runRule(rule, files, commit))) {
      if (!all.some((x) => x.path === b.path && x.startLine === b.startLine && x.endLine === b.endLine)) all.push(b);
    }
  }
  return numberBindings(promise.id, all);
}

/**
 * Merges new bindings for some promises into the saved ones: the promise's previous rule/model bindings are replaced,
 * bindings a person wrote (foundBy human) stay. Ids are renumbered per promise.
 */
export function mergeBindings(saved: readonly Binding[], fresh: ReadonlyMap<string, readonly Binding[]>): Binding[] {
  const out: Binding[] = saved.filter((b) => !fresh.has(b.promiseId));
  for (const [promiseId, items] of fresh) {
    const human = saved.filter((b) => b.promiseId === promiseId && b.foundBy === 'human');
    const rest = items.filter((b) => !human.some((h) => h.path === b.path && h.startLine === b.startLine && h.endLine === b.endLine));
    out.push(...numberBindings(promiseId, [...human, ...rest]));
  }
  return out;
}

/**
 * After rules are accepted (`rule propose --accept`): saves the bindings their passing hits give. Never throws, so a
 * bindings problem cannot fail the rule command; returns how many bindings were saved.
 */
export async function recordRuleBindings(args: {
  readonly store: Store;
  readonly repo: GitRepo;
  readonly commit: string;
  readonly promises: readonly PromiseRecord[];
  readonly rules: readonly Rule[];
}): Promise<number> {
  try {
    const cache = new Map<string, string>();
    const fresh = new Map<string, Binding[]>();
    for (const p of args.promises) {
      if (p.status !== 'accepted' || p.checkable !== 'code') continue;
      const rules = acceptedRulesFor(p.id, args.rules);
      if (rules.length === 0) continue;
      const globs = [...new Set(rules.flatMap((r) => r.globs))];
      const items = bindingsFromRules(p, rules, await loadRuleFiles(args.repo, args.commit, globs, cache), args.commit);
      if (items.length > 0) fresh.set(p.id, items);
    }
    if (fresh.size === 0) return 0;
    const merged = mergeBindings(await readBindings(args.store), fresh);
    await writeBindings(args.store, merged);
    return [...fresh.values()].reduce((n, b) => n + b.length, 0);
  } catch {
    return 0;
  }
}
