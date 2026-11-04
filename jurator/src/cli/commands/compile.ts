// Owner: WP-P. jurator compile: policies -> numbered promises with exact quotes, then contradictions.
import type { Command } from '../context.js';
import { makeConnectorContext, pullSources } from '../../connectors/index.js';
import { openRepo } from '../../git/index.js';
import { one, parseArgs } from '../../policy/args.js';
import { conflictCheckLine, conflictLines, json, modelFor, money, openWorkspace } from '../../policy/cli.js';
import { runCompile } from '../../policy/flows.js';
import { BRAND } from '../../brand.js';
import { withVideo } from '../../render/video.js';
import { budgetRetryLines, isBudgetStop, parseBudget, withBudget } from '../../model/budget.js';
import { fancy, liveFor, modelLabel, print, screenUi, trackModel, workspaceLabel } from '../../render/screen.js';
import type { PromiseRecord } from '../../contracts.js';
import { idRange } from '../../ui/text.js';

const USAGE = `${BRAND.command} compile [--scripted <dir>] [--accept] [--force] [--budget <usd>] [--json] [--video]`;

const command: Command = {
  name: 'compile',
  summary: 'Turn policies into numbered promises with exact quotes',
  usage: USAGE,
  async run(ctx0) {
    const ctx = withVideo(ctx0); // --video / JURATOR_VIDEO=1: 100 columns, short paths and shas
    const args = parseArgs(ctx.argv, { flags: ['accept', 'force', 'json'], values: ['scripted', 'budget'] }, USAGE);
    const budget = parseBudget(one(args, 'budget'));
    const { root, store } = await openWorkspace(ctx);
    const config = withBudget(await store.readConfig(), budget);
    if (!config.sources.length) {
      ctx.err('No policy sources yet.');
      ctx.err(`Next: ${BRAND.command} add <file>, or ${BRAND.command} init`);
      return 2;
    }
    const nice = !args.flags.has('json') && fancy(ctx);
    // R4-UI2: live steps: fetch each source -> drafting -> quotes verified -> conflicts (typed fields, then the model).
    const live = liveFor(ctx, { title: 'compile', unit: 'steps', budgetUsd: config.budgetUsdPerRun, words: { done: 'done', failed: 'failed', skipped: 'unchanged' } });
    live.add('fetch', 'Fetch the policy sources');
    for (const src of config.sources) live.add(`src:${src.alias}`, src.alias);
    live.add('conflicts', 'Look for conflicts');
    let current: string | null = null;
    const model = trackModel(modelFor(ctx, config, one(args, 'scripted')), {
      onStart: (task) => {
        if (task.startsWith('compile:')) {
          const id = `src:${task.slice('compile:'.length)}`;
          if (current && current !== id) live.done(current, 'quotes checked word for word');
          current = id;
          live.start(id, 'drafting promises from the policy text');
        } else if (task === 'contradictions') {
          if (current) live.done(current, 'quotes checked word for word');
          current = null;
          live.start('conflicts', 'typed fields compared (no AI); the model reads the undecided pairs');
        }
      },
      onEnd: (task, usd) => {
        live.addCost(usd);
        if (task.startsWith('compile:')) live.detail(`src:${task.slice('compile:'.length)}`, 'finding each quote word for word, typing the fields');
      },
    });
    if (nice) {
      print(ctx, screenUi(ctx).header({ command: 'compile', workspace: workspaceLabel(root, config), model: modelLabel(model), budgetUsd: config.budgetUsdPerRun, facts: [['sources', String(config.sources.length)]] }));
    }
    const connectorCtx = makeConnectorContext(root, ctx.env);
    const run = (): ReturnType<typeof runCompile> => runCompile(
      {
        store,
        model,
        now: ctx.now(),
        pull: async () => {
          live.start('fetch', `${config.sources.length} source${config.sources.length === 1 ? '' : 's'}`);
          const pulled = await pullSources(store, connectorCtx, true);
          live.done('fetch', `${pulled.docs.length} fetched`);
          return pulled;
        },
        codeFiles: async () => {
          const repo = await openRepo(root);
          return repo.listFiles(await repo.resolve('HEAD'), config.codeScope);
        },
      },
      { accept: args.flags.has('accept'), force: args.flags.has('force') },
    );
    let report: Awaited<ReturnType<typeof runCompile>>;
    try {
      report = await run();
    } catch (error) {
      live.finish({ ok: false, summary: isBudgetStop(error) ? 'budget reached' : 'stopped by an error' });
      if (!isBudgetStop(error)) throw error;
      // R4-FIX: the budget stopped compile: say so and give the exact command to continue.
      const spent = (model as { spentUsd?: number } | null)?.spentUsd ?? config.budgetUsdPerRun;
      ctx.err((error as Error).message);
      const again = `${BRAND.command} compile${args.flags.has('accept') ? ' --accept' : ''}${args.flags.has('force') ? ' --force' : ''}`;
      for (const line of budgetRetryLines(spent, config.budgetUsdPerRun, again)) ctx.err(line);
      return 2;
    }
    for (const src of report.sources) {
      if (src.skipped) live.skip(`src:${src.alias}`, 'unchanged since last compile');
      else live.done(`src:${src.alias}`, `${src.promises} promises, ${src.found}/${src.total} quotes found`);
    }
    if (report.contradictionsChecked) live.done('conflicts', `${report.contradictions.length} found`);
    else live.skip('conflicts', 'nothing changed');
    live.cost(report.costUsd);
    live.finish({ keep: 'none' });
    if (args.flags.has('json')) {
      json(ctx, report);
      return 0;
    }
    if (nice) return compileScreen(ctx, report, config, await store.readPromises());

    const s = ctx.style;
    // The label says live only for a live model call.
    const mode = report.mode === 'scripted' ? ' (scripted answers, no network)' : report.mode === 'live' && model ? ` with ${model.id} (live)` : '';
    ctx.out(`${s.bold('Compiled')} ${report.sources.length} policy source${report.sources.length === 1 ? '' : 's'}${mode}`);
    const width = Math.max(8, ...report.sources.map((x) => x.alias.length));
    for (const src of report.sources) {
      const name = s.bold(src.alias.padEnd(width));
      const count = `${src.promises} promise${src.promises === 1 ? '' : 's'}`;
      if (src.skipped) {
        ctx.out(`  ${name}  ${count} · unchanged since last compile · ${s.dim(src.locator)}`);
        continue;
      }
      const how = src.structured
        ? `from settings (no AI), ${src.found}/${src.total} settings found`
        : `${src.found}/${src.total} quotes found word for word`;
      const ok = src.found === src.total ? s.green(how) : s.yellow(how);
      ctx.out(`  ${name}  ${count} · ${ok} · ${s.dim(src.locator)}`);
      const pad = ' '.repeat(width + 4);
      if (src.added.length) ctx.out(`${pad}${s.green('+')} ${src.added.length} new: ${idRange(src.added)}`);
      if (src.reworded.length) ctx.out(`${pad}${s.yellow('~')} reworded (back to draft): ${idRange(src.reworded)}`);
      if (src.retired.length) ctx.out(`${pad}${s.red('-')} retired (sentence removed): ${idRange(src.retired)}`);
      for (const d of src.dropped) ctx.out(`${pad}${s.red('x')} dropped "${d.wording}": ${d.reason}`);
      for (const n of src.notes ?? []) ctx.out(`${pad}${s.yellow('!')} ${n}`);
    }
    const dropped = report.sources.reduce((n, x) => n + x.dropped.length, 0);
    if (dropped) ctx.out(`Dropped ${dropped} draft${dropped === 1 ? '' : 's'}: the program could not find the quote in the policy.`);

    const promises = new Map((await store.readPromises()).map((p) => [p.id, p]));
    const open = report.contradictions.filter((c) => c.status === 'open');
    if (!report.contradictionsChecked) ctx.out(s.dim('Conflicts not re-checked (nothing changed).'));
    if (report.contradictions.length) {
      ctx.out(`${s.bold('Conflicts')}: ${report.contradictions.length} (${open.length} open)`);
      for (const c of report.contradictions) for (const line of conflictLines(ctx, c, promises, config)) ctx.out(line);
    } else if (report.contradictionsChecked) {
      const unread = report.conflictCheck && report.conflictCheck.undecided > 0 && !report.conflictCheck.modelChecked;
      ctx.out(`${s.bold('Conflicts')}: none found${unread ? ' by comparing typed fields' : ''}`);
    }
    if (report.conflictCheck) {
      const structured = report.contradictions.filter((c) => c.foundBy === 'structured' && c.status !== 'not-a-conflict').length;
      ctx.out(s.dim(conflictCheckLine(report.conflictCheck, structured)));
    }
    if (report.accepted.length) ctx.out(`Accepted ${report.accepted.length} draft promise${report.accepted.length === 1 ? '' : 's'}.`);
    ctx.out(`Cost: ${money(report.costUsd)}${report.mode === 'scripted' ? ' (scripted)' : ''}`);

    const drafts = [...promises.values()].filter((p) => p.status === 'draft').length;
    if (drafts) ctx.out(`Next: ${BRAND.command} promises to review ${drafts} draft${drafts === 1 ? '' : 's'}, then ${BRAND.command} accept --all`);
    else if (open.length) ctx.out(`Next: ${BRAND.command} conflicts (fix one source, then compile again)`);
    else ctx.out(`Next: ${BRAND.command} rule propose --all`);
    return 0;
  },
};
/** R4-UI2: a card per source, the promises table, conflicts, one Next. */
function compileScreen(
  ctx: Parameters<Command['run']>[0],
  report: Awaited<ReturnType<typeof runCompile>>,
  config: { sources: ReadonlyArray<{ alias: string; locator: string }> } & Record<string, unknown>,
  all: readonly PromiseRecord[],
): number {
  const ui = screenUi(ctx);
  const out: string[] = [];
  out.push(...ui.section('Sources', `${report.sources.length} compiled`));
  out.push(
    ...ui.cards(
      report.sources.map((src) => ({
        value: `${src.promises} promise${src.promises === 1 ? '' : 's'}`,
        label: src.alias,
        sub: src.skipped ? 'unchanged' : src.structured ? `${src.found}/${src.total} settings, no AI` : `${src.found}/${src.total} quotes found`,
        tone: src.skipped ? ('muted' as const) : src.found === src.total ? ('kept' as const) : ('accent' as const),
      })),
    ),
  );
  for (const src of report.sources) {
    const lines: string[] = [];
    if (src.added.length) lines.push(`${ui.tone('+', 'kept')} ${src.alias}: ${src.added.length} new: ${idRange(src.added)}`);
    if (src.reworded.length) lines.push(`${ui.tone('~', 'accent')} ${src.alias} reworded (back to draft): ${idRange(src.reworded)}`);
    if (src.retired.length) lines.push(`${ui.tone('-', 'broken')} ${src.alias} retired: ${idRange(src.retired)}`);
    for (const d of src.dropped) lines.push(`${ui.tone('x', 'broken')} ${src.alias} dropped "${d.wording}": ${d.reason}`);
    for (const n of src.notes ?? []) lines.push(`${ui.tone('!', 'accent')} ${src.alias}: ${n}`);
    for (const l of lines) out.push(`  ${l}`);
  }
  const live = all.filter((p) => p.status !== 'retired').sort((a, b) => (a.id < b.id ? -1 : 1));
  out.push(...ui.section('Promises', `${live.length} · ${live.filter((p) => p.status === 'draft').length} draft`));
  out.push(
    ...ui.table({
      columns: [{ header: 'Id', min: 10 }, { header: 'Checked by', min: 7 }, { header: 'Status', min: 6 }, { header: 'Promise', flex: true, min: 20 }],
      rows: live.map((p) => [p.id, p.checkable, p.status === 'accepted' ? ui.tone('accepted', 'kept') : ui.tone(p.status, 'accent'), p.wording]),
    }),
  );
  const promises = new Map(all.map((p) => [p.id, p]));
  const open = report.contradictions.filter((c) => c.status === 'open');
  out.push(...ui.section('Conflicts', report.contradictionsChecked ? `${report.contradictions.length} found · ${open.length} open` : 'not re-checked'));
  if (report.contradictions.length) {
    const plainCtx = { ...ctx, style: ctx.style };
    for (const c of report.contradictions) for (const line of conflictLines(plainCtx, c, promises, config as never)) out.push(line);
  } else if (report.contradictionsChecked) out.push(ui.line('  none found', 'kept'));
  else out.push(...ui.hint('  Nothing changed, so conflicts were not re-checked.'));
  if (report.conflictCheck) {
    const structured = report.contradictions.filter((c) => c.foundBy === 'structured' && c.status !== 'not-a-conflict').length;
    out.push(...ui.hint(`  ${conflictCheckLine(report.conflictCheck, structured)}`));
  }
  out.push('');
  const facts = [`Cost ${money(report.costUsd)}${report.mode === 'scripted' ? ' (scripted)' : ''}`];
  if (report.accepted.length) facts.push(`accepted ${report.accepted.length} draft${report.accepted.length === 1 ? '' : 's'}`);
  out.push(...ui.hint(`  ${facts.join(' · ')}`));
  const drafts = live.filter((p) => p.status === 'draft').length;
  if (drafts) out.push(...ui.next(`${BRAND.command} promises to review ${drafts} draft${drafts === 1 ? '' : 's'}, then ${BRAND.command} accept --all`));
  else if (open.length) out.push(...ui.next(`${BRAND.command} conflicts (fix one source, then compile again)`));
  else out.push(...ui.next(`${BRAND.command} rule propose --all`));
  print(ctx, out);
  return 0;
}

export default command;
