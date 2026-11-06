// Owner: WP-R. `jurator rule`: the model writes rules, the program proves them, rules run with no AI.
import { resolve } from 'node:path';
import type { Config, GitRepo, ModelClient, PromiseRecord, Rule, RuleRunResult, SourceFile, Store } from '../../contracts.js';
import { createModel } from '../../model/index.js';
import { budgetStopLines, withBudget } from '../../model/budget.js';
import { openRepo } from '../../git/index.js';
import { findRepoRoot, openStore } from '../../workspace/index.js';
import {
  DEFAULT_CONCURRENCY,
  describeEvidence,
  MAX_CONCURRENCY,
  filesForRedteam,
  hardenRule,
  loadRuleFiles,
  nextMutants,
  readMutants,
  testMutants,
  saveAssessment,
  readBundle,
  verifyBundle,
  writeMutants,
  mapPool,
  nextInfeasible,
  nextNoRule,
  numericConstraint,
  proposeRule,
  readNoRule,
  writeNoRule,
  type NoRuleFile,
  readInfeasible,
  REDTEAM_ATTACKER_MODEL,
  REDTEAM_JUDGE_MODEL,
  ruleCoverage,
  runRule,
  showEdit,
  writeInfeasible,
  type HardenReport,
  type MutantResult,
  type MutantsFile,
  type RedteamReport,
} from '../../rules/index.js';
import { JuratorError } from '../../util/errors.js';
import type { Command, CommandContext } from '../context.js';
import { BRAND } from '../../brand.js';
import { recordRuleBindings } from '../../bindings/index.js';
import { withVideo } from '../../render/video.js';
import { fancy, liveFor, modelLabel, print, screenUi, trackModel, workspaceLabel } from '../../render/screen.js';
import { BADGE_WORDS, type Ui } from '../../ui/index.js';
import { policyWhere } from '../../render/index.js';
import {
  fileSummaryCache,
  findingRows,
  fromBrokenNow,
  fromNoRule,
  plainReason,
  repoFacts,
  ruleLine,
  shortIdsFor,
  summarizeAll,
  summaryLabel,
  summaryModel,
  templateSummary,
  type Finding,
  type ShortIds,
  type Summary,
} from '../../explain/index.js';

/** What the command needs from other packages; tests pass fakes. */
export interface RuleCommandDeps {
  findRepoRoot(cwd: string): Promise<string>;
  openStore(repoRoot: string): Store;
  openRepo(repoRoot: string): Promise<GitRepo>;
  createModel(options: { config: Config; env: NodeJS.ProcessEnv; scriptedDir?: string }): ModelClient;
  /** The per-machine cache of promises the model judged infeasible (default: .jurator/local/infeasible.json). */
  readonly infeasible?: {
    read(juratorDir: string): Promise<string[]>;
    write(juratorDir: string, ids: readonly string[]): Promise<boolean>;
  };
  /** AC-A: why each promise got no rule (default: .jurator/local/no-rule.json). */
  readonly noRule?: {
    read(juratorDir: string): Promise<NoRuleFile>;
    write(juratorDir: string, data: NoRuleFile): Promise<boolean>;
  };
  /** FU-1: red-team evasions kept as extra mutants per rule (default: .jurator/local/rule-mutants.json). */
  readonly mutants?: {
    read(juratorDir: string): Promise<MutantsFile>;
    write(juratorDir: string, data: MutantsFile): Promise<boolean>;
  };
}
const defaultDeps: RuleCommandDeps = { findRepoRoot, openStore, openRepo, createModel };
const fileInfeasible = { read: readInfeasible, write: writeInfeasible };
const fileMutants = { read: readMutants, write: writeMutants };
const fileNoRule = { read: readNoRule, write: writeNoRule };

const USAGE =
  `${BRAND.command} rule propose <promise-id>[,<promise-id>...]|--all [--accept] [--redteam] [--budget <usd>] [--concurrency <n>] [--scripted <dir>] [--json]\n` +
  `       ${BRAND.command} rule test [<rule-id>] [--at <ref>] [--json]\n` +
  `       ${BRAND.command} rule list [--json]\n` +
  `       ${BRAND.command} rule accept <rule-id>|--all`;

interface Args {
  readonly sub: string | undefined;
  readonly target: string | undefined;
  readonly flags: ReadonlySet<string>;
  readonly values: Readonly<Record<string, string>>;
}
function parseArgs(argv: readonly string[]): Args {
  const positional: string[] = [];
  const flags = new Set<string>();
  const values: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i] as string;
    if (a === '--scripted' || a === '--at' || a === '--jobs' || a === '--concurrency' || a === '--budget') {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) throw new JuratorError('BAD_INPUT', `${a} needs a value`);
      // --jobs is the older name of --concurrency.
      values[a === '--jobs' ? 'concurrency' : a.slice(2)] = v;
      i += 1;
    } else if (a.startsWith('--')) flags.add(a.slice(2));
    else positional.push(a);
  }
  return { sub: positional[0], target: positional[1], flags, values };
}

const byId = <T extends { id: string }>(a: T, b: T): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const short = (sha: string): string => sha.slice(0, 7);

async function open(ctx: CommandContext, deps: RuleCommandDeps): Promise<{ root: string; store: Store }> {
  const root = await deps.findRepoRoot(ctx.cwd);
  const store = deps.openStore(root);
  if (!(await store.exists())) throw new JuratorError('NO_WORKSPACE', `there is no ${BRAND.folder}/ folder here. Run ${BRAND.command} init first.`);
  return { root, store };
}

function printHits(ctx: CommandContext, res: RuleRunResult): void {
  for (const h of res.hits.slice(0, 5)) {
    const first = h.quote.split('\n')[0]?.trim() ?? '';
    ctx.out(`    ${ctx.style.dim(`${h.path}:${h.startLine}`)}  ${first.length > 100 ? `${first.slice(0, 99)}…` : first}`);
  }
  if (res.hits.length > 5) ctx.out(ctx.style.dim(`    ... ${res.hits.length - 5} more`));
}

const RED_MARK: Record<RedteamReport['verdict'], string> = { weak: 'weak', held: 'held', unsure: 'unsure', failed: 'not run' };

/** The red-team report under a written rule: the verdict, then each edit and what the rule and the judge did. */
function printRedteam(ctx: CommandContext, red: RedteamReport, title = 'red team'): void {
  const mark = red.verdict === 'held' ? ctx.style.green : red.verdict === 'weak' ? ctx.style.red : ctx.style.yellow;
  // The edits below say what happened; the message alone matters when there are none (or the call failed).
  const why = red.verdict === 'failed' || red.attempts.length === 0 ? `: ${red.message}` : '';
  ctx.out(`    ${title}: ${mark(RED_MARK[red.verdict])}${why}`);
  for (const a of red.attempts) {
    const what =
      a.rule === 'not-applied'
        ? `not applied (${a.problem ?? ''})`
        : a.rule === 'caught'
          ? 'rule caught it'
          : a.rule === 'error'
            ? `rule error (${a.problem ?? ''})`
            : a.judge === 'breaks'
              ? 'rule passed; the judge says it breaks the promise'
              : a.judge === 'keeps'
                ? 'rule passed; the judge says the promise still holds'
                : 'rule passed; the judge could not tell';
    ctx.out(ctx.style.dim(`      ${a.n}. ${showEdit(a.edit, 90)}: ${what}`));
  }
}

/** FU-1: the first attack, each repair round (and the attack on each proven repair), then closed or still evadable. */
function printHarden(ctx: CommandContext, h: HardenReport): void {
  printRedteam(ctx, h.redteam, h.rounds.length > 0 ? 'red team on the first version' : 'red team');
  for (const r of h.rounds) {
    const head = `    repair ${r.round}: `;
    if (r.outcome === 'proven') {
      ctx.out(`${head}${ctx.style.green('proven')} (${r.rule?.mode ?? ''}): ${r.rule?.description ?? ''}`);
      if (r.redteam) printRedteam(ctx, r.redteam, `  red team on repair ${r.round}`);
    } else {
      const what = r.outcome === 'rejected' ? 'rejected by the program' : r.outcome === 'gave-up' ? 'the writer could not close it' : r.outcome === 'skipped' ? 'skipped' : 'failed';
      ctx.out(`${head}${ctx.style.yellow(what)}: ${r.reason ?? ''}`);
    }
  }
  if (h.verdict === 'closed') ctx.out(`    ${ctx.style.green(h.message)}`);
  else if (h.verdict === 'still-evadable') ctx.out(`    ${ctx.style.red(h.message)}`);
}

/** The repair part of the JSON output (the first attack stays in `redteam`, as before). */
function hardeningJson(h: HardenReport): Record<string, unknown> {
  return {
    verdict: h.verdict,
    message: h.message,
    repaired: h.repaired,
    rounds: h.rounds.map((r) => ({
      round: r.round,
      outcome: r.outcome,
      ...(r.reason ? { reason: r.reason } : {}),
      ...(r.rule ? { rule: { mode: r.rule.mode, pattern: r.rule.pattern, ...(r.rule.anchor ? { anchor: r.rule.anchor } : {}), globs: r.rule.globs } } : {}),
      ...(r.redteam ? { redteam: { verdict: r.redteam.verdict, message: r.redteam.message, attempts: r.redteam.attempts } } : {}),
    })),
    closed: h.closed,
    open: h.open,
    costUsd: h.usage.reduce((sum, u) => sum + u.usd, 0),
  };
}

/** R4-FIX: `--budget <usd>` is the run budget (every model call, the red team included); default config.budgetUsdPerRun. */
function budgetOf(args: Args): number | undefined {
  const raw = args.values.budget;
  if (raw === undefined) return undefined;
  const n = Number(raw.replace(/^\$/u, ''));
  if (!Number.isFinite(n) || n <= 0) throw new JuratorError('BAD_INPUT', `--budget must be an amount in USD above 0, such as 10, not ${raw}`);
  return n;
}

const MUTANT_MARK: Record<MutantResult['outcome'], string> = {
  caught: 'caught',
  missed: 'MISSED',
  'still-open': 'still open',
  'now-caught': 'now caught',
  'not-applied': 'no longer applies',
  error: 'error',
};

/** FU-1: under a rule in `rule test`, what it did on each stored evasion. */
function printMutants(ctx: CommandContext, ms: readonly MutantResult[]): void {
  for (const m of ms) {
    const mark = m.outcome === 'caught' || m.outcome === 'now-caught' ? ctx.style.green : m.outcome === 'missed' ? ctx.style.red : ctx.style.yellow;
    const tail = m.outcome === 'not-applied' || m.outcome === 'error' ? ` (${m.message})` : '';
    ctx.out(ctx.style.dim(`    evasion ${m.n}: ${m.edit}: `) + mark(MUTANT_MARK[m.outcome]) + ctx.style.dim(tail));
  }
}

function jobsOf(args: Args): number {
  const raw = args.values.concurrency;
  if (raw === undefined) return DEFAULT_CONCURRENCY;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > MAX_CONCURRENCY) {
    throw new JuratorError('BAD_INPUT', `--concurrency (or --jobs) must be a whole number from 1 to ${MAX_CONCURRENCY}, not ${raw}`);
  }
  return n;
}
const mentionsAiReads = (reason: string): boolean => /AI reads?/iu.test(reason);

/**
 * R4-UI2, HZ-1: the final rule propose screen. One row per promise: its short id, the result, what it promises, and a
 * plain line under it (what the rule checks, or why there is no rule). Then a box per BROKEN NOW: the plain summary
 * first, Found (path:line before each code line), To fix, the policy sentence once. Proofs and patterns only with
 * --verbose or `jurator explain <id>`.
 */
function proposeScreen(
  ui: Ui,
  d: {
    readonly outcomes: ReadonlyArray<{ p: PromiseRecord; res: Awaited<ReturnType<typeof proposeRule>>; seconds: number }>;
    readonly redteams: ReadonlyMap<string, HardenReport>;
    readonly accept: boolean;
    readonly usd: number;
    readonly budget: number;
    readonly written: number;
    readonly n: number;
    readonly brokenNow: readonly string[];
    readonly byPromise: ReadonlyMap<string, PromiseRecord>;
    readonly ids: ShortIds;
    readonly summaries: ReadonlyMap<string, Summary>;
    readonly findings: ReadonlyMap<string, Finding>;
    readonly sources: Readonly<Record<string, string>>;
  },
): string[] {
  const out: string[] = [];
  const rows: string[][] = [];
  const notes: Array<string | undefined> = [];
  const proofs: Array<{ label: string; text: string }> = [];
  const sid = (id: string): string => d.ids.short(id);
  let aiNotes: Summary | undefined;
  for (const { p, res } of d.outcomes) {
    const promise = d.byPromise.get(p.id) ?? p;
    if (res.ok) {
      const red = d.redteams.get(p.id);
      const rule = red?.rule ?? res.rule;
      const result = res.brokenNow ? ui.badge('broken-now') : ui.tone(`${ui.sym.done} ${d.accept ? 'rule accepted' : 'rule written'}`, 'kept');
      rows.push([sid(p.id), result, promise.wording]);
      notes.push(`Rule: ${ruleLine(rule)}${red?.repaired ? ' (repaired after the red team)' : ''}`);
      proofs.push({ label: rule.id, text: `${rule.provenBy?.mutation ?? ''}\npattern: ${rule.pattern}${rule.anchor ? `\nanchor: ${rule.anchor}` : ''}\nglobs: ${rule.globs.join(', ')}` });
    } else if (res.budgetStopped) {
      rows.push([sid(p.id), ui.tone(`${ui.sym.skipped} not asked`, 'muted'), promise.wording]);
      const why = plainReason(res.reason, { id: sid(p.id), budgetStopped: true });
      notes.push(why.text);
    } else {
      const word = res.infeasible ? 'no rule possible' : 'no rule this time';
      rows.push([sid(p.id), ui.tone(`${ui.sym.dot} ${word}`, 'muted'), promise.wording]);
      const s = d.summaries.get(p.id);
      if (s?.by === 'ai') aiNotes = s;
      const why = plainReason(res.reason, { id: sid(p.id), infeasible: res.infeasible === true });
      const text = s?.by === 'ai' ? s.summary : why.text;
      notes.push(`${text}${why.retry ? ` Retry: ${why.retry}` : mentionsAiReads(text) ? '' : ' It stays on AI reads.'}`);
    }
  }
  const right = `${d.written} of ${d.n} written${d.brokenNow.length > 0 ? ` · ${d.brokenNow.length} broken now` : ''}`;
  out.push(...ui.section('Rules', right));
  out.push(
    ...ui.table({
      columns: [
        { header: 'Promise', min: 6 },
        { header: 'Result', min: 12 },
        { header: 'What it promises', flex: true, min: 20 },
      ],
      rows,
      wrap: 2,
      notes,
      noteLines: 3,
    }),
  );
  if (aiNotes) out.push('', ...ui.hint(`  Notes under "no rule" rows: ${summaryLabel(aiNotes)}.`));
  const verbose = ui.caps.verbose;
  for (const { p, res } of d.outcomes) {
    if (!res.ok || !res.brokenNow) continue;
    const promise = d.byPromise.get(p.id) ?? p;
    const rule = d.redteams.get(p.id)?.rule ?? res.rule;
    const finding = d.findings.get(p.id) ?? fromBrokenNow(promise, rule, res.brokenNow);
    const summary = d.summaries.get(p.id) ?? templateSummary(finding, sid(p.id));
    out.push('');
    out.push(
      ...ui.finding({
        kind: 'broken-now',
        id: sid(p.id),
        title: "today's code breaks it",
        rows: findingRows({
          finding,
          summary,
          id: sid(p.id),
          policyWhere: policyWhere(promise.quote, d.sources),
          verbose,
          details: [
            { label: 'Rule', text: `${rule.id} (${rule.mode}): ${ruleLine(rule)}`, maxLines: 3 },
            { label: 'Pattern', text: rule.pattern, maxLines: 4 },
            { label: 'Proof', text: res.brokenNow.fix, tone: 'muted', maxLines: 3 },
          ],
        }),
      }),
    );
  }
  if (d.redteams.size > 0) {
    out.push(...ui.section('Red team'));
    out.push(
      ...ui.table({
        columns: [{ header: 'Promise', min: 6 }, { header: 'Verdict', min: 10 }, { header: 'What happened', flex: true, min: 16 }],
        rows: [...d.redteams.values()].map((h) => [
          sid(h.promiseId),
          h.verdict === 'closed' || h.redteam.verdict === 'held' ? ui.tone(h.verdict === 'closed' ? 'closed' : 'held', 'kept') : h.verdict === 'still-evadable' ? ui.tone('evadable', 'broken') : ui.tone(h.redteam.verdict, 'muted'),
          h.message || h.redteam.message,
        ]),
        wrap: 2,
      }),
    );
  }
  const shownProofs = ui.verbose('Proofs', proofs);
  if (shownProofs.length > 0) out.push('', ...shownProofs);
  else if (proofs.length > 0 || d.brokenNow.length > 0) {
    out.push('', ...ui.hint(`  Details (patterns, proofs, every line found): --verbose, or ${BRAND.command} explain <promise>`));
  }
  out.push('');
  out.push(
    ...ui.cards([
      { value: String(d.written - d.brokenNow.length), label: d.accept ? 'rules accepted' : 'rules written', tone: 'kept' },
      { value: String(d.brokenNow.length), label: BADGE_WORDS['broken-now'].toLowerCase(), tone: d.brokenNow.length > 0 ? 'broken' : 'muted' },
      { value: String(d.n - d.written), label: 'no rule', tone: 'muted' },
      { value: `$${d.usd.toFixed(2)}`, label: `of $${d.budget.toFixed(2)} budget`, tone: 'accent' },
    ]),
  );
  return out;
}

async function propose(ctx: CommandContext, deps: RuleCommandDeps, args: Args): Promise<number> {
  const all = args.flags.has('all');
  if (!all && !args.target) throw new JuratorError('BAD_INPUT', `say which promise: ${BRAND.command} rule propose <promise-id> or --all\nUsage: ${USAGE}`);
  const jobs = jobsOf(args);
  const { root, store } = await open(ctx, deps);
  const config = withBudget(await store.readConfig(), budgetOf(args));
  const budget = config.budgetUsdPerRun;
  const promises = await store.readPromises();
  let rules = await store.readRules();
  const cache = deps.infeasible ?? fileInfeasible;
  const known = await cache.read(store.dir);
  let targets: PromiseRecord[];
  /** Promises --all does not ask again: the model judged them infeasible last time (name one to ask again). */
  let skipped: string[] = [];
  if (all) {
    const open = promises
      .filter((p) => p.status === 'accepted' && p.checkable === 'code')
      .filter((p) => !rules.some((r) => r.promiseId === p.id && r.status === 'accepted'))
      .sort(byId);
    skipped = open.filter((p) => known.includes(p.id)).map((p) => p.id);
    targets = open.filter((p) => !known.includes(p.id));
  } else {
    // R4-FIX: several ids, comma separated (the budget-stop hint names the ones left).
    // HZ-1: a short id from the screen (doc.16) names the same promise as its full id.
    const known = shortIdsFor(promises);
    const ids = [...new Set((args.target as string).split(',').map((x) => x.trim()).filter((x) => x !== '').map((x) => known.full(x) ?? x))];
    targets = ids.map((id) => {
      const p = promises.find((x) => x.id === id);
      if (!p) throw new JuratorError('NOT_FOUND', `there is no promise ${id}. Run ${BRAND.command} promises to see the ids.`);
      if (p.checkable !== 'code') throw new JuratorError('BAD_INPUT', `${p.id} is a ${p.checkable} promise; rules only check code promises.`);
      return p;
    });
  }
  const json = args.flags.has('json');
  const skippedLine = (): string =>
    ctx.style.dim(`Not asked again: ${skipped.join(', ')} (the model found no rule last time; they stay on AI reads; name one to ask again)`);
  if (targets.length === 0) {
    if (json) ctx.out(JSON.stringify({ results: [], skipped }, null, 2));
    else if (skipped.length > 0) {
      ctx.out(skippedLine());
      ctx.out(`Next: ${BRAND.command} check`);
    } else {
      ctx.out('Every accepted code promise already has an accepted rule.');
      ctx.out(`Next: ${BRAND.command} rule test`);
    }
    return 0;
  }
  const repo = await deps.openRepo(root);
  const head = await repo.resolve(args.values.at ?? 'HEAD');
  const scripted = args.values.scripted;
  const nice = !json && fancy(ctx);
  // R4-UI2: one live row per promise (writing -> proving -> result), cost against the budget; quiet off a terminal.
  const live = liveFor(ctx, { title: 'rule propose', unit: 'rules', total: targets.length, budgetUsd: budget, words: { done: 'done', failed: 'no rule', skipped: 'not asked' } });
  for (const p of targets) live.add(p.id, p.id);
  const stageOf = (task: string): { id: string; stage: string } | null => {
    const m = /^(rule-propose|rule-repair|redteam(?:-judge)?)[^:]*:(.+?)(?::\d+)?$/u.exec(task);
    if (!m) return null;
    const rest = m[2] as string;
    const id = rest.startsWith('R-') ? rest.replace(/^R-(.+)-\d+$/u, '$1') : rest;
    return { id, stage: m[1] as string };
  };
  const hooks = (redteam: boolean) => ({
    onStart: (task: string) => {
      const s = stageOf(task);
      if (!s) return;
      const id = redteam ? `red:${s.id}` : s.id;
      const what = s.stage === 'rule-propose' ? 'writing the rule' : s.stage === 'rule-repair' ? 'repairing the rule' : s.stage === 'redteam' ? 'red team: looking for an evasion' : 'red team: judging an edit';
      if (live.snapshot().steps.some((x) => x.id === id && x.state === 'running')) live.detail(id, `${what} (again)`);
      else live.start(id, what);
    },
    onEnd: (task: string, usd: number) => {
      live.addCost(usd);
      const s = stageOf(task);
      if (s && s.stage === 'rule-propose') live.detail(s.id, "proving: runs on today's code, then on a broken copy");
    },
  });
  const model = trackModel(deps.createModel({ config, env: ctx.env, ...(scripted ? { scriptedDir: resolve(ctx.cwd, scripted) } : {}) }), hooks(false));
  const fileCache = new Map<string, string>();
  const loadFiles = (globs: readonly string[]): Promise<SourceFile[]> => loadRuleFiles(repo, head, globs, fileCache);
  const accept = args.flags.has('accept');
  const width = Math.min(jobs, targets.length);
  const n = targets.length;
  if (nice) {
    const ui = screenUi(ctx);
    // HZ-1 (backlog 17): each repo's branch @ commit, not a workspace's composite commit.
    const snapshot = typeof repo.snapshot === 'function' ? await repo.snapshot().catch(() => null) : null;
    print(ctx, ui.header({
      command: 'rule propose',
      workspace: workspaceLabel(root, config),
      model: modelLabel(model),
      budgetUsd: budget,
      facts: [...repoFacts(snapshot, head), ['promises', `${n}${width > 1 ? `, ${width} at a time` : ''}`]],
    }));
  } else if (!json) {
    const what = n === 1 ? (targets[0] as PromiseRecord).id : `${n} promises`;
    const by = model.mode === 'live' ? `${model.id} (live)` : 'scripted answers (no network)'; // live only when live
    ctx.out(`Writing rules for ${what} at ${short(head)} with ${by}${width > 1 ? `, ${width} at a time` : ''}`);
  }
  // Live answers take seconds each: print a progress line as each one comes back (finish order). The results below
  // are always printed in promise order, so the output is stable.
  const progress = !json && model.mode === 'live' && n > 1;
  const existing = rules;
  // The live view is always stopped (cursor restored) when a model call throws.
  const guard = async <T,>(f: () => Promise<T>): Promise<T> => {
    try {
      return await f();
    } catch (error) {
      live.finish({ ok: false, summary: 'stopped by an error' });
      throw error;
    }
  };
  const outcomes = await guard(() => mapPool(
    targets,
    width,
    async (p) => {
      const t0 = ctx.now().getTime();
      const promptFiles = await loadFiles([...new Set([...p.scope, ...config.codeScope])]);
      const res = await proposeRule(p, promptFiles, head, model, ctx.now(), { existing, loadFiles, codeScope: config.codeScope });
      return { p, res, seconds: Math.max(0, Math.round((ctx.now().getTime() - t0) / 1000)) };
    },
    (o, _p, _i, done) => {
      if (o.res.ok) {
        if (o.res.brokenNow) live.done(o.p.id, 'BROKEN NOW: rule written, today\'s code breaks it');
        else live.done(o.p.id, 'rule written');
      } else if (o.res.budgetStopped) live.skip(o.p.id, 'budget reached');
      else live.fail(o.p.id, o.res.infeasible ? 'no rule possible' : 'no rule this time');
      if (!progress || live.mode === 'live') return;
      const what = o.res.ok
        ? o.res.brokenNow
          ? 'BROKEN NOW (rule written)'
          : 'rule written'
        : o.res.budgetStopped
          ? 'not asked (budget reached)'
          : o.res.infeasible
            ? 'no rule possible'
            : 'no rule this time';
      ctx.out(ctx.style.dim(`  [${done}/${n}] ${nice ? shortIdsFor(promises).short(o.p.id) : o.p.id} ${what} (${o.seconds}s)`));
    },
  ));
  // --redteam: a second model (Muse Spark) tries to break each new rule's promise while the rule still passes; the
  // program applies each edit in memory and re-runs the rule (no AI); Muse Wonder judges the edits the rule missed.
  // The report is advice for the reviewer: it never accepts or rejects a rule (the program decides, not a model).
  // FU-1: when the judge confirms an evasion, the writer repairs the rule from it and the program re-proves the repair
  // (old breaks, every evasion, harmless variants); each proven repair is attacked again; up to 2 rounds; the best
  // proven rule is the one saved. Repairs and re-attacks stop at the --budget spend cap.
  const redteams = new Map<string, HardenReport>();
  let summaryUsd = 0;
  if (args.flags.has('redteam')) {
    // A rule that fails on today's code (BROKEN NOW) is not attacked: red-team edits start from code that keeps the promise.
    const written = outcomes.flatMap((o) => (o.res.ok && !o.res.brokenNow ? [{ p: o.p, rule: o.res.rule, examples: o.res.examples }] : []));
    let spent = outcomes.reduce((sum, o) => sum + (o.res.usage?.usd ?? 0), 0);
    if (written.length > 0) {
      const modelFor = (id: string): ModelClient =>
        deps.createModel({
          config: { ...config, model: { ...config.model, id } },
          // env MODEL_ID would override the config, so each role sets its own.
          env: { ...ctx.env, MODEL_ID: id },
          ...(scripted ? { scriptedDir: resolve(ctx.cwd, scripted) } : {}),
        });
      const attacker = trackModel(modelFor(REDTEAM_ATTACKER_MODEL), hooks(true));
      const judge = trackModel(modelFor(REDTEAM_JUDGE_MODEL), hooks(true));
      for (const w of written) live.add(`red:${w.p.id}`, `${w.p.id} red team`);
      if (!json && !nice) {
        const how = attacker.mode === 'live' ? `${attacker.id} attacks, ${judge.id} judges (live)` : 'scripted answers (no network)';
        ctx.out(`Red team for ${written.length} rule${written.length === 1 ? '' : 's'}: ${how}`);
      }
      const reports = await guard(() => mapPool(written, width, async ({ p, rule, examples }) => {
        const scope = p.scope.length > 0 ? p.scope : config.codeScope;
        const attackFiles = async (r: Rule): Promise<SourceFile[]> =>
          filesForRedteam(r, p, await loadFiles([...new Set([...r.globs, ...scope])]), config.codeScope);
        const promptFiles = await loadFiles([...new Set([...p.scope, ...config.codeScope])]);
        return hardenRule(rule, p, {
          attacker,
          judge,
          writer: model,
          attackFiles,
          promptFiles,
          commit: head,
          now: ctx.now(),
          propose: { existing, loadFiles },
          ...(examples ? { examples } : {}),
          mayContinue: () => spent < budget,
          onUsage: (u) => {
            spent += u.usd;
          },
        }).then((r) => {
          live.done(`red:${p.id}`, r.verdict === 'closed' ? 'evasions closed' : r.verdict === 'still-evadable' ? 'still evadable' : r.redteam.verdict);
          return r;
        });
      }));
      for (const r of reports) redteams.set(r.promiseId, r);
    }
  }
  // HZ-1: plain summaries of the findings (BROKEN NOW, no rule), written by Muse Spark from the program's evidence
  // (cached by content; a template with --no-ai-summary, no key or no budget left). Only for the screen.
  const ids = shortIdsFor(promises);
  const findings = new Map<string, Finding>();
  const summaries = new Map<string, Summary>();
  if (nice) {
    const byId = new Map(promises.map((p) => [p.id, p]));
    for (const { p, res } of outcomes) {
      const promise = byId.get(p.id) ?? p;
      if (res.ok && res.brokenNow) findings.set(p.id, fromBrokenNow(promise, redteams.get(p.id)?.rule ?? res.rule, res.brokenNow));
      else if (!res.ok && !res.budgetStopped) findings.set(p.id, fromNoRule(promise, res.reason, res.infeasible === true));
    }
    if (findings.size > 0) {
      const spent = outcomes.reduce((sum, o) => sum + (o.res.usage?.usd ?? 0), 0) + [...redteams.values()].reduce((sum, r) => sum + r.usage.reduce((a, u) => a + u.usd, 0), 0);
      const sm = summaryModel({ config, env: ctx.env, argv: ctx.argv, scriptedDir: scripted ? resolve(ctx.cwd, scripted) : undefined, budgetLeftUsd: budget - spent, create: deps.createModel });
      live.add('summaries', 'Plain summaries of the findings');
      live.start('summaries', sm.model?.mode === 'live' ? `${sm.model.id} writes them from the evidence` : 'from the evidence');
      let done = 0;
      const got = await summarizeAll([...findings.values()], {
        model: sm.model,
        cache: fileSummaryCache(store.dir),
        offReason: sm.offReason,
        idFor: (id) => ids.short(id),
        onDone: (_f, s) => {
          done += 1;
          live.addCost(s.usd);
          live.detail('summaries', `${done} of ${findings.size}`);
        },
      });
      for (const [k, v] of got) summaries.set(k, v);
      summaryUsd = [...got.values()].reduce((a, s) => a + s.usd, 0);
      const byAi = [...got.values()].filter((s) => s.by === 'ai').length;
      live.done('summaries', byAi > 0 ? `${byAi} by AI, ${got.size - byAi} by the program` : 'by the program');
    }
  }
  // "No rule possible" is an answer, not a failure of the run.
  live.finish({ keep: 'none', ok: true });
  const byPromiseId = new Map(promises.map((x) => [x.id, x] as const));
  const results: Array<Record<string, unknown>> = [];
  let usd = summaryUsd;
  let written = 0;
  let found = 0;
  let closed = 0;
  const evadable: string[] = [];
  const limitedWarnings: string[] = [];
  const assuranceBy = new Map<string, { coverage: 'limited-detector'; openCounterexamples: number; warning: string }>();
  const retry: string[] = [];
  const brokenNow: Array<{ id: string; at: string | null }> = [];
  const notAsked: string[] = [];
  for (const { p, res } of outcomes) {
    usd += res.usage?.usd ?? 0;
    if (res.ok) {
      const red = redteams.get(p.id);
      // The red team's best proven rule (a repair) replaces the rule as first written.
      const best = red?.rule ?? res.rule;
      const rule: Rule = accept ? { ...best, status: 'accepted' } : best;
      // A new proposal replaces older proposals for the same promise; accepted rules stay.
      rules = [...rules.filter((r) => !(r.promiseId === p.id && r.status === 'proposed')), rule].sort(byId);
      written += 1;
      for (const u of red?.usage ?? []) usd += u.usd;
      if (red) {
        found += red.closed.length + red.open.length;
        closed += red.closed.length;
        if (red.verdict === 'still-evadable') evadable.push(rule.id);
        if (red.open.length > 0) {
          const shapes = red.open.slice(0, 5).map((e) => `${e.edit.path}: ${e.why}`);
          const warning =
            `${rule.id} is a limited detector: it still misses ${red.open.length} known shape${red.open.length === 1 ? '' : 's'} ` +
            `(${shapes.join('; ')}${red.open.length > 5 ? '; ...' : ''}). A HOLDS from it is not an unqualified pass.`;
          assuranceBy.set(p.id, { coverage: 'limited-detector', openCounterexamples: red.open.length, warning });
          if (accept) limitedWarnings.push(`Accepted with open evasions: ${warning}`);
        }
      }
      const broken = res.brokenNow;
      if (broken) {
        const first = broken.evidence[0];
        brokenNow.push({ id: p.id, at: first ? `${first.path}:${first.line}` : null });
      }
      results.push({
        promiseId: p.id,
        ok: true,
        rule,
        ...(broken ? { brokenNow: broken } : {}),
        ...(red ? { redteam: red.redteam, hardening: hardeningJson(red) } : {}),
        ...(assuranceBy.has(p.id) ? { assurance: assuranceBy.get(p.id) } : {}),
      });
      if (!json && !nice) {
        const repaired = red?.repaired ? ', repaired after the red team' : '';
        if (broken) {
          // R4-FIX: a finding, not a failure: the rule is kept and today's code breaks the promise.
          ctx.out(`${ctx.style.red('✗')} ${p.id}  ${ctx.style.red('BROKEN NOW')}  ${rule.id} ${accept ? 'written and accepted' : 'written'} (${rule.mode}): ${rule.description}`);
          for (const e of broken.evidence.slice(0, 5)) ctx.out(`    ${describeEvidence(e)}`);
          if (broken.evidence.length > 5) ctx.out(ctx.style.dim(`    ... ${broken.evidence.length - 5} more`));
          if (broken.evidence.length === 0) ctx.out(`    ${broken.message}`);
          ctx.out(`    ${ctx.style.dim(`fixed copy: ${broken.fix}`)}`);
        } else {
          ctx.out(`${ctx.style.green('✓')} ${p.id}  ${rule.id} ${accept ? 'written and accepted' : 'written'} (${rule.mode}${repaired}): ${rule.description}`);
          ctx.out(`    ${ctx.style.dim(`proof: ${rule.provenBy?.mutation ?? ''}`)}`);
        }
        if (red) printHarden(ctx, red);
      }
    } else if (res.budgetStopped) {
      notAsked.push(p.id);
      results.push({ promiseId: p.id, ok: false, reason: res.reason, budgetStopped: true });
    } else {
      const infeasible = res.infeasible === true;
      if (!infeasible) retry.push(p.id);
      results.push({ promiseId: p.id, ok: false, reason: res.reason, ...(infeasible ? { infeasible: true } : {}) });
      if (!json && !nice) {
        const tail = mentionsAiReads(res.reason) ? '' : ' (it stays on AI reads)';
        ctx.out(`${ctx.style.yellow('–')} ${p.id}  ${infeasible ? 'no rule possible' : 'no rule this time'}: ${res.reason}${tail}`);
      }
    }
  }
  if (written > 0) await store.writeRules(rules);
  if (redteams.size > 0) {
    // FU-1: confirmed evasions stay with the rule as extra mutants that `rule test` re-runs.
    const mutants = deps.mutants ?? fileMutants;
    const nextFile = nextMutants(await mutants.read(store.dir), [...redteams.values()], head, rules);
    await mutants.write(store.dir, nextFile);
    // The portable, committed copy: the same evasions as an assessment bundle per red-teamed rule.
    for (const r of redteams.values()) {
      const kept = rules.find((x) => x.id === r.rule.id);
      const pr = byPromiseId.get(r.promiseId);
      if (!kept || !pr) continue;
      await saveAssessment(store.dir, repo, {
        rule: kept,
        promise: pr,
        commit: head,
        mutants: nextFile.rules[kept.id]?.evasions ?? [],
        adjudication: { by: 'model', model: REDTEAM_JUDGE_MODEL, at: ctx.now().toISOString(), independent: false },
        createdAt: ctx.now().toISOString(),
      });
    }
  }
  if (accept && written > 0) await recordRuleBindings({ store, repo, commit: head, promises, rules }); // WP-B: where each promise lives
  // Remember what the model judged infeasible (so hints stop suggesting it); a promise that now has a rule leaves.
  const judged = outcomes.filter((o) => !o.res.ok && o.res.infeasible).map((o) => o.p.id);
  const covered = outcomes.filter((o) => o.res.ok).map((o) => o.p.id);
  const after = nextInfeasible(known, judged, covered);
  if (after.join('\n') !== known.join('\n')) await cache.write(store.dir, after);
  // AC-A: save why each promise got no rule (a program rejection or the model's own judgement); not-asked ones stay.
  const noRule = deps.noRule ?? fileNoRule;
  const at = ctx.now().toISOString();
  const reasons = Object.fromEntries(
    outcomes
      .filter((o) => !o.res.ok && !o.res.budgetStopped)
      .map((o) => [o.p.id, { reason: o.res.ok ? '' : o.res.reason, infeasible: !o.res.ok && o.res.infeasible === true, commit: head, at }]),
  );
  if (Object.keys(reasons).length > 0 || covered.length > 0) {
    const savedNoRule = await noRule.read(store.dir);
    const nextSaved = nextNoRule(savedNoRule, reasons, covered);
    if (JSON.stringify(nextSaved) !== JSON.stringify(savedNoRule)) await noRule.write(store.dir, nextSaved);
  }
  // R4-FIX: when the budget stopped the run, how much more is needed and the exact command to continue.
  const stop =
    notAsked.length > 0
      ? {
          spentUsd: usd,
          budgetUsd: budget,
          done: n - notAsked.length,
          left: notAsked.length,
          unit: 'promise',
          command: accept && all ? `${BRAND.command} rule propose --all --accept` : `${BRAND.command} rule propose ${notAsked.join(',')}${accept ? ' --accept' : ''}`,
        }
      : null;
  if (json) {
    ctx.out(
      JSON.stringify(
        {
          commit: head,
          model: { id: model.id, mode: model.mode },
          costUsd: usd,
          budgetUsd: budget,
          results,
          skipped,
          brokenNow: brokenNow.map((b) => b.id),
          ...(stop ? { budgetStopped: { notAsked, lines: budgetStopLines(stop) } } : {}),
        },
        null,
        2,
      ),
    );
    return 0;
  }
  for (const w of limitedWarnings) ctx.out(ctx.style.yellow(w));
  const nextHint = (): string | null => {
    if (stop) return null; // the continue command is the next step
    if (written > 0 && !accept) return `review ${BRAND.folder}/rules.json, then ${BRAND.command} rule accept --all`;
    if (brokenNow.length > 0) return `fix the code at ${brokenNow.find((b) => b.at)?.at ?? 'the lines above'}, then ${BRAND.command} check`;
    if (written > 0) return `${BRAND.command} rule test, then commit ${BRAND.folder}/rules.json`;
    if (retry.length > 0) return `${BRAND.command} rule propose ${ids.short(retry[0] as string)} to try again`;
    return `${BRAND.command} check`;
  };
  if (nice) {
    const ui = screenUi(ctx);
    const byPromise = new Map(promises.map((p) => [p.id, p]));
    const sources = Object.fromEntries(config.sources.map((x) => [x.alias, x.locator] as const));
    print(ctx, proposeScreen(ui, { outcomes, redteams, accept, usd, budget, written, n, brokenNow: brokenNow.map((b) => b.id), byPromise, ids, summaries, findings, sources }));
    if (stop) {
      ctx.out('');
      for (const line of budgetStopLines(stop)) ctx.out(ui.line(line, 'accent'));
    }
    if (skipped.length > 0) print(ctx, ui.hint(`Not asked again: ${skipped.join(', ')} (no rule last time; they stay on AI reads; name one to ask again)`));
    if (evadable.length > 0) print(ctx, ui.hint(`Still evadable: ${evadable.join(', ')}. A HOLDS from such a rule does not cover the open edit: review it.`));
    if (stop) print(ctx, ui.next(stop.command + (stop.left > 0 ? ` --budget ${Math.max(1, Math.ceil(budget * 2))}` : '')));
    else print(ctx, ui.next(nextHint() ?? `${BRAND.command} check`));
    return 0;
  }
  ctx.out(`${written} of ${n} written${brokenNow.length > 0 ? ` · ${brokenNow.length} broken now` : ''} · cost $${usd.toFixed(4)}`);
  if (brokenNow.length > 0) {
    ctx.out(
      ctx.style.red(
        `Broken now: ${brokenNow.map((b) => b.id).join(', ')}. Today's code breaks ${brokenNow.length === 1 ? 'this promise' : 'these promises'}; ` +
          `the rule${brokenNow.length === 1 ? '' : 's'} above will report BROKEN in ${BRAND.command} check until the code is fixed.`,
      ),
    );
  }
  if (stop) for (const line of budgetStopLines(stop)) ctx.out(ctx.style.yellow(line));
  if (skipped.length > 0) ctx.out(skippedLine());
  if (redteams.size > 0) {
    const ev = (k: number): string => `${k} evasion${k === 1 ? '' : 's'}`;
    const line = `Red team: ${ev(found)} confirmed on ${redteams.size} rule${redteams.size === 1 ? '' : 's'}, ${closed} closed by repair, ${found - closed} still open`;
    ctx.out(found > closed ? ctx.style.yellow(line) : line);
    if (evadable.length > 0) {
      ctx.out(
        ctx.style.yellow(
          `Still evadable: ${evadable.join(', ')}. A HOLDS from such a rule does not cover the open edit above: review it, ` +
            `or run ${BRAND.command} rule propose <promise-id> --redteam again.`,
        ),
      );
    }
    if (found > 0) ctx.out(ctx.style.dim(`Evasions kept as extra mutants in ${BRAND.folder}/local/rule-mutants.json (re-run by ${BRAND.command} rule test)`));
  }
  if (stop) return 0; // the continue command above is the next step
  if (written > 0 && !accept) ctx.out(`Next: review ${BRAND.folder}/rules.json, then ${BRAND.command} rule accept --all`);
  else if (brokenNow.length > 0) ctx.out(`Next: fix the code at ${brokenNow.find((b) => b.at)?.at ?? 'the lines above'}, then ${BRAND.command} check`);
  else if (written > 0) ctx.out(`Next: ${BRAND.command} rule test, then commit ${BRAND.folder}/rules.json`);
  else if (retry.length > 0) ctx.out(`Next: ${BRAND.command} rule propose ${retry[0]} to try again`);
  else ctx.out(`Next: ${BRAND.command} check`);
  return 0;
}

async function test(ctx: CommandContext, deps: RuleCommandDeps, args: Args): Promise<number> {
  const { root, store } = await open(ctx, deps);
  const rules = await store.readRules();
  const selected = args.target ? rules.filter((r) => r.id === args.target) : rules.filter((r) => r.status === 'accepted').sort(byId);
  if (args.target && selected.length === 0) throw new JuratorError('NOT_FOUND', `there is no rule ${args.target}. Run ${BRAND.command} rule list.`);
  const json = args.flags.has('json');
  if (selected.length === 0) {
    if (json) ctx.out(JSON.stringify({ results: [] }, null, 2));
    else {
      ctx.out('No accepted rules yet.');
      ctx.out(`Next: ${BRAND.command} rule propose --all`);
    }
    return 0;
  }
  const repo = await deps.openRepo(root);
  const ref = args.values.at ?? 'HEAD';
  const commit = await repo.resolve(ref);
  const cache = new Map<string, string>();
  const results: RuleRunResult[] = [];
  // Same as check: a value rule knows its promise's number, so `30 * 3` is read as 90.
  const promises = new Map((await store.readPromises()).map((p) => [p.id, p]));
  // FU-1: the red-team evasions stored with each rule are re-run as extra mutants (the edit applied in memory).
  const stored = await (deps.mutants ?? fileMutants).read(store.dir);
  const mutants = new Map<string, MutantResult[]>();
  for (const rule of selected) {
    const promise = promises.get(rule.promiseId);
    const constraint = promise ? numericConstraint(promise) : null;
    const res = runRule(rule, await loadRuleFiles(repo, commit, rule.globs, cache), commit, { constraint });
    results.push(res);
    const bundle = await readBundle(store.dir, rule.id);
    // A trusted bundle wins; else the legacy local file (still read, never deleted).
    const evasions = bundle && verifyBundle(bundle).ok ? [...bundle.mutants] : (stored.rules[rule.id]?.evasions ?? []);
    // Only on code where the rule passes: on a broken commit the promise is already reported broken.
    if (evasions.length > 0 && res.outcome === 'pass') {
      mutants.set(rule.id, await testMutants(rule, promise, evasions, commit, (g) => loadRuleFiles(repo, commit, g, cache)));
    }
    // Persist the portable bundle (imports the legacy file when no bundle exists); unchanged bundles are left alone.
    if (promise && res.outcome === 'pass' && (evasions.length > 0 || bundle)) {
      const good = bundle && verifyBundle(bundle).ok ? bundle : null;
      await saveAssessment(store.dir, repo, {
        rule,
        promise,
        commit,
        mutants: evasions,
        ...(good ? { adjudication: good.adjudication, harmlessControls: good.harmlessControls } : {}),
        createdAt: ctx.now().toISOString(),
      });
    }
  }
  const count = (o: RuleRunResult['outcome']): number => results.filter((r) => r.outcome === o).length;
  const allMutants = [...mutants.values()].flat();
  const missed = allMutants.filter((m) => m.outcome === 'missed');
  // A rule that passes a closed evasion again is weaker than it was proven to be: drift (exit 1), as AGENTS.md says.
  const code = count('fail') > 0 || missed.length > 0 ? 1 : count('error') > 0 ? 2 : 0;
  if (json) {
    ctx.out(JSON.stringify({ ref, commit, results, ...(allMutants.length > 0 ? { mutants: allMutants } : {}) }, null, 2));
    return code;
  }
  ctx.out(`Rules at ${ref} (${short(commit)}), no AI`);
  for (const res of results) {
    const mark =
      res.outcome === 'pass' ? ctx.style.green('✓ pass ') : res.outcome === 'fail' ? ctx.style.red('✗ FAIL ') : ctx.style.yellow('! error');
    ctx.out(`${mark} ${res.ruleId}  ${res.promiseId}  ${res.message}`);
    if (res.outcome === 'fail') printHits(ctx, res);
    const ms = mutants.get(res.ruleId) ?? [];
    if (ms.length > 0) printMutants(ctx, ms);
  }
  ctx.out(`${results.length} rules: ${count('pass')} pass, ${count('fail')} fail, ${count('error')} error`);
  if (allMutants.length > 0) {
    const caught = allMutants.filter((m) => m.outcome === 'caught' || m.outcome === 'now-caught').length;
    const line = `Known red-team evasions: ${caught} of ${allMutants.length} caught`;
    ctx.out(missed.length > 0 ? ctx.style.red(line) : line);
    if (missed.length > 0) {
      ctx.out(`Next: ${missed[0]!.ruleId} passes an evasion it was proven to catch; check ${BRAND.folder}/rules.json, or run ${BRAND.command} rule propose <promise-id> --redteam`);
      return code;
    }
  }
  if (code === 1) ctx.out(`Next: fix the lines above (the promise is broken), then ${BRAND.command} rule test again`);
  return code;
}

async function list(ctx: CommandContext, deps: RuleCommandDeps, args: Args): Promise<number> {
  const { store } = await open(ctx, deps);
  const rules = [...(await store.readRules())].sort(byId);
  const promises = await store.readPromises();
  const cov = ruleCoverage(promises, rules);
  const known = await (deps.infeasible ?? fileInfeasible).read(store.dir);
  const noRule = cov.uncovered.filter((id) => known.includes(id));
  const askable = cov.uncovered.filter((id) => !known.includes(id));
  if (args.flags.has('json')) {
    ctx.out(JSON.stringify({ rules, coverage: cov, infeasible: noRule }, null, 2));
    return 0;
  }
  if (rules.length === 0) ctx.out('No rules yet.');
  for (const r of rules) {
    const status = r.status === 'accepted' ? ctx.style.green('accepted') : ctx.style.yellow('proposed');
    const proven = r.provenBy?.failedAsExpected ? 'proven able to fail' : ctx.style.red('not proven');
    ctx.out(`${r.id}  ${r.promiseId}  ${status}  ${r.mode}  ${proven}`);
    ctx.out(`    ${r.description}  ${ctx.style.dim(`[${r.globs.join(', ')}]`)}`);
  }
  ctx.out(`${cov.covered} of ${cov.codePromises} code promises covered by rules`);
  if (askable.length > 0) ctx.out(ctx.style.dim(`On AI reads only: ${askable.join(', ')}`));
  if (noRule.length > 0) ctx.out(ctx.style.dim(`On AI reads (the model found no rule): ${noRule.join(', ')}`));
  if (rules.some((r) => r.status === 'proposed')) ctx.out(`Next: ${BRAND.command} rule accept --all`);
  else if (askable.length > 0) ctx.out(`Next: ${BRAND.command} rule propose --all`);
  return 0;
}

async function accept(ctx: CommandContext, deps: RuleCommandDeps, args: Args): Promise<number> {
  const all = args.flags.has('all');
  if (!all && !args.target) throw new JuratorError('BAD_INPUT', `say which rule: ${BRAND.command} rule accept <rule-id> or --all\nUsage: ${USAGE}`);
  const { store } = await open(ctx, deps);
  const rules = await store.readRules();
  const proven = (r: Rule): boolean => r.provenBy?.failedAsExpected === true;
  let picked: Rule[];
  if (all) picked = rules.filter((r) => r.status === 'proposed');
  else {
    const r = rules.find((x) => x.id === args.target);
    if (!r) throw new JuratorError('NOT_FOUND', `there is no rule ${args.target}. Run ${BRAND.command} rule list.`);
    if (!proven(r)) {
      throw new JuratorError('NOT_PROVEN', `${r.id} was never shown able to fail, so it cannot be accepted. Run ${BRAND.command} rule propose ${r.promiseId} again.`);
    }
    if (r.status === 'accepted') {
      ctx.out(`${r.id} is already accepted.`);
      return 0;
    }
    picked = [r];
  }
  const ok = new Set(picked.filter(proven).map((r) => r.id));
  for (const r of picked.filter((x) => !proven(x))) ctx.out(`${ctx.style.yellow('–')} ${r.id} skipped: never shown able to fail`);
  if (ok.size === 0) {
    ctx.out('Nothing to accept.');
    return 0;
  }
  await store.writeRules(rules.map((r) => (ok.has(r.id) ? { ...r, status: 'accepted' as const } : r)).sort(byId));
  for (const id of [...ok].sort()) ctx.out(`${ctx.style.green('✓')} accepted ${id}`);
  ctx.out(`Next: ${BRAND.command} rule test, then commit ${BRAND.folder}/rules.json`);
  return 0;
}

/** The command body with injectable dependencies (tests); the CLI uses the real packages. */
export async function runRuleCommand(ctx: CommandContext, deps: RuleCommandDeps = defaultDeps): Promise<number> {
  const args = parseArgs(ctx.argv);
  switch (args.sub) {
    case 'propose':
      return propose(ctx, deps, args);
    case 'test':
      return test(ctx, deps, args);
    case 'list':
    case undefined:
      return list(ctx, deps, args);
    case 'accept':
      return accept(ctx, deps, args);
    default:
      ctx.err(`Unknown subcommand "${args.sub}".\nUsage: ${USAGE}`);
      return 2;
  }
}

const command: Command = {
  name: 'rule',
  summary: 'Write, test and list rules (the checks that run with no AI)',
  usage: USAGE,
  run: (ctx) => runRuleCommand(withVideo(ctx)), // --video / JURATOR_VIDEO=1: 100 columns, short paths and shas
};
export default command;
