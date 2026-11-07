// Owner: WP-B. `jurator bind`: record where in the code each promise lives, so a change to those lines triggers it.
import { resolve } from 'node:path';
import type { Binding, Config, GitRepo, ModelClient, PromiseRecord, Store } from '../../contracts.js';
import { BRAND } from '../../brand.js';
import { scanArgs } from '../loose-args.js';
import {
  anchorAll,
  bindingsFromRules,
  describeExpected,
  excerpt,
  mergeBindings,
  proposeBindings,
  readBindings,
  writeBindings,
  type DroppedLocation,
} from '../../bindings/index.js';
import { openRepo } from '../../git/index.js';
import { createModel } from '../../model/index.js';
import { budgetStopLines, isBudgetStop, parseBudget, withBudget } from '../../model/budget.js';
import { fancy, liveFor, modelLabel, print, screenUi, trackModel, workspaceLabel } from '../../render/screen.js';
import { acceptedRulesFor, DEFAULT_CONCURRENCY, loadRuleFiles, mapPool } from '../../rules/index.js';
import { JuratorError } from '../../util/errors.js';
import { stableJson } from '../../util/json.js';
import { compareIds, findRepoRoot, openStore } from '../../workspace/index.js';
import type { Command, CommandContext } from '../context.js';
import { withVideo } from '../../render/video.js';
import { repoFacts } from '../../explain/index.js';

/** What the command needs from other packages; tests pass fakes. */
export interface BindCommandDeps {
  findRepoRoot(cwd: string): Promise<string>;
  openStore(repoRoot: string): Store;
  openRepo(repoRoot: string): Promise<GitRepo>;
  createModel(options: { config: Config; env: NodeJS.ProcessEnv; scriptedDir?: string }): ModelClient;
}
const defaultDeps: BindCommandDeps = { findRepoRoot, openStore, openRepo, createModel };

const USAGE =
  `${BRAND.command} bind [<promise-id>|--all] [--at <ref>] [--no-model] [--budget <usd>] [--scripted <dir>] [--json]\n` +
  `       ${BRAND.command} bind list [--at <ref>] [--json]`;

interface Args {
  readonly positional: readonly string[];
  readonly flags: ReadonlySet<string>;
  readonly values: Readonly<Record<string, string>>;
}
function parseArgs(argv: readonly string[]): Args {
  const { positional, flags, values } = scanArgs(argv, ['--scripted', '--at', '--budget']);
  return { positional, flags, values };
}

const short = (sha: string): string => sha.slice(0, 7);
const lines = (b: Pick<Binding, 'startLine' | 'endLine'>): string => (b.startLine === b.endLine ? `${b.startLine}` : `${b.startLine}-${b.endLine}`);

/** "src/agent/chats.ts:2 CHAT_TTL_DAYS (expects <= 30 days)". */
export function describeBinding(b: Binding): string {
  const name = b.symbol ?? excerpt(b, 40);
  return `${b.path}:${lines(b)} ${name}${b.expected ? ` (expects ${describeExpected(b.expected)})` : ''}`;
}

async function open(ctx: CommandContext, deps: BindCommandDeps): Promise<{ root: string; store: Store }> {
  const root = await deps.findRepoRoot(ctx.cwd);
  const store = deps.openStore(root);
  if (!(await store.exists())) throw new JuratorError('NO_WORKSPACE', `there is no ${BRAND.folder}/ folder here. Run ${BRAND.command} init first.`);
  return { root, store };
}

interface Outcome {
  readonly promise: PromiseRecord;
  readonly from: 'rule' | 'model' | 'kept' | 'none' | 'skipped';
  readonly bindings: readonly Binding[];
  readonly dropped: readonly DroppedLocation[];
  readonly note?: string;
}

async function bind(ctx: CommandContext, deps: BindCommandDeps, args: Args): Promise<number> {
  const target = args.positional[0];
  const all = args.flags.has('all') || target === undefined;
  const json = args.flags.has('json');
  const budgetArg = parseBudget(args.values.budget);
  const { root, store } = await open(ctx, deps);
  const config = withBudget(await store.readConfig(), budgetArg);
  const promises = await store.readPromises();
  const rules = await store.readRules();
  const saved = await readBindings(store);
  let targets: PromiseRecord[];
  if (all) targets = promises.filter((p) => p.status === 'accepted' && p.checkable === 'code').sort((a, b) => compareIds(a.id, b.id));
  else {
    const p = promises.find((x) => x.id === target);
    if (!p) throw new JuratorError('NOT_FOUND', `there is no promise ${target}. Run ${BRAND.command} promises to see the ids.`);
    if (p.checkable !== 'code') throw new JuratorError('BAD_INPUT', `${p.id} is a ${p.checkable} promise; only code promises have places in the code.`);
    targets = [p];
  }
  if (targets.length === 0) {
    if (json) ctx.out(JSON.stringify({ bindings: [], results: [] }, null, 2));
    else {
      ctx.out('No accepted code promises yet.');
      ctx.out(`Next: ${BRAND.command} compile --accept`);
    }
    return 0;
  }
  const repo = await deps.openRepo(root);
  const head = await repo.resolve(args.values.at ?? 'HEAD');
  const cache = new Map<string, string>();
  const outcomes = new Map<string, Outcome>();

  // 1. Rules first (no AI): the lines that make each accepted rule pass are where the promise lives.
  for (const p of targets) {
    const own = acceptedRulesFor(p.id, rules);
    if (own.length === 0) continue;
    const files = await loadRuleFiles(repo, head, [...new Set(own.flatMap((r) => r.globs))], cache);
    const items = bindingsFromRules(p, own, files, head);
    if (items.length > 0) outcomes.set(p.id, { promise: p, from: 'rule', bindings: items, dropped: [] });
  }

  // 2. --all keeps a promise's earlier model or human bindings while they still anchor here (no new model call).
  let open2 = targets.filter((p) => !outcomes.has(p.id));
  if (all) {
    const still: PromiseRecord[] = [];
    for (const p of open2) {
      const mine = saved.filter((b) => b.promiseId === p.id && b.foundBy !== 'rule');
      const anchored = mine.length > 0 ? await anchorAll(mine, repo, head) : [];
      if (anchored.length > 0 && anchored.every((a) => a.status !== 'lost')) {
        outcomes.set(p.id, { promise: p, from: 'kept', bindings: anchored.map((a) => (a.status === 'moved' ? a.binding : mine.find((m) => m.id === a.binding.id) ?? a.binding)), dropped: [] });
      } else still.push(p);
    }
    open2 = still;
  }

  // 3. The model points at the rest; the program verifies every location and copies the lines from git.
  let usd = 0;
  /** R4-FIX: promises the model was not asked about because the run budget was reached. */
  const notAsked: string[] = [];
  let model: ModelClient | null = null;
  let modelNote: string | null = null;
  if (open2.length > 0 && args.flags.has('no-model')) modelNote = 'not asked (--no-model)';
  else if (open2.length > 0) {
    const scripted = args.values.scripted;
    try {
      model = deps.createModel({ config, env: ctx.env, ...(scripted ? { scriptedDir: resolve(ctx.cwd, scripted) } : {}) });
    } catch (error) {
      if (!(error instanceof JuratorError)) throw error;
      modelNote = `not asked: ${error.message}`;
    }
  }
  const nice = fancy(ctx) && !json;
  let headerShown = false;
  // HZ-1 (backlog 17): each repo's branch @ commit in a workspace, not the composite commit.
  const snapshot = nice && typeof repo.snapshot === 'function' ? await repo.snapshot().catch(() => null) : null;
  const headerLines = (): string[] =>
    screenUi(ctx).header({ command: 'bind', workspace: workspaceLabel(root, config), model: modelLabel(model) ?? 'no model', budgetUsd: config.budgetUsdPerRun, facts: snapshot ? repoFacts(snapshot, head) : [['commit', short(head)]] });
  if (model) {
    if (nice) {
      print(ctx, headerLines());
      headerShown = true;
    }
    // R4-UI2: one live row per promise the model points at; the program checks each line in git.
    // R5-B: "bound" counts only promises that end with a checked location, like the table below; an answer with no
    // location (or only dropped ones) is "no location", and a budget stop is "not asked".
    const live = liveFor(ctx, { title: 'bind', unit: 'promises', total: open2.length, budgetUsd: config.budgetUsdPerRun, words: { done: 'bound by the model', failed: 'failed', skipped: 'not bound' } });
    for (const p of open2) live.add(p.id, p.id);
    const m = trackModel(model, {
      onStart: (task) => {
        if (task.startsWith('bind:')) live.start(task.slice(5), 'the model points at the lines');
      },
      onEnd: (task, usd) => {
        live.addCost(usd);
        if (task.startsWith('bind:')) live.detail(task.slice(5), 'checking each line in git');
      },
    });
    const answers = await mapPool(open2, Math.min(DEFAULT_CONCURRENCY, open2.length), async (p) => {
      try {
        const files = await loadRuleFiles(repo, head, [...new Set([...p.scope, ...config.codeScope])], cache);
        const res = await proposeBindings(p, files, head, m);
        if (res.bindings.length > 0) live.done(p.id, `${res.bindings.length} location${res.bindings.length === 1 ? '' : 's'}`);
        else live.skip(p.id, res.dropped.length > 0 ? 'no location kept (the program dropped them)' : 'no location found');
        return { p, res };
      } catch (error) {
        if (isBudgetStop(error)) live.skip(p.id, 'not asked: budget reached');
        else live.fail(p.id, 'the model step failed');
        return { p, error: (error as Error).message, ...(isBudgetStop(error) ? { budget: true } : {}) };
      }
    });
    const stopped = answers.filter((a) => 'error' in a && a.budget).length;
    live.finish({ keep: 'none', ...(stopped > 0 ? { summary: `${stopped} not asked: the run budget was reached` } : {}) });
    for (const a of answers) {
      if ('error' in a && a.budget) {
        notAsked.push(a.p.id);
        outcomes.set(a.p.id, { promise: a.p, from: 'skipped', bindings: [], dropped: [], note: 'not asked: the run budget was reached' });
        continue;
      }
      if ('error' in a) {
        outcomes.set(a.p.id, { promise: a.p, from: 'skipped', bindings: [], dropped: [], note: `the model step failed: ${a.error}` });
        continue;
      }
      usd += a.res.usage.usd;
      outcomes.set(a.p.id, { promise: a.p, from: a.res.bindings.length > 0 ? 'model' : 'none', bindings: a.res.bindings, dropped: a.res.dropped });
    }
  }
  for (const p of open2) {
    if (!outcomes.has(p.id)) outcomes.set(p.id, { promise: p, from: 'skipped', bindings: [], dropped: [], note: `the model was ${modelNote ?? 'not asked'}` });
  }

  // Save: promises with a fresh answer replace their old rule/model bindings; skipped ones keep what they had.
  const fresh = new Map<string, Binding[]>();
  for (const o of outcomes.values()) if (o.from !== 'skipped') fresh.set(o.promise.id, [...o.bindings]);
  const merged = mergeBindings(saved, fresh);
  const changed = stableJson([...merged].sort((a, b) => compareIds(a.id, b.id))) !== stableJson(saved);
  if (changed) await writeBindings(store, merged);
  const final = await readBindings(store).catch(() => merged);

  const ordered = targets.map((p) => outcomes.get(p.id) as Outcome);
  const boundIds = new Set(final.map((b) => b.promiseId));
  if (json) {
    ctx.out(
      JSON.stringify(
        {
          commit: head,
          model: model ? { id: model.id, mode: model.mode } : null,
          costUsd: usd,
          results: ordered.map((o) => ({
            promiseId: o.promise.id,
            from: o.from,
            bindings: final.filter((b) => b.promiseId === o.promise.id),
            dropped: o.dropped,
            ...(o.note ? { note: o.note } : {}),
          })),
          written: changed,
        },
        null,
        2,
      ),
    );
    return 0;
  }
  if (nice) {
    const ui = screenUi(ctx);
    const out: string[] = headerShown ? [] : headerLines();
    const from: Record<Outcome['from'], string> = { rule: 'rule, no AI', model: 'model, checked', kept: 'kept', none: '', skipped: '' };
    const rows: string[][] = [];
    for (const o of ordered) {
      const mine = final.filter((b) => b.promiseId === o.promise.id);
      if (o.from === 'skipped' || mine.length === 0) {
        rows.push([o.promise.id, ui.tone(`${ui.sym.dot} not bound`, 'muted'), '', o.from === 'skipped' ? (o.note ?? 'not bound') : 'no code location found (checks use its scope files)']);
      } else mine.forEach((b, i) => rows.push([i === 0 ? o.promise.id : '', i === 0 ? ui.tone(`${ui.sym.done} bound`, 'kept') : '', from[o.from], describeBinding(b)]));
    }
    const bound = targets.filter((p) => boundIds.has(p.id)).length;
    out.push(...ui.section('Where each promise lives', `${bound} of ${targets.length} bound`));
    out.push(...ui.table({ columns: [{ header: 'Promise', min: 10 }, { header: 'Result', min: 9 }, { header: 'From', min: 6 }, { header: 'Lines', flex: true, min: 16 }], rows }));
    const dropped = ordered.flatMap((o) => o.dropped.map((d) => ({ label: o.promise.id, text: `dropped ${d.path}:${d.lines}: ${d.reason}` })));
    const v = ui.verbose('Dropped by the program', dropped);
    if (v.length) out.push('', ...v);
    else if (dropped.length) out.push('', ...ui.hint(`  ${dropped.length} model location${dropped.length === 1 ? '' : 's'} dropped by the program: --verbose shows why.`));
    out.push('', ...ui.hint(`  Cost $${usd.toFixed(4)}`));
    if (notAsked.length > 0) {
      const asked = open2.length - notAsked.length;
      const command = `${BRAND.command} bind ${notAsked.length === 1 ? notAsked[0] : '--all'}`;
      for (const line of budgetStopLines({ spentUsd: usd, budgetUsd: config.budgetUsdPerRun, done: asked, left: notAsked.length, unit: 'promise', command })) out.push(ui.line(line, 'accent'));
    }
    out.push(...ui.next(changed ? `review ${BRAND.folder}/bindings.json and commit it; a change to a bound line now triggers its promise` : `${BRAND.command} check (nothing changed in ${BRAND.folder}/bindings.json)`));
    print(ctx, out);
    return 0;
  }
  const width = Math.max(...targets.map((p) => p.id.length));
  const tag: Record<Outcome['from'], string> = { rule: 'from its rule, no AI', model: 'from the model, checked by the program', kept: 'kept from before', none: '', skipped: '' };
  const by = model ? (model.mode === 'live' ? `${model.id}, live` : 'scripted answers, no network') : null; // live only when live
  ctx.out(`Where each promise lives at ${short(head)}${by ? ` (model: ${by})` : ''}`);
  for (const o of ordered) {
    const id = o.promise.id.padEnd(width);
    const mine = final.filter((b) => b.promiseId === o.promise.id);
    if (o.from === 'skipped' || mine.length === 0) {
      const why = o.from === 'skipped' ? (o.note ?? 'not bound') : 'no code location found (checks use its scope files)';
      ctx.out(`${ctx.style.yellow('–')} ${id} -> ${why}`);
    } else {
      mine.forEach((b, i) => {
        const head2 = i === 0 ? `${ctx.style.green('✓')} ${id}` : `  ${' '.repeat(width)}`;
        ctx.out(`${head2} -> ${describeBinding(b)}  ${ctx.style.dim(`${b.kind}${tag[o.from] ? `, ${tag[o.from]}` : ''}`)}`);
      });
    }
    for (const d of o.dropped) ctx.out(ctx.style.dim(`  ${' '.repeat(width)}    dropped ${d.path}:${d.lines}: ${d.reason}`));
  }
  const count = (f: Outcome['from']): number => ordered.filter((o) => o.from === f).length;
  const bound = targets.filter((p) => boundIds.has(p.id)).length;
  const parts = [`${count('rule')} from rules (no AI)`, `${count('model')} from the model`, ...(count('kept') > 0 ? [`${count('kept')} kept`] : [])];
  ctx.out(`${bound} of ${targets.length} code promises bound: ${parts.join(', ')} · cost $${usd.toFixed(4)}`);
  if (notAsked.length > 0) {
    const asked = open2.length - notAsked.length;
    const command = `${BRAND.command} bind ${notAsked.length === 1 ? notAsked[0] : '--all'}`;
    for (const line of budgetStopLines({ spentUsd: usd, budgetUsd: config.budgetUsdPerRun, done: asked, left: notAsked.length, unit: 'promise', command })) {
      ctx.out(ctx.style.yellow(line));
    }
  }
  if (changed) ctx.out(`Next: review ${BRAND.folder}/bindings.json and commit it; a change to a bound line now triggers its promise`);
  else ctx.out(`Nothing changed in ${BRAND.folder}/bindings.json. Next: ${BRAND.command} check`);
  return 0;
}

async function list(ctx: CommandContext, deps: BindCommandDeps, args: Args): Promise<number> {
  const { root, store } = await open(ctx, deps);
  const saved = await readBindings(store);
  const json = args.flags.has('json');
  if (saved.length === 0) {
    if (json) ctx.out(JSON.stringify({ bindings: [] }, null, 2));
    else {
      ctx.out('No bindings yet.');
      ctx.out(`Next: ${BRAND.command} bind --all`);
    }
    return 0;
  }
  const repo = await deps.openRepo(root);
  const ref = args.values.at ?? 'HEAD';
  const commit = await repo.resolve(ref);
  const anchored = await anchorAll(saved, repo, commit);
  if (json) {
    ctx.out(JSON.stringify({ ref, commit, bindings: anchored.map((a, i) => ({ ...saved[i], status: a.status, now: a.binding })) }, null, 2));
    return 0;
  }
  const width = Math.max(...saved.map((b) => b.promiseId.length));
  ctx.out(`Bindings at ${ref} (${short(commit)})`);
  let previous = '';
  anchored.forEach((a, i) => {
    const b = saved[i] as Binding;
    const id = b.promiseId === previous ? ' '.repeat(width) : b.promiseId.padEnd(width);
    previous = b.promiseId;
    const status =
      a.status === 'same'
        ? ctx.style.green('unchanged')
        : a.status === 'moved'
          ? ctx.style.green(`moved to line ${lines(a.binding)}`)
          : a.status === 'changed'
            ? ctx.style.yellow(`changed: now ${excerpt(a.binding)} at line ${lines(a.binding)}`)
            : ctx.style.red('lost (the lines and the name are gone)');
    ctx.out(`${id} -> ${describeBinding(b)}  ${ctx.style.dim(`${b.kind}, ${b.foundBy}`)}  ${status}`);
  });
  const promisesBound = new Set(saved.map((b) => b.promiseId)).size;
  const n = (st: string): number => anchored.filter((a) => a.status === st).length;
  const drift = [n('changed') > 0 ? `${n('changed')} changed` : '', n('moved') > 0 ? `${n('moved')} moved` : '', n('lost') > 0 ? `${n('lost')} lost` : ''].filter(Boolean);
  ctx.out(`${saved.length} bindings for ${promisesBound} promises${drift.length > 0 ? ` · since they were bound: ${drift.join(', ')}` : ''}`);
  if (anchored.some((a) => a.status === 'changed' || a.status === 'lost')) ctx.out(`Next: ${BRAND.command} check (changed lines trigger their promises)`);
  return 0;
}

/** The command body with injectable dependencies (tests); the CLI uses the real packages. */
export async function runBindCommand(ctx: CommandContext, deps: BindCommandDeps = defaultDeps): Promise<number> {
  const args = parseArgs(ctx.argv);
  if (args.positional[0] === 'list') return list(ctx, deps, args);
  if (args.flags.has('help')) {
    ctx.out(`Usage: ${USAGE}`);
    return 0;
  }
  return bind(ctx, deps, args);
}

const command: Command = {
  name: 'bind',
  summary: 'Record where in the code each promise lives (constants, guards, config)',
  usage: USAGE,
  run: (ctx) => runBindCommand(withVideo(ctx)), // --video / JURATOR_VIDEO=1: 100 columns, short paths and shas
};
export default command;
