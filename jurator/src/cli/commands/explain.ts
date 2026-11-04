// Owner: HZ-1. `jurator explain <id>`: everything about one promise in one place (backlog 14-15: the screens stay short,
// the details are here): the promise and its policy sentence, its rules (what each checks, the pattern, the proof, and
// what it says on the code now, run with no AI), its bindings, its last check result with every line cited, and the
// plain summary of the finding (AI-written from the program's evidence, or the program's template).
import { resolve } from 'node:path';
import type { Binding, CheckResult, CheckRun, Config, GitRepo, ModelClient, Rule, RuleRunResult, Store } from '../../contracts.js';
import { BRAND } from '../../brand.js';
import { describeExpected, excerpt, readBindings } from '../../bindings/index.js';
import {
  fileSummaryCache,
  findingRows,
  fromCheckResult,
  fromRuleRun,
  modeWords,
  quoted,
  repoFacts,
  ruleLine,
  shortIdsFor,
  summarize,
  summaryLabel,
  summaryModel,
  type Finding,
  type Summary,
} from '../../explain/index.js';
import { openRepo } from '../../git/index.js';
import { createModel } from '../../model/index.js';
import { parseBudget, withBudget } from '../../model/budget.js';
import { facetsLine } from '../../policy/facets.js';
import { policyWhere } from '../../render/index.js';
import { screenUi, workspaceLabel, modelLabel } from '../../render/screen.js';
import { loadRuleFiles, numericConstraint, readInfeasible, runRule } from '../../rules/index.js';
import type { BadgeKind, FindingRow } from '../../ui/index.js';
import { JuratorError } from '../../util/errors.js';
import { findRepoRoot, listRuns, openStore } from '../../workspace/index.js';
import type { Command, CommandContext } from '../context.js';

const USAGE = `${BRAND.command} explain <promise-id> [--at <ref>] [--no-ai] [--budget <usd>] [--scripted <dir>] [--json]`;

/** What the command needs from other packages; tests pass fakes. */
export interface ExplainDeps {
  findRepoRoot(cwd: string): Promise<string>;
  openStore(repoRoot: string): Store;
  openRepo(repoRoot: string): Promise<GitRepo>;
  createModel(options: { config: Config; env: NodeJS.ProcessEnv; scriptedDir?: string }): ModelClient;
  listRuns(store: Store): Promise<CheckRun[]>;
  readBindings(store: Pick<Store, 'dir'>): Promise<Binding[]>;
  readInfeasible(dir: string): Promise<string[]>;
}
const defaultDeps: ExplainDeps = { findRepoRoot, openStore, openRepo, createModel, listRuns, readBindings, readInfeasible };

interface Args {
  readonly id: string | undefined;
  readonly flags: ReadonlySet<string>;
  readonly values: Readonly<Record<string, string>>;
}
function parseArgs(argv: readonly string[]): Args {
  const positional: string[] = [];
  const flags = new Set<string>();
  const values: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i] as string;
    if (a === '--at' || a === '--budget' || a === '--scripted') {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) throw new JuratorError('BAD_INPUT', `${a} needs a value`);
      values[a.slice(2)] = v;
      i += 1;
    } else if (a.startsWith('--')) flags.add(a.slice(2));
    else positional.push(a);
  }
  return { id: positional[0], flags, values };
}

const short = (sha: string): string => sha.slice(0, 7);
const first = (s: string): string => (s.split('\n').find((l) => l.trim() !== '') ?? '').trim();
const lines = (a: number, b: number): string => (a === b ? `${a}` : `${a}-${b}`);

interface RuleNow {
  readonly rule: Rule;
  readonly now: RuleRunResult | null;
  readonly error?: string;
}

export async function runExplainCommand(ctx: CommandContext, deps: ExplainDeps = defaultDeps): Promise<number> {
  const args = parseArgs(ctx.argv);
  if (!args.id) throw new JuratorError('BAD_INPUT', `say which promise: ${BRAND.command} explain <promise-id>\nUsage: ${USAGE}`);
  const root = await deps.findRepoRoot(ctx.cwd);
  const store = deps.openStore(root);
  if (!(await store.exists())) throw new JuratorError('NO_WORKSPACE', `there is no ${BRAND.folder}/ folder here. Run ${BRAND.command} init first.`);
  const config = withBudget(await store.readConfig(), parseBudget(args.values.budget));
  const promises = await store.readPromises();
  const ids = shortIdsFor(promises);
  const fullId = ids.full(args.id) ?? args.id;
  const promise = promises.find((p) => p.id === fullId);
  if (!promise) throw new JuratorError('NOT_FOUND', `there is no promise ${args.id}. Run ${BRAND.command} promises to see the ids.`);
  const sid = ids.short(promise.id);

  // The rules, run now with no AI.
  const rules = (await store.readRules()).filter((r) => r.promiseId === promise.id).sort((a, b) => (a.status === b.status ? a.id.localeCompare(b.id) : a.status === 'accepted' ? -1 : 1));
  let repo: GitRepo | null = null;
  let head: string | null = null;
  try {
    repo = await deps.openRepo(root);
    head = await repo.resolve(args.values.at ?? 'HEAD');
  } catch {
    repo = null;
  }
  const snapshot = repo && typeof repo.snapshot === 'function' ? await repo.snapshot().catch(() => null) : null;
  const cache = new Map<string, string>();
  const constraint = numericConstraint(promise);
  const ruleNow: RuleNow[] = [];
  for (const rule of rules) {
    if (!repo || !head) {
      ruleNow.push({ rule, now: null, error: 'no git repository here' });
      continue;
    }
    try {
      ruleNow.push({ rule, now: runRule(rule, await loadRuleFiles(repo, head, rule.globs, cache), head, { constraint }) });
    } catch (error) {
      ruleNow.push({ rule, now: null, error: (error as Error).message });
    }
  }
  const bindings = (await deps.readBindings(store).catch(() => [] as Binding[])).filter((b) => b.promiseId === promise.id);
  const infeasible = (await deps.readInfeasible(store.dir).catch(() => [] as string[])).includes(promise.id);
  const runs = await deps.listRuns(store).catch(() => [] as CheckRun[]);
  let last: { run: CheckRun; result: CheckResult } | null = null;
  for (let i = runs.length - 1; i >= 0 && !last; i -= 1) {
    const run = runs[i] as CheckRun;
    const result = run.results.find((r) => r.promiseId === promise.id);
    if (result) last = { run, result };
  }

  // The finding to summarise: a rule that fails now, else the last check's AI hint.
  const failing = ruleNow.find((x) => x.now?.outcome === 'fail');
  let finding: Finding | null = null;
  if (failing?.now) finding = fromRuleRun(promise, failing.rule, failing.now);
  else if (last && (last.result.verdict === 'looks-broken' || last.result.verdict === 'cant-tell' || last.result.verdict === 'broken')) {
    finding = fromCheckResult(last.run, last.result, rules);
  }
  let summary: Summary | null = null;
  let model: ModelClient | null = null;
  if (finding) {
    const scripted = args.values.scripted;
    const sm = summaryModel({ config, env: ctx.env, argv: ctx.argv, scriptedDir: scripted ? resolve(ctx.cwd, scripted) : undefined, create: deps.createModel });
    model = sm.model;
    summary = await summarize(finding, { model: sm.model, cache: fileSummaryCache(store.dir), offReason: sm.offReason, idFor: (id) => ids.short(id) });
  }

  if (args.flags.has('json')) {
    ctx.out(
      JSON.stringify(
        {
          promise,
          shortId: sid,
          commit: head,
          rules: ruleNow.map((x) => ({ rule: x.rule, now: x.now, ...(x.error ? { error: x.error } : {}) })),
          bindings,
          infeasible,
          lastCheck: last ? { runId: last.run.id, createdAt: last.run.createdAt, commit: last.run.target.head, result: last.result } : null,
          finding,
          summary,
        },
        null,
        2,
      ),
    );
    return 0;
  }

  const ui = screenUi(ctx);
  const out: string[] = [];
  out.push(
    ...ui.header({
      command: `explain ${sid}`,
      workspace: workspaceLabel(root, config),
      model: model ? modelLabel(model) : undefined,
      facts: [...(repo && head ? repoFacts(snapshot, head) : []), ...(summary && summary.usd > 0 ? [['cost', `$${summary.usd.toFixed(4)}`] as [string, string]] : [])],
    }),
  );

  // The promise.
  out.push(...ui.section('Promise', sid === promise.id ? promise.status : `${promise.id} · ${promise.status}`));
  const about: FindingRow[] = [
    { label: 'Says', text: promise.wording, maxLines: 6 },
    { label: 'Policy', text: quoted(promise.quote.text), maxLines: 8 },
    { label: '', text: policyWhere(promise.quote, Object.fromEntries(config.sources.map((s) => [s.alias, s.locator] as const))), tone: 'muted' },
    { label: 'Kind', text: `${promise.kind} · checked in ${promise.checkable}${promise.checkable === 'code' ? '' : ' (no rule; it goes to the PR checklist or runtime)'}` },
    ...(promise.facets ? [{ label: 'Typed', text: facetsLine(promise.facets) }] : []),
    { label: 'Scope', text: promise.scope.length > 0 ? promise.scope.join(', ') : `the default code scope (${config.codeScope.join(', ')})`, maxLines: 3 },
  ];
  out.push(...ui.rows(about));

  // The finding, with every detail.
  if (finding && summary) {
    const kind: BadgeKind = finding.kind === 'broken' || finding.kind === 'broken-now' ? 'broken' : finding.kind === 'looks-broken' ? 'looks-broken' : 'cant-tell';
    const title = failing ? `rule ${failing.rule.id} fails at ${head ? short(head) : 'HEAD'}, no AI` : `last check ${last?.run.id ?? ''}`;
    out.push('');
    out.push(
      ...ui.finding({
        kind,
        id: sid,
        title,
        rows: findingRows({ finding, summary, id: sid, policyWhere: policyWhere(promise.quote, Object.fromEntries(config.sources.map((s) => [s.alias, s.locator] as const))), verbose: true }),
      }),
    );
  }

  // The rules.
  out.push(...ui.section('Rules', rules.length === 0 ? 'none' : `${rules.length}`));
  if (rules.length === 0) {
    out.push(
      ...ui.hint(
        infeasible
          ? '  The model found no rule for this promise (an earlier rule propose); each check reads it with AI.'
          : promise.checkable === 'code'
            ? `  No rule yet; each check reads it with AI. Write one: ${BRAND.command} rule propose ${sid}`
            : `  A ${promise.checkable} promise has no rule.`,
      ),
    );
  }
  for (const { rule, now, error } of ruleNow) {
    const rows: FindingRow[] = [
      { label: 'Rule', text: `${rule.id} · ${rule.status} · written by ${rule.author}` },
      { label: 'Checks', text: ruleLine(rule), maxLines: 4 },
      { label: 'How', text: `${rule.mode}: ${modeWords(rule.mode)}`, tone: 'muted', maxLines: 2 },
      { label: 'Pattern', text: `/${rule.pattern}/${rule.flags ?? ''}`, tone: 'code' },
      ...(rule.anchor ? [{ label: 'Anchor', text: `/${rule.anchor}/ within ${rule.within ?? 0} lines`, tone: 'code' as const }] : []),
      { label: 'Files', text: rule.globs.join(', '), maxLines: 3 },
      { label: 'Proof', text: rule.provenBy ? `${rule.provenBy.failedAsExpected ? 'proven able to fail' : 'NOT proven'}: ${rule.provenBy.mutation}` : 'never proven able to fail', tone: 'muted', maxLines: 6 },
    ];
    if (now) {
      const word = now.outcome === 'pass' ? ui.tone(`${ui.sym.done} passes`, 'kept') : now.outcome === 'fail' ? ui.tone(`${ui.sym.failed} FAILS`, 'broken') : ui.tone('! error', 'accent');
      rows.push({ label: 'Now', text: `${word} at ${head ? short(head) : 'HEAD'} (no AI): ${now.message}`, maxLines: 3 });
      for (const h of now.hits.slice(0, 20)) {
        rows.push({ label: '', text: `${h.path}:${lines(h.startLine, h.endLine)}`, tone: 'accent' });
        rows.push({ label: '', text: first(h.quote), tone: 'code', lineNo: h.startLine });
      }
      if (now.hits.length > 20) rows.push({ label: '', text: `+${now.hits.length - 20} more (--json lists them all)`, tone: 'muted' });
    } else if (error) rows.push({ label: 'Now', text: `not run: ${error}`, tone: 'muted' });
    out.push(...ui.rows(rows));
  }

  // The bindings.
  if (bindings.length > 0) {
    out.push(...ui.section('Bound to', `${bindings.length}`));
    const rows: FindingRow[] = bindings.flatMap((b) => [
      { label: b.kind, text: `${b.path}:${lines(b.startLine, b.endLine)} ${b.symbol ?? ''}${b.expected ? ` (expects ${describeExpected(b.expected)})` : ''}`.trim(), tone: 'accent' as const },
      { label: '', text: excerpt(b, 200), tone: 'code' as const, lineNo: b.startLine },
    ]);
    out.push(...ui.rows(rows));
  }

  // The last check.
  out.push(...ui.section('Last check', last ? `${last.run.id}` : 'none'));
  if (!last) out.push(...ui.hint(`  Not checked yet: ${BRAND.command} check`));
  else {
    const r = last.result;
    const rows: FindingRow[] = [
      { label: 'Result', text: `${ui.badge(r.verdict as BadgeKind, { long: true })} at ${short(last.run.target.head)}${last.run.target.kind === 'diff' ? ` vs ${last.run.target.base ?? '?'}` : ''} · ${last.run.createdAt.replace('T', ' ').slice(0, 16)}` },
      ...(r.trigger ? [{ label: 'Because', text: `the change ${r.trigger}`, maxLines: 2 }] : []),
      ...(r.explanation ? [{ label: r.level === 'ai-read' ? 'AI read' : 'Rule', text: r.explanation, maxLines: 6 }] : []),
      ...(r.reason ? [{ label: 'Note', text: r.reason, maxLines: 4 }] : []),
      ...(r.reused ? [{ label: '', text: `(reused from ${r.reused.fromRun})`, tone: 'muted' as const }] : []),
    ];
    for (const c of r.citations) {
      rows.push({ label: rows.some((x) => x.label === 'Cited') ? '' : 'Cited', text: `${c.path}:${lines(c.startLine, c.endLine)} @ ${short(c.commit)}`, tone: 'accent' });
      c.quote.split('\n').slice(0, 6).forEach((l, i) => {
        if (l.trim()) rows.push({ label: '', text: l, tone: 'code', lineNo: c.startLine + i });
      });
    }
    out.push(...ui.rows(rows));
  }

  const next =
    failing
      ? `fix the code at ${failing.now?.hits[0] ? `${failing.now.hits[0].path}:${failing.now.hits[0].startLine}` : 'the lines above'}, then ${BRAND.command} check`
      : rules.length === 0 && promise.checkable === 'code' && !infeasible
        ? `${BRAND.command} rule propose ${sid}`
        : !last
          ? `${BRAND.command} check`
          : last.result.verdict === 'looks-broken' || last.result.verdict === 'cant-tell'
            ? `look at the lines cited, or ${BRAND.command} rule propose ${sid} for a firm answer`
            : `${BRAND.command} check --diff main on your next change`;
  if (summary) out.push('', ...ui.hint(`  Box summary: ${summaryLabel(summary)}. Everything else is copied from git and ${BRAND.folder}/.`));
  out.push(...ui.next(next));
  for (const l of out) ctx.out(l);
  return 0;
}

const command: Command = {
  name: 'explain',
  summary: 'Everything about one promise: its rule, the evidence, the last check, a plain summary',
  usage: USAGE,
  run: (ctx) => runExplainCommand(ctx),
};
export default command;
