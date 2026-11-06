// Optional semantic analyzers (mode 'semantic'). Core never depends on one: with no adapter loaded, a semantic rule
// is "not assessed" (outcome 'error'), never a pass. Adapters load only from the fixed allowlist below, never from a
// string a rule provides, and only when their version equals rule.semantic.adapterVersion.
import type { Citation, Rule, RuleRunResult, SourceFile } from '../contracts.js';

export interface SemanticFinding { readonly path: string; readonly line: number; readonly detail: string; readonly route?: string }
export interface SemanticGap { readonly kind: string; readonly detail: string; readonly path?: string; readonly line?: number }
export interface SemanticAnalysis {
  readonly control: string;
  readonly findings: readonly SemanticFinding[];
  readonly gaps: readonly SemanticGap[];
  readonly assessedRoutes?: number;
  readonly readSet?: readonly string[];
}
export interface SemanticInput { readonly files: readonly SourceFile[]; readonly control: string; readonly config: Record<string, unknown> }
export interface SemanticAdapter {
  readonly id: string;
  readonly version: string;
  /** Synchronous and offline; throws on bad config (reported as 'error'). Must not execute analyzed code. */
  analyze(input: SemanticInput): SemanticAnalysis;
}

/** adapter id -> [package name, path relative to this file for a checkout build]. Fixed; extend only in a reviewed change. */
const ALLOWLIST: Readonly<Record<string, readonly [string, string]>> = {
  'ts-export-control': ['@praesidia/jurator-analyzer-ts-export-control', '../../analyzers/ts-export-control/dist/index.js'],
};

const registry = new Map<string, SemanticAdapter>();
export function registerSemanticAdapter(adapter: SemanticAdapter): void {
  registry.set(adapter.id, adapter);
}
export function unregisterSemanticAdapter(id: string): void {
  registry.delete(id);
}
export function getSemanticAdapter(id: string): SemanticAdapter | undefined {
  return registry.get(id);
}

const isAdapter = (x: unknown): x is SemanticAdapter =>
  typeof x === 'object' && x !== null && typeof (x as SemanticAdapter).id === 'string' && typeof (x as SemanticAdapter).version === 'string' && typeof (x as SemanticAdapter).analyze === 'function';

/** Loads an allowlisted adapter by id (registering it). Resolves to null when unknown or not installed. */
export async function loadSemanticAdapter(id: string): Promise<SemanticAdapter | null> {
  const known = registry.get(id);
  if (known) return known;
  if (!Object.hasOwn(ALLOWLIST, id)) return null;
  const [pkg, local] = ALLOWLIST[id] as readonly [string, string];
  for (const spec of [pkg, new URL(local, import.meta.url).href]) {
    try {
      const mod = (await import(spec)) as { adapter?: unknown; default?: unknown };
      const found = mod.adapter ?? mod.default;
      if (isAdapter(found) && found.id === id) {
        registerSemanticAdapter(found);
        return found;
      }
    } catch {
      // not installed here: try the next location
    }
  }
  return null;
}

/** Preloads every adapter the semantic rules name. Call once before running rules (runRule is synchronous). */
export async function loadSemanticAdapters(rules: readonly Rule[]): Promise<void> {
  for (const id of new Set(rules.filter((r) => r.mode === 'semantic' && r.semantic).map((r) => (r.semantic as NonNullable<Rule['semantic']>).adapter))) {
    await loadSemanticAdapter(id);
  }
}

const MAX_SEMANTIC_HITS = 50;
const notAssessed = (base: { ruleId: string; promiseId: RuleRunResult['promiseId'] }, message: string, coverageGaps: NonNullable<RuleRunResult['coverageGaps']>): RuleRunResult => ({
  ...base, outcome: 'error', hits: [], message, coverageGaps,
});

/** Runs a semantic rule over the files it covers. 'fail' only on findings; gaps or a missing analyzer = 'error' (not assessed). */
export function runSemanticRule(rule: Rule, scoped: readonly SourceFile[], commit: string): RuleRunResult {
  const base = { ruleId: rule.id, promiseId: rule.promiseId };
  const sem = rule.semantic;
  if (!sem) return notAssessed(base, `${rule.id} is a semantic rule with no semantic settings: not assessed`, [{ kind: 'rule-invalid', detail: 'mode semantic needs a semantic block' }]);
  const adapter = registry.get(sem.adapter);
  if (!adapter) {
    return notAssessed(base, `${rule.id} needs the ${sem.adapter} analyzer, which is not installed: not assessed`, [{ kind: 'analyzer-unavailable', detail: `analyzer ${sem.adapter} is not available` }]);
  }
  if (adapter.version !== sem.adapterVersion) {
    return notAssessed(base, `${rule.id} needs ${sem.adapter} ${sem.adapterVersion} but ${adapter.version} is installed: not assessed`, [
      { kind: 'analyzer-unavailable', detail: `analyzer ${sem.adapter} version mismatch: rule wants ${sem.adapterVersion}, installed ${adapter.version}` },
    ]);
  }
  let out: SemanticAnalysis;
  try {
    out = adapter.analyze({ files: scoped, control: sem.control, config: sem.config });
  } catch (error) {
    return notAssessed(base, `${rule.id} analyzer failed: ${(error as Error).message}: not assessed`, [{ kind: 'analyzer-failed', detail: (error as Error).message }]);
  }
  if (out.control !== sem.control) {
    return notAssessed(base, `${rule.id} analyzer answered for control ${out.control}, not ${sem.control}: not assessed`, [{ kind: 'analyzer-failed', detail: 'control mismatch' }]);
  }
  const byPath = new Map(scoped.map((f) => [f.path, f.text.split(/\r?\n/u)] as const));
  const cite = (f: SemanticFinding): Citation | null => {
    const lines = byPath.get(f.path);
    const text = lines?.[f.line - 1];
    return text === undefined ? null : { path: f.path, commit, startLine: f.line, endLine: f.line, quote: text };
  };
  const gaps = out.gaps.map((g) => ({ kind: g.kind, detail: g.detail, ...(g.path ? { path: g.path } : {}), ...(g.line && g.line > 0 ? { line: g.line } : {}) }));
  const first = out.findings[0];
  if (first) {
    const hits = out.findings.map(cite).filter((c): c is Citation => c !== null).slice(0, MAX_SEMANTIC_HITS);
    const n = out.findings.length;
    return {
      ...base, outcome: 'fail', hits,
      message: `${first.path}:${first.line} ${first.detail}${first.route ? ` (${first.route})` : ''}${n > 1 ? ` (and ${n - 1} more)` : ''}`,
      ...(gaps.length > 0 ? { coverageGaps: gaps } : {}),
    };
  }
  if (gaps.length > 0) {
    return notAssessed(base, `${rule.id} could not assess ${gaps.length} part${gaps.length === 1 ? '' : 's'} of the code (${gaps[0]?.kind}: ${gaps[0]?.detail}): not assessed`, gaps);
  }
  if ((out.assessedRoutes ?? 1) === 0) {
    return notAssessed(base, `${rule.id} found nothing to assess in ${scoped.length} file${scoped.length === 1 ? '' : 's'}: not assessed`, [{ kind: 'nothing-assessed', detail: 'the analyzer assessed no routes' }]);
  }
  return { ...base, outcome: 'pass', hits: [], message: `${sem.control} holds on ${out.assessedRoutes ?? 'all'} modeled route${out.assessedRoutes === 1 ? '' : 's'}` };
}
