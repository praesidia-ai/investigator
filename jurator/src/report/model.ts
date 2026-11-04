// Owner: X-FRONTEND. What the report shows, decided once (no HTML here): one view per promise, per rule, per graph node.
// The level decides the words: only a rule says HOLDS/BROKEN; an AI read says LOOKS KEPT / LOOKS BROKEN / CAN'T TELL.
import type {
  CheckResult,
  CheckRun,
  Citation,
  Contradiction,
  PromiseRecord,
  Rule,
  RuleRunResult,
  Verdict,
} from '../contracts.js';

export interface ReportInput {
  readonly promises: readonly PromiseRecord[];
  readonly rules: readonly Rule[];
  readonly contradictions: readonly Contradiction[];
  /** Source alias -> locator, e.g. 'privacy' -> 'docs/privacy.md'. Order = config order. */
  readonly sources: Readonly<Record<string, string>>;
  readonly run: CheckRun | null;
  /** Where the run record lives, shown in the verify hint (repo-relative when possible). */
  readonly runPath?: string;
  /** Repo name for the title when there is no run. */
  readonly repoName?: string;
  readonly generatedAt: Date;
}

/** Visual tone: solid marks come from rules, dashed from AI reads, grey when nothing was judged. */
export type Tone = 'broken' | 'kept' | 'looks-broken' | 'looks-kept' | 'unsure' | 'none';

export interface VerdictView {
  /** The verdict word, e.g. 'BROKEN', 'LOOKS KEPT', 'touched, not checked'. */
  readonly word: string;
  /** Who decided, e.g. 'rule, no AI', 'read by AI'. */
  readonly by: string;
  readonly tone: Tone;
  /** Lower = worse; used to sort problems first. */
  readonly rank: number;
}

const VERDICTS: Readonly<Record<Verdict, VerdictView>> = {
  broken: { word: 'BROKEN', by: 'rule, no AI', tone: 'broken', rank: 0 },
  'looks-broken': { word: 'LOOKS BROKEN', by: 'read by AI', tone: 'looks-broken', rank: 1 },
  'cant-tell': { word: "CAN'T TELL", by: 'read by AI', tone: 'unsure', rank: 2 },
  'not-checked': { word: 'touched, not checked', by: 'quick check', tone: 'none', rank: 3 },
  'looks-kept': { word: 'LOOKS KEPT', by: 'read by AI', tone: 'looks-kept', rank: 4 },
  holds: { word: 'HOLDS', by: 'rule, no AI', tone: 'kept', rank: 5 },
};

export function verdictView(verdict: Verdict): VerdictView {
  return VERDICTS[verdict];
}

export interface PromiseView {
  readonly promise: PromiseRecord;
  readonly result: CheckResult | null;
  readonly verdict: VerdictView;
  /** Where the policy quote lives: 'docs/security.md:3' or 'policies/x.json#/dataRetentionDays'. */
  readonly policyWhere: string;
  /** Code evidence: the result's citations, else the lines its rules hit. */
  readonly citations: readonly Citation[];
  /** One plain sentence under the code: the rule message or the AI explanation. */
  readonly note: string | null;
  readonly rules: readonly Rule[];
  readonly onChecklist: boolean;
}

export interface RuleView {
  readonly rule: Rule;
  readonly result: RuleRunResult | null;
  /** 'pass' | 'fail' | 'error' | 'not run'. */
  readonly outcome: RuleRunResult['outcome'] | 'not run';
}

export interface Headline {
  readonly covered: number;
  readonly codePromises: number;
  readonly counts: ReadonlyArray<{ readonly view: VerdictView; readonly count: number }>;
}

function policyWhere(p: PromiseRecord, sources: Readonly<Record<string, string>>): string {
  const file = sources[p.quote.alias] ?? p.quote.alias;
  if (p.quote.jsonPointer) return `${file}#${p.quote.jsonPointer}`;
  return p.quote.line ? `${file}:${p.quote.line}` : file;
}

function notInRun(p: PromiseRecord, run: CheckRun | null, onChecklist: boolean): VerdictView {
  if (p.status === 'draft') return { word: 'draft', by: 'not accepted yet', tone: 'none', rank: 7 };
  if (p.checkable === 'process') {
    return onChecklist
      ? { word: 'on the PR checklist', by: 'a person confirms it', tone: 'none', rank: 6 }
      : { word: 'process', by: 'not in code', tone: 'none', rank: 8 };
  }
  if (p.checkable === 'runtime') return { word: 'enforced at runtime', by: 'not in code', tone: 'none', rank: 8 };
  if (!run) return { word: 'no check yet', by: 'run a check', tone: 'none', rank: 7 };
  if (run.target.kind === 'diff') return { word: 'not touched', by: 'by this change', tone: 'none', rank: 7 };
  return { word: 'not checked', by: 'this run', tone: 'none', rank: 7 };
}

function uniqueCitations(list: readonly Citation[]): Citation[] {
  const seen = new Set<string>();
  const out: Citation[] = [];
  for (const c of list) {
    const key = `${c.path}:${c.startLine}-${c.endLine}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

export function promiseViews(input: ReportInput): PromiseView[] {
  const results = new Map((input.run?.results ?? []).map((r) => [r.promiseId, r]));
  const checklist = new Set((input.run?.checklist ?? []).map((c) => c.promiseId));
  return input.promises
    .filter((p) => p.status !== 'retired')
    .map((p) => {
      const result = results.get(p.id) ?? null;
      const onChecklist = checklist.has(p.id);
      const hits = (result?.ruleResults ?? []).flatMap((r) => r.hits);
      const citations = uniqueCitations(result ? (result.citations.length > 0 ? result.citations : hits) : []);
      const note = result
        ? (result.explanation ?? result.reason ?? null)
        : null;
      return {
        promise: p,
        result,
        verdict: result ? verdictView(result.verdict) : notInRun(p, input.run, onChecklist),
        policyWhere: policyWhere(p, input.sources),
        citations,
        note,
        rules: input.rules.filter((r) => r.promiseId === p.id),
        onChecklist,
      };
    });
}

export function sortByVerdict(views: readonly PromiseView[]): PromiseView[] {
  return [...views].sort((a, b) => a.verdict.rank - b.verdict.rank || 0);
}

export function ruleViews(input: ReportInput): RuleView[] {
  const byRule = new Map<string, RuleRunResult>();
  for (const r of input.run?.results ?? []) for (const rr of r.ruleResults ?? []) byRule.set(rr.ruleId, rr);
  return input.rules.map((rule) => {
    const result = byRule.get(rule.id) ?? null;
    return { rule, result, outcome: result ? result.outcome : 'not run' };
  });
}

export function headline(input: ReportInput): Headline {
  const code = input.promises.filter((p) => p.status === 'accepted' && p.checkable === 'code');
  const ruled = new Set(input.rules.filter((r) => r.status === 'accepted').map((r) => r.promiseId));
  const covered = input.run ? input.run.summary.coveredByRules : code.filter((p) => ruled.has(p.id)).length;
  const codePromises = input.run ? input.run.summary.codePromises : code.length;
  const tally = new Map<Verdict, number>();
  for (const r of input.run?.results ?? []) tally.set(r.verdict, (tally.get(r.verdict) ?? 0) + 1);
  const order: Verdict[] = ['broken', 'looks-broken', 'cant-tell', 'not-checked', 'looks-kept', 'holds'];
  const counts = order
    .filter((v) => (tally.get(v) ?? 0) > 0)
    .map((v) => ({ view: verdictView(v), count: tally.get(v) ?? 0 }));
  return { covered, codePromises, counts };
}

export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** '4 Nov 2026, 03:36 UTC': fixed format so the same run renders the same page on every machine. */
export function humanTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()] ?? ''} ${d.getUTCFullYear()}, ${hh}:${mm} UTC`;
}
