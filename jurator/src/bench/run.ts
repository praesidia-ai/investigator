// Owner: FX-3. `jurator bench`: planted breaks and harmless changes, scored for each way of checking.
//  - rules:    the accepted rules (no AI) for the promises the change touches
//  - ai-read:  the product's AI read prompt, one call per touched promise, on each model
//  - plain:    a plain SKILL.md-style review prompt on one model, given the raw policies and the diff
//  - jurator: rules where a promise has one, the first model's AI read where it does not (derived, no extra calls)
// Plus an optional red team: one model attacks each rule, another judges the edits the rule missed.
import { DEFAULT_CONFIG, type Config, type ModelClient, type ModelUsage, type PromiseRecord, type Rule } from '../contracts.js';
import { copyCitations, isSelected } from '../check/index.js';
import { AI_READ_INSTRUCTIONS, aiReadInput, aiReadSchema, type AiReadFile } from '../check/prompts.js';
import { runRule } from '../rules/engine.js';
import { numericConstraint } from '../rules/values.js';
import { mapPool } from '../rules/pool.js';
import { filesForRedteam, redteamRule, type RedteamReport } from '../rules/redteam.js';
import { matchesAny } from '../util/glob.js';
import { BRAND } from '../brand.js';
import { applyCase, type AppliedCase, type BenchCase, type BenchData } from './cases.js';
import { unifiedDiff } from './diff.js';
import { PLAIN_REVIEW_INSTRUCTIONS, plainReviewInput, plainReviewSchema } from './prompts.js';

export type MethodKind = 'rules' | 'ai-read' | 'plain' | 'jurator';

export interface BenchMethod {
  readonly id: string;
  readonly kind: MethodKind;
  readonly label: string;
  readonly model: string | null;
}

/** What one method said about one touched promise. */
export interface PromiseOutcome {
  readonly promiseId: string;
  readonly verdict: 'broken' | 'kept' | 'cant-tell' | 'not-checked' | 'error' | 'skipped';
  readonly note?: string;
  readonly usd: number;
  readonly calls: number;
}

export interface CaseOutcome {
  readonly caseId: string;
  /** Promise ids the method said are broken ('?' = a plain-prompt finding that names no known promise). */
  readonly flagged: readonly string[];
  readonly caught: boolean;
  readonly falseAlarm: boolean;
  /** Flags on promises the case does not break. */
  readonly wrongFlags: readonly string[];
  readonly errors: number;
  readonly calls: number;
  readonly usd: number;
  readonly promises: readonly PromiseOutcome[];
  readonly notes: readonly string[];
}

export interface MethodScore {
  readonly method: BenchMethod;
  readonly catches: number;
  readonly breaks: number;
  readonly falseAlarms: number;
  readonly harmless: number;
  readonly wrongFlags: number;
  readonly errors: number;
  readonly calls: number;
  readonly usd: number;
  /**
   * Promises this method already calls broken on the unchanged code. A diff review is judged on what the change adds,
   * so these are left out of catches, false alarms and wrong flags (and shown on their own).
   */
  readonly baselineFlags: readonly string[];
  readonly cases: readonly CaseOutcome[];
}

export interface BenchReport {
  readonly schemaVersion: 1;
  readonly createdAt: string;
  readonly repo: string;
  readonly commit: string;
  readonly mode: 'live' | 'scripted' | 'offline';
  readonly cases: ReadonlyArray<Pick<BenchCase, 'id' | 'kind' | 'title' | 'breaks'> & { changed: readonly string[]; touched: readonly string[] }>;
  readonly methods: readonly MethodScore[];
  readonly redteam: {
    readonly attacker: string;
    readonly judge: string | null;
    readonly reports: readonly RedteamReport[];
  } | null;
  readonly costUsd: number;
  readonly costByModel: ReadonlyArray<{ model: string; calls: number; usd: number; inputTokens: number; outputTokens: number }>;
  readonly budgetUsd: number;
  readonly skippedForBudget: number;
}

export interface LabelledModel {
  /** The model id shown in the table, e.g. muse-wonder-1.0 (a scripted client keeps the label it stands in for). */
  readonly label: string;
  readonly client: ModelClient;
}

export interface BenchOptions {
  readonly data: BenchData;
  /** Cases to run (ids); all when absent. */
  readonly caseIds?: readonly string[] | undefined;
  readonly rules?: boolean;
  /** One AI-read row per model, in order. The first one also feeds the derived Jurator row. */
  readonly readers?: readonly LabelledModel[];
  readonly plain?: LabelledModel | null;
  readonly redteam?: { readonly attacker: LabelledModel; readonly judge: LabelledModel | null } | null;
  /** Stop starting model calls once this much was spent. */
  readonly budgetUsd: number;
  /** Also run the AI reads on the unchanged code (default true), so old findings are not counted against a change. */
  readonly baseline?: boolean;
  readonly concurrency?: number;
  readonly now: () => Date;
  readonly onProgress?: (done: number, total: number) => void;
}

const round = (usd: number): number => Math.round(usd * 1_000_000) / 1_000_000;

class Budget {
  spent = 0;
  skipped = 0;
  readonly usages: ModelUsage[] = [];
  readonly cap: number;
  constructor(cap: number) {
    this.cap = cap;
  }
  get open(): boolean {
    return this.spent < this.cap;
  }
  add(usage: ModelUsage | undefined): number {
    if (!usage) return 0;
    this.spent += usage.usd;
    this.usages.push(usage);
    return usage.usd;
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function configFor(data: BenchData): Config {
  return { ...DEFAULT_CONFIG, codeScope: [...data.codeScope] };
}

function rulesOf(rules: readonly Rule[], promiseId: string): Rule[] {
  return rules.filter((r) => r.promiseId === promiseId && r.status === 'accepted');
}

/** Accepted code promises a change selects (same test as `check --diff`). */
export function touchedPromises(data: BenchData, applied: AppliedCase): PromiseRecord[] {
  const config = configFor(data);
  return data.promises.filter(
    (p) => p.status === 'accepted' && p.checkable === 'code' && isSelected(p, rulesOf(data.rules, p.id), config, applied.changed),
  );
}

function rulesOutcome(data: BenchData, applied: AppliedCase, promise: PromiseRecord): PromiseOutcome | null {
  const rules = rulesOf(data.rules, promise.id);
  if (rules.length === 0) return null;
  // Same as check: a value rule knows the promise's number, so `30 * 3` is read as 90 (FX-1).
  const constraint = numericConstraint(promise);
  const results = rules.map((r) => runRule(r, applied.files, data.commit, { constraint }));
  const failed = results.find((r) => r.outcome === 'fail');
  const errored = results.find((r) => r.outcome === 'error');
  if (failed) return { promiseId: promise.id, verdict: 'broken', note: failed.message, usd: 0, calls: 0 };
  if (errored) return { promiseId: promise.id, verdict: 'error', note: errored.message, usd: 0, calls: 0 };
  return { promiseId: promise.id, verdict: 'kept', usd: 0, calls: 0 };
}

function aiFiles(data: BenchData, applied: AppliedCase, promise: PromiseRecord): AiReadFile[] {
  const scope = promise.scope.length > 0 ? promise.scope : data.codeScope;
  const inScope = applied.files.filter((f) => matchesAny(f.path, scope));
  const changed = new Set(applied.changed);
  return [...inScope.filter((f) => changed.has(f.path)), ...inScope.filter((f) => !changed.has(f.path))];
}

export function aiReadTaskKey(caseId: string, promiseId: string): string {
  return `bench:ai-read:${caseId}:${promiseId}`;
}
export function plainTaskKey(caseId: string): string {
  return `bench:plain:${caseId}`;
}

async function aiOutcome(
  data: BenchData,
  applied: AppliedCase,
  promise: PromiseRecord,
  model: ModelClient,
  budget: Budget,
): Promise<PromiseOutcome> {
  const files = aiFiles(data, applied, promise);
  if (files.length === 0) return { promiseId: promise.id, verdict: 'not-checked', note: 'no code files in its scope', usd: 0, calls: 0 };
  if (!budget.open) {
    budget.skipped += 1;
    return { promiseId: promise.id, verdict: 'skipped', note: 'bench budget reached', usd: 0, calls: 0 };
  }
  try {
    const out = await model.json({
      task: aiReadTaskKey(applied.case.id, promise.id),
      instructions: AI_READ_INSTRUCTIONS,
      input: aiReadInput(promise, files, 0),
      schemaName: 'ai_read',
      schema: aiReadSchema,
      maxOutputTokens: 6000,
    });
    const usd = budget.add(out.usage);
    const sent = new Map(files.map((f) => [f.path, f.text] as const));
    const { citations } = copyCitations(out.value.citations, sent, data.commit);
    const note = out.value.explanation.trim().slice(0, 300);
    // Same rule as the product: "broken" with no lines that exist is not evidence.
    if (out.value.verdict === 'broken' && citations.length === 0) {
      return { promiseId: promise.id, verdict: 'cant-tell', note: `said broken but cited no lines that exist: ${note}`, usd, calls: 1 };
    }
    const verdict = out.value.verdict === 'kept' ? 'kept' : out.value.verdict === 'broken' ? 'broken' : 'cant-tell';
    return { promiseId: promise.id, verdict, note, usd, calls: 1 };
  } catch (error) {
    const usd = budget.add((error as { usage?: ModelUsage }).usage);
    return { promiseId: promise.id, verdict: 'error', note: errorText(error), usd, calls: 1 };
  }
}

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/gu, ' ').trim();

/** Which promises a plain-prompt finding is about, matched on the exact policy sentence (or the JSON setting name). */
export function promisesForSentence(sentence: string, promises: readonly PromiseRecord[]): string[] {
  const s = norm(sentence);
  if (s === '') return [];
  return promises
    .filter((p) => {
      if (p.quote.jsonPointer !== undefined) {
        const segs = p.quote.jsonPointer.split('/').filter(Boolean);
        const key = [...segs].reverse().find((x) => !/^\d+$/u.test(x));
        if (!key || !s.replaceAll(' ', '').includes(key.toLowerCase())) return false;
        const indexed = /^\d+$/u.test(segs[segs.length - 1] ?? '');
        return indexed ? s.includes(norm(p.quote.text)) : true;
      }
      const q = norm(p.quote.text);
      return q.length >= 8 && (s.includes(q) || (s.length >= 16 && q.includes(s)));
    })
    .map((p) => p.id);
}

async function plainOutcome(data: BenchData, applied: AppliedCase, model: ModelClient, budget: Budget): Promise<CaseOutcomeRaw> {
  if (!budget.open) {
    budget.skipped += 1;
    return { flagged: [], errors: 1, calls: 0, usd: 0, promises: [], notes: ['bench budget reached; not run'] };
  }
  const before = new Map(data.files.map((f) => [f.path, f.text] as const));
  const after = new Map(applied.files.map((f) => [f.path, f.text] as const));
  const diff = applied.changed.map((p) => unifiedDiff(p, before.get(p) ?? null, after.get(p) ?? '')).filter(Boolean).join('\n');
  const changed = applied.changed.map((p) => ({ path: p, text: after.get(p) ?? '' }));
  try {
    const out = await model.json({
      task: plainTaskKey(applied.case.id),
      instructions: PLAIN_REVIEW_INSTRUCTIONS,
      input: plainReviewInput(data.policies, diff, changed),
      schemaName: 'policy_review',
      schema: plainReviewSchema,
      maxOutputTokens: 8000,
    });
    const usd = budget.add(out.usage);
    const live = data.promises.filter((p) => p.status === 'accepted');
    const flagged = new Set<string>();
    const notes: string[] = [];
    for (const v of out.value.violations) {
      const ids = promisesForSentence(v.policySentence, live);
      if (ids.length === 0) flagged.add('?');
      for (const id of ids) flagged.add(id);
      notes.push(`${ids.length > 0 ? ids.join(',') : '?'}: "${v.policySentence.trim().slice(0, 120)}" - ${v.explanation.trim().slice(0, 200)}`);
    }
    return { flagged: [...flagged].sort(), errors: 0, calls: 1, usd, promises: [], notes };
  } catch (error) {
    const usd = budget.add((error as { usage?: ModelUsage }).usage);
    return { flagged: [], errors: 1, calls: 1, usd, promises: [], notes: [`failed: ${errorText(error)}`] };
  }
}

interface CaseOutcomeRaw {
  readonly flagged: readonly string[];
  readonly errors: number;
  readonly calls: number;
  readonly usd: number;
  readonly promises: readonly PromiseOutcome[];
  readonly notes: readonly string[];
}

function fromPromises(promises: readonly PromiseOutcome[]): CaseOutcomeRaw {
  return {
    flagged: promises.filter((p) => p.verdict === 'broken').map((p) => p.promiseId).sort(),
    errors: promises.filter((p) => p.verdict === 'error' || p.verdict === 'skipped').length,
    calls: promises.reduce((n, p) => n + p.calls, 0),
    usd: round(promises.reduce((n, p) => n + p.usd, 0)),
    promises,
    notes: [],
  };
}

function score(
  method: BenchMethod,
  applied: readonly AppliedCase[],
  raws: readonly CaseOutcomeRaw[],
  baseline: CaseOutcomeRaw | null,
): MethodScore {
  const pre = new Set(baseline?.flagged ?? []);
  const cases: CaseOutcome[] = applied.map((a, i) => {
    const raw = raws[i] as CaseOutcomeRaw;
    const breaks = new Set(a.case.breaks);
    const added = raw.flagged.filter((id) => !pre.has(id));
    const caught = a.case.kind === 'break' && added.some((id) => breaks.has(id));
    const wrongFlags = added.filter((id) => !breaks.has(id));
    return {
      caseId: a.case.id,
      ...raw,
      caught,
      falseAlarm: a.case.kind === 'harmless' && added.length > 0,
      wrongFlags,
    };
  });
  return {
    method,
    catches: cases.filter((c) => c.caught).length,
    breaks: applied.filter((a) => a.case.kind === 'break').length,
    falseAlarms: cases.filter((c) => c.falseAlarm).length,
    harmless: applied.filter((a) => a.case.kind === 'harmless').length,
    wrongFlags: cases.reduce((n, c) => n + c.wrongFlags.length, 0),
    errors: cases.reduce((n, c) => n + c.errors, 0),
    calls: cases.reduce((n, c) => n + c.calls, 0) + (baseline?.calls ?? 0),
    usd: round(cases.reduce((n, c) => n + c.usd, 0) + (baseline?.usd ?? 0)),
    baselineFlags: [...pre].sort(),
    cases,
  };
}

function costByModel(usages: readonly ModelUsage[], labels: ReadonlyMap<string, string>): BenchReport['costByModel'] {
  const by = new Map<string, { model: string; calls: number; usd: number; inputTokens: number; outputTokens: number }>();
  for (const u of usages) {
    const model = labels.get(u.id) ?? u.id;
    const row = by.get(model) ?? { model, calls: 0, usd: 0, inputTokens: 0, outputTokens: 0 };
    row.calls += 1;
    row.usd = round(row.usd + u.usd);
    row.inputTokens += u.inputTokens;
    row.outputTokens += u.outputTokens;
    by.set(model, row);
  }
  return [...by.values()].sort((a, b) => (a.model < b.model ? -1 : 1));
}

type Job = () => Promise<void>;

export async function runBench(options: BenchOptions): Promise<BenchReport> {
  const { data } = options;
  const wanted = options.caseIds && options.caseIds.length > 0 ? new Set(options.caseIds) : null;
  const cases = data.cases.filter((c) => wanted === null || wanted.has(c.id));
  const applied = cases.map((c) => applyCase(data, c));
  const touched = applied.map((a) => touchedPromises(data, a));
  const readers = options.readers ?? [];
  const budget = new Budget(options.budgetUsd);
  const jobs: Job[] = [];

  // AI reads: reader x case x touched promise.
  const ai: PromiseOutcome[][][] = readers.map(() => applied.map(() => []));
  readers.forEach((reader, r) => {
    applied.forEach((a, c) => {
      (touched[c] as PromiseRecord[]).forEach((p, k) => {
        jobs.push(async () => {
          ((ai[r] as PromiseOutcome[][])[c] as PromiseOutcome[])[k] = await aiOutcome(data, a, p, reader.client, budget);
        });
      });
    });
  });
  // The same AI reads on the unchanged code (every accepted code promise), to tell flags a change adds from old ones.
  const unchanged: AppliedCase = {
    case: { id: 'BASE', kind: 'harmless', title: 'unchanged code', breaks: [], edits: [] },
    files: data.files,
    changed: [],
  };
  const codePromises = data.promises.filter((p) => p.status === 'accepted' && p.checkable === 'code');
  const baseAi: PromiseOutcome[][] = readers.map(() => []);
  if (options.baseline !== false) {
    readers.forEach((reader, r) => {
      codePromises.forEach((p, k) => {
        jobs.push(async () => {
          (baseAi[r] as PromiseOutcome[])[k] = await aiOutcome(data, unchanged, p, reader.client, budget);
        });
      });
    });
  }
  const plain: CaseOutcomeRaw[] = [];
  if (options.plain) {
    const model = options.plain.client;
    applied.forEach((a, c) => {
      jobs.push(async () => {
        plain[c] = await plainOutcome(data, a, model, budget);
      });
    });
  }
  const redteam: RedteamReport[] = [];
  if (options.redteam) {
    const { attacker, judge } = options.redteam;
    const accepted = data.rules.filter((r) => r.status === 'accepted');
    accepted.forEach((rule, i) => {
      jobs.push(async () => {
        const promise = data.promises.find((p) => p.id === rule.promiseId);
        if (!promise) return;
        if (!budget.open) {
          budget.skipped += 1;
          redteam[i] = { ruleId: rule.id, promiseId: rule.promiseId, verdict: 'failed', attempts: [], usage: [], message: 'bench budget reached; not attacked' };
          return;
        }
        const files = filesForRedteam(rule, promise, data.files, data.codeScope);
        const report = await redteamRule(rule, promise, files, attacker.client, { judge: judge?.client ?? null });
        for (const u of report.usage) budget.add(u);
        redteam[i] = report;
      });
    });
  }

  let done = 0;
  await mapPool(jobs, options.concurrency ?? 6, async (job) => {
    await job();
    done += 1;
    options.onProgress?.(done, jobs.length);
  });

  const methods: MethodScore[] = [];
  const withBaseline = options.baseline !== false;
  const rulesAt = (a: AppliedCase, ps: readonly PromiseRecord[]): PromiseOutcome[] =>
    ps.map((p) => rulesOutcome(data, a, p)).filter((x): x is PromiseOutcome => x !== null);
  if (options.rules !== false) {
    const raws = applied.map((a, c) => fromPromises(rulesAt(a, touched[c] as PromiseRecord[])));
    const base = withBaseline ? fromPromises(rulesAt(unchanged, codePromises)) : null;
    methods.push(score({ id: 'rules', kind: 'rules', label: 'Rules only (no AI)', model: null }, applied, raws, base));
  }
  readers.forEach((reader, r) => {
    const raws = applied.map((_, c) => fromPromises((ai[r] as PromiseOutcome[][])[c] as PromiseOutcome[]));
    const base = withBaseline ? fromPromises(baseAi[r] as PromiseOutcome[]) : null;
    methods.push(
      score({ id: `ai-read:${reader.label}`, kind: 'ai-read', label: `AI read, ${reader.label}`, model: reader.label }, applied, raws, base),
    );
  });
  if (options.plain) {
    methods.push(
      score(
        { id: `plain:${options.plain.label}`, kind: 'plain', label: `Plain skill prompt, ${options.plain.label}`, model: options.plain.label },
        applied,
        plain,
        // A diff review of no diff says nothing, so the plain prompt has no baseline flags.
        null,
      ),
    );
  }
  const first = readers[0];
  if (first && options.rules !== false) {
    const raws = applied.map((a, c) =>
      fromPromises(
        (touched[c] as PromiseRecord[]).map((p, k) => rulesOutcome(data, a, p) ?? (((ai[0] as PromiseOutcome[][])[c] as PromiseOutcome[])[k] as PromiseOutcome)),
      ),
    );
    const base = withBaseline
      ? fromPromises(codePromises.map((p, k) => rulesOutcome(data, unchanged, p) ?? ((baseAi[0] as PromiseOutcome[])[k] as PromiseOutcome)))
      : null;
    // The derived row reuses the AI rows' calls, so it adds no cost of its own beyond the reads it would have made.
    methods.push(
      score(
        { id: `jurator:${first.label}`, kind: 'jurator', label: `${BRAND.name}: rules, else AI read (${first.label})`, model: first.label },
        applied,
        raws,
        base,
      ),
    );
  }

  const labels = new Map<string, string>();
  for (const m of [...readers, ...(options.plain ? [options.plain] : []), ...(options.redteam ? [options.redteam.attacker] : [])]) {
    if (m.client.mode === 'live') labels.set(m.client.id, m.label);
  }
  if (options.redteam?.judge?.client.mode === 'live') labels.set(options.redteam.judge.client.id, options.redteam.judge.label);
  const all = [...readers, options.plain, options.redteam?.attacker, options.redteam?.judge].filter(Boolean) as LabelledModel[];
  const mode: BenchReport['mode'] = all.length === 0 ? 'offline' : all.some((m) => m.client.mode === 'live') ? 'live' : 'scripted';

  return {
    schemaVersion: 1,
    createdAt: options.now().toISOString(),
    repo: data.repo,
    commit: data.commit,
    mode,
    cases: applied.map((a, c) => ({
      id: a.case.id,
      kind: a.case.kind,
      title: a.case.title,
      breaks: a.case.breaks,
      changed: a.changed,
      touched: (touched[c] as PromiseRecord[]).map((p) => p.id),
    })),
    methods,
    redteam: options.redteam
      ? { attacker: options.redteam.attacker.label, judge: options.redteam.judge?.label ?? null, reports: redteam.filter(Boolean) }
      : null,
    costUsd: round(budget.spent),
    costByModel: costByModel(budget.usages, labels),
    budgetUsd: options.budgetUsd,
    skippedForBudget: budget.skipped,
  };
}
