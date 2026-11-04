// Owner: WP-K. `jurator check`: rules first (no AI), AI read as a labelled fallback, one CheckRun record.
import { relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { lastVerified } from '../../cache/index.js';
import { exitCodeFor, runCheck } from '../../check/index.js';
import { readInfeasible, terminalWidth } from '../../check/local.js';
import type { CheckOptions, ModelClient } from '../../contracts.js';
import { openRepo } from '../../git/index.js';
import { createModel, tryCreateModel } from '../../model/index.js';
import { budgetStopLines, parseBudget, storeWithBudget, withBudget } from '../../model/budget.js';
import { renderRunMarkdown, renderRunText } from '../../render/index.js';
import { isVideo, withVideo } from '../../render/video.js';
import { findRepoRoot, openStore } from '../../workspace/index.js';
import type { Command } from '../context.js';
import { BRAND } from '../../brand.js';
import { fancy, liveFor, screenUi, trackModel } from '../../render/screen.js';
import { renderRunScreen } from '../../render/check-screen.js';
import { fileSummaryCache, fromCheckResult, shortIdsFor, summarizeAll, summaryModel, type Summary } from '../../explain/index.js';

const USAGE = `${BRAND.command} check [--diff <base>] [--head <ref>] [--full] [--no-ai] [--no-ai-summary] [--budget <usd>] [--verbose] [--json] [--md] [--scripted <dir>] [--video]`;

const command: Command = {
  name: 'check',
  summary: 'Check the code against your promises',
  usage: USAGE,
  async run(ctx0) {
    const ctx = withVideo(ctx0); // --video / JURATOR_VIDEO=1: 100 columns, short paths and shas
    let args;
    try {
      args = parseArgs({
        args: [...ctx.argv],
        options: {
          diff: { type: 'string' },
          head: { type: 'string' },
          'no-ai': { type: 'boolean' },
          full: { type: 'boolean' },
          json: { type: 'boolean' },
          md: { type: 'boolean' },
          scripted: { type: 'string' },
          budget: { type: 'string' },
          verbose: { type: 'boolean' },
          'no-ai-summary': { type: 'boolean' },
        },
        allowPositionals: false,
        strict: true,
      }).values;
    } catch (error) {
      ctx.err(`${error instanceof Error ? error.message : String(error)}\nUsage: ${USAGE}`);
      return 2;
    }
    let budget: number | undefined;
    try {
      budget = parseBudget(args.budget);
    } catch (error) {
      ctx.err(`${(error as Error).message}\nUsage: ${USAGE}`);
      return 2;
    }
    const root = await findRepoRoot(ctx.cwd);
    // R4-FIX: --budget replaces the config's run budget for this run (the check reads the config itself).
    const store = storeWithBudget(openStore(root), budget);
    if (!(await store.exists())) {
      ctx.err(`No ${BRAND.folder}/ folder in this repo yet.\nNext: ${BRAND.command} init`);
      return 2;
    }
    const repo = await openRepo(root);
    const config = withBudget(await store.readConfig(), budget);

    let model: ModelClient | null = null;
    if (!args['no-ai']) {
      model = args.scripted
        ? createModel({ config, env: ctx.env, scriptedDir: resolve(ctx.cwd, args.scripted) })
        : tryCreateModel({ config, env: ctx.env });
      if (!model) {
        ctx.err('No model key found, so promises without a rule are not read by AI (set META_API_KEY, or pass --no-ai).');
      }
    }
    const head = args.head ?? 'HEAD';
    const target: CheckOptions['target'] = args.diff ? { kind: 'diff', base: args.diff, head } : { kind: 'repo', head };
    // The verified pair before this run, for the "what changed since" line (runCheck replaces it when it completes).
    const since = await lastVerified(store);
    // R4-UI2: live steps while the check runs: the rules (no AI), each AI read, then the saved record.
    const live = liveFor(ctx, { title: 'check', unit: 'steps', budgetUsd: config.budgetUsdPerRun, words: { done: 'done', failed: 'failed', skipped: 'skipped' } });
    live.add('rules', 'Run the rules (no AI)');
    live.add('ai', 'AI reads for promises without a rule');
    live.add('save', 'Save the record (quotes copied from git)');
    live.start('rules', 'reading the changed files at the commit');
    let reads = 0;
    let readsDone = 0;
    const tracked = trackModel(model, {
      onStart: (task) => {
        if (!task.startsWith('ai-read:')) return;
        live.done('rules', 'rules ran');
        reads += 1;
        live.start('ai', `reading ${task.slice('ai-read:'.length).split(':')[0] ?? ''}`);
        live.detail('ai', `${readsDone} of ${reads} read · now ${task.slice('ai-read:'.length).split(':')[0] ?? ''}`);
      },
      onEnd: (task, usd) => {
        live.addCost(usd);
        if (!task.startsWith('ai-read:')) return;
        readsDone += 1;
        live.detail('ai', `${readsDone} of ${reads} read`);
      },
    });
    let run: Awaited<ReturnType<typeof runCheck>>;
    try {
      run = await runCheck({ repo, store, model: tracked, target, aiRead: model !== null, now: ctx.now }, { full: args.full === true });
    } catch (error) {
      live.finish({ ok: false, summary: 'stopped by an error' });
      throw error;
    }
    live.done('rules', 'rules ran');
    if (reads > 0) live.done('ai', `${readsDone} read`);
    else live.skip('ai', model ? 'every touched promise has a rule, or nothing to read' : 'no model');
    live.start('save');

    let runPath: string | undefined;
    try {
      const saved = await store.writeRun(run);
      const rel = relative(ctx.cwd, saved);
      runPath = rel && !rel.startsWith('..') ? rel : saved;
    } catch (error) {
      ctx.err(`Could not save the run record: ${error instanceof Error ? error.message : String(error)}`);
    }

    live.done('save', runPath ?? 'not saved');
    // HZ-1: plain summaries of the findings for the screen (Muse Spark from the program's evidence, cached by content;
    // a template with --no-ai, --no-ai-summary, no key or no budget left). They never change a verdict or the record.
    const nice = !args.json && !args.md && fancy(ctx);
    const promises = nice ? await store.readPromises() : [];
    const rules = nice ? await store.readRules() : [];
    const ids = shortIdsFor(promises);
    const summaries = new Map<string, Summary>();
    let summaryUsd = 0;
    if (nice) {
      const findings = run.results.flatMap((r) => {
        const f = fromCheckResult(run, r, rules);
        return f ? [f] : [];
      });
      if (findings.length > 0) {
        const sm = summaryModel({ config, env: ctx.env, argv: ctx.argv, scriptedDir: args.scripted ? resolve(ctx.cwd, args.scripted) : undefined, budgetLeftUsd: config.budgetUsdPerRun - run.costUsd });
        live.add('summaries', 'Plain summaries of the findings');
        live.start('summaries', sm.model?.mode === 'live' ? `${sm.model.id} writes them from the evidence` : 'from the evidence');
        let done = 0;
        const got = await summarizeAll(findings, {
          model: sm.model,
          cache: fileSummaryCache(store.dir),
          offReason: sm.offReason,
          idFor: (id) => ids.short(id),
          onDone: (_f, sum) => {
            done += 1;
            live.addCost(sum.usd);
            live.detail('summaries', `${done} of ${findings.length}`);
          },
        });
        for (const [k, v] of got) summaries.set(k, v);
        summaryUsd = [...got.values()].reduce((a, x) => a + x.usd, 0);
        const byAi = [...got.values()].filter((x) => x.by === 'ai').length;
        live.done('summaries', byAi > 0 ? `${byAi} by AI, ${got.size - byAi} by the program` : 'by the program');
      }
    }
    live.cost(run.costUsd + summaryUsd);
    // R5-B: in the new look the screen's header comes first and already says what was checked and the cost, so the
    // live view clears without a summary line (it printed above the header before).
    live.finish({ keep: 'none', quiet: !args.json && !args.md && fancy(ctx) });
    if (args.json) ctx.out(JSON.stringify(run, null, 2));
    else if (!args.md && fancy(ctx)) {
      const sources = Object.fromEntries(config.sources.map((s) => [s.alias, s.locator] as const));
      const infeasible = await readInfeasible(store.dir);
      const ai = model ? { id: model.id, mode: model.mode } : null;
      const base = { sources, infeasible, since, model: ai, video: isVideo(ctx.env), summaries, ids, rules, summaryUsd };
      const ui = screenUi(ctx, isVideo(ctx.env) ? 100 : undefined);
      for (const line of renderRunScreen(run, ui, runPath === undefined ? base : { ...base, runPath })) ctx.out(line);
      const unread = run.results.filter((r) => /run budget of \$[\d.]+ (?:was )?reached/u.test(`${r.reason ?? ''} ${r.explanation ?? ''}`)).length;
      if (unread > 0) {
        const read = run.results.filter((r) => r.level === 'ai-read').length;
        const again = ['check', ...(args.diff ? ['--diff', args.diff] : []), ...(args.head ? ['--head', args.head] : []), ...(args.full ? ['--full'] : [])].join(' ');
        for (const line of budgetStopLines({ spentUsd: run.costUsd, budgetUsd: config.budgetUsdPerRun, done: read, left: unread, unit: 'promise', command: `${BRAND.command} ${again}` })) ctx.out(ui.line(line, 'accent'));
      }
    } else {
      const sources = Object.fromEntries(config.sources.map((s) => [s.alias, s.locator] as const));
      const infeasible = await readInfeasible(store.dir);
      const ai = model ? { id: model.id, mode: model.mode } : null;
      const base = { sources, infeasible, width: terminalWidth(), since, model: ai, video: isVideo(ctx.env) };
      const options = runPath === undefined ? base : { ...base, runPath };
      ctx.out(args.md ? renderRunMarkdown(run, options) : renderRunText(run, ctx.style, options));
      // R4-FIX: promises left unread because the run budget was reached: how much more, and the command to continue.
      const unread = run.results.filter((r) => /run budget of \$[\d.]+ (?:was )?reached/u.test(`${r.reason ?? ''} ${r.explanation ?? ''}`)).length;
      if (unread > 0 && !args.md) {
        const read = run.results.filter((r) => r.level === 'ai-read').length;
        const again = ['check', ...(args.diff ? ['--diff', args.diff] : []), ...(args.head ? ['--head', args.head] : []), ...(args.full ? ['--full'] : [])].join(' ');
        const lines = budgetStopLines({ spentUsd: run.costUsd, budgetUsd: config.budgetUsdPerRun, done: read, left: unread, unit: 'promise', command: `${BRAND.command} ${again}` });
        for (const line of lines) ctx.out(ctx.style.yellow(line));
      }
    }
    return exitCodeFor(run);
  },
};
export default command;
