// Owner: FX-3. `jurator bench`: catch rate and false alarms on planted breaks (rules vs AI read vs a plain skill prompt),
// plus a red team in which one model attacks each rule and another judges what the rule missed.
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { DEFAULT_BENCH_DIR, loadBench, renderBenchText, runBench, type LabelledModel } from '../../bench/index.js';
import { DEFAULT_CONFIG, type Config } from '../../contracts.js';
import { createModel, hasModelKey } from '../../model/index.js';
import { REDTEAM_ATTACKER_MODEL, REDTEAM_JUDGE_MODEL } from '../../rules/redteam.js';
import { BRAND } from '../../brand.js';
import type { Command } from '../context.js';
import { budgetStopLines } from '../../model/budget.js';
import { liveFor, trackModel } from '../../render/screen.js';

const USAGE = `${BRAND.command} bench [--models muse-wonder-1.0,muse-spark-1.3] [--plain <model>] [--no-plain] [--no-redteam] [--attacker <model>] [--judge <model>] [--no-ai] [--cases B1,H1] [--budget 6] [--concurrency 6] [--dir <bench dir>] [--scripted <dir>] [--json]`;
const DEFAULT_MODELS = ['muse-wonder-1.0', 'muse-spark-1.3'];
const DEFAULT_BUDGET_USD = 6;

const list = (s: string | undefined): string[] =>
  (s ?? '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);

const command: Command = {
  name: 'bench',
  summary: 'Measure catch rate and false alarms on planted breaks (rules vs AI read vs a plain skill prompt)',
  usage: USAGE,
  async run(ctx) {
    let args;
    try {
      args = parseArgs({
        args: [...ctx.argv],
        options: {
          models: { type: 'string' },
          plain: { type: 'string' },
          'no-plain': { type: 'boolean' },
          'no-redteam': { type: 'boolean' },
          attacker: { type: 'string' },
          judge: { type: 'string' },
          'no-ai': { type: 'boolean' },
          cases: { type: 'string' },
          budget: { type: 'string' },
          concurrency: { type: 'string' },
          dir: { type: 'string' },
          scripted: { type: 'string' },
          json: { type: 'boolean' },
        },
        allowPositionals: false,
        strict: true,
      }).values;
    } catch (error) {
      ctx.err(`${error instanceof Error ? error.message : String(error)}\nUsage: ${USAGE}`);
      return 2;
    }
    const budget = args.budget === undefined ? DEFAULT_BUDGET_USD : Number(args.budget);
    const concurrency = args.concurrency === undefined ? 6 : Number(args.concurrency);
    if (!Number.isFinite(budget) || budget <= 0 || !Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16) {
      ctx.err(`--budget takes dollars above 0 and --concurrency a whole number from 1 to 16.\nUsage: ${USAGE}`);
      return 2;
    }

    let data;
    try {
      data = await loadBench(args.dir ? resolve(ctx.cwd, args.dir) : DEFAULT_BENCH_DIR);
    } catch (error) {
      ctx.err(error instanceof Error ? error.message : String(error));
      return 2;
    }
    const caseIds = list(args.cases);
    const unknown = caseIds.filter((id) => !data.cases.some((c) => c.id === id));
    if (unknown.length > 0) {
      ctx.err(`Unknown case${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')}. Cases: ${data.cases.map((c) => c.id).join(', ')}`);
      return 2;
    }

    const scriptedDir = args.scripted ? resolve(ctx.cwd, args.scripted) : undefined;
    const ai = !args['no-ai'] && (scriptedDir !== undefined || hasModelKey(ctx.env));
    if (!args['no-ai'] && !ai) ctx.err('No model key found, so the bench runs the rules only (set META_API_KEY, or pass --scripted <dir>).');

    // R4-UI2: a live view of the model jobs (count, cost against the budget, ETA); quiet off a terminal.
    const live = liveFor(ctx, { title: 'bench', unit: 'model jobs', budgetUsd: budget, words: { done: 'done', failed: 'failed', skipped: 'skipped' } });
    live.add('jobs', 'Model jobs (AI reads, plain reads, red team)');
    live.start('jobs', 'starting');
    const clients = new Map<string, LabelledModel>();
    const model = (id: string): LabelledModel => {
      const known = clients.get(id);
      if (known) return known;
      const config: Config = { ...DEFAULT_CONFIG, model: { id, reasoningEffort: 'medium' }, budgetUsdPerRun: budget };
      // MODEL_ID in the environment would override the row's model, so each row sets its own.
      const client = trackModel(createModel({ config, env: { ...ctx.env, MODEL_ID: id }, scriptedDir, cwd: ctx.cwd }), {
        onStart: (task) => live.detail('jobs', `${id}: ${task.replace(/^bench:/u, '')}`),
        onEnd: (_task, usd) => live.addCost(usd),
      });
      const made = { label: id, client };
      clients.set(id, made);
      return made;
    };

    let report;
    try {
      const models = list(args.models);
      const readers = ai ? (models.length > 0 ? models : DEFAULT_MODELS).map(model) : [];
      const plainId = args.plain ?? readers[0]?.label ?? DEFAULT_MODELS[0];
      const plain = ai && !args['no-plain'] && plainId ? model(plainId) : null;
      const redteam =
        ai && !args['no-redteam']
          ? { attacker: model(args.attacker ?? REDTEAM_ATTACKER_MODEL), judge: model(args.judge ?? REDTEAM_JUDGE_MODEL) }
          : null;
      let lastShown = 0;
      report = await runBench({
        data,
        caseIds,
        readers,
        plain,
        redteam,
        budgetUsd: budget,
        concurrency,
        now: ctx.now,
        onProgress: (done, total) => {
          live.progress(done, total);
          if (live.mode === 'live') return;
          if (args.json || (done < total && done - lastShown < 10)) return;
          lastShown = done;
          ctx.err(`bench: ${done}/${total} model jobs done`);
        },
      });
    } catch (error) {
      live.fail('jobs', 'the bench failed');
      live.finish({ ok: false });
      ctx.err(`The bench failed: ${error instanceof Error ? error.message : String(error)}`);
      return 2;
    }
    live.done('jobs', `${report.costUsd > 0 ? `$${report.costUsd.toFixed(2)}` : 'done'}`);
    live.finish({ keep: 'none' });
    ctx.out(args.json ? JSON.stringify(report, null, 2) : renderBenchText(report));
    if (!args.json && report.skippedForBudget > 0) {
      // R4-FIX: how much more the skipped jobs need, and the exact command to run the bench again with it.
      const jobs = report.skippedForBudget;
      const done = report.costByModel.reduce((n, m) => n + m.calls, 0);
      const again = [BRAND.command, 'bench', ...ctx.argv.filter((_, i, all) => all[i] !== '--budget' && all[i - 1] !== '--budget')].join(' ');
      for (const line of budgetStopLines({ spentUsd: report.costUsd, budgetUsd: report.budgetUsd, done, left: jobs, unit: 'model job', command: again, rerunsAll: true })) {
        ctx.out(line);
      }
    }
    return 0;
  },
};
export default command;
