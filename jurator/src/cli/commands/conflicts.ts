// Owner: WP-P. jurator conflicts: show (or re-find) contradictions between promises.
import type { Command } from '../context.js';
import { findContradictions, type ContradictionStats } from '../../policy/contradictions.js';
import { one, parseArgs } from '../../policy/args.js';
import { conflictCheckLine, conflictLines, json, modelFor, money, openWorkspace } from '../../policy/cli.js';
import { ruleConflict } from '../../policy/flows.js';
import { BRAND } from '../../brand.js';
import { withVideo } from '../../render/video.js';
import { dressed, workspaceLabel } from '../../render/screen.js';

const USAGE =
  `${BRAND.command} conflicts [--find [--scripted <dir>]] [--json] | ${BRAND.command} conflicts --rule <C-n> --as real|not-a-conflict --why "<reason>" [--by <name>]`;

const command: Command = {
  name: 'conflicts',
  summary: 'Find and show contradictions between promises',
  usage: USAGE,
  async run(ctx0) {
    const ctx = dressed(withVideo(ctx0), 'conflicts'); // --video / JURATOR_VIDEO=1: 100 columns, short paths and shas
    const args = parseArgs(ctx.argv, { flags: ['find', 'json'], values: ['scripted', 'rule', 'as', 'why', 'by'] }, USAGE);
    const { store } = await openWorkspace(ctx);
    const ruleId = one(args, 'rule');
    if (ruleId !== undefined) {
      const as = one(args, 'as');
      if (as !== 'real' && as !== 'not-a-conflict') {
        ctx.err(`Say how you rule with --as real or --as not-a-conflict. Usage: ${USAGE}`);
        return 2;
      }
      const by = one(args, 'by') ?? ctx.env.JURATOR_USER ?? ctx.env.USER ?? 'unknown';
      const ruled = await ruleConflict(store, ruleId, as, { by, why: one(args, 'why') ?? '', at: ctx.now().toISOString() });
      if (args.flags.has('json')) json(ctx, ruled);
      else {
        ctx.out(`${ruled.id} ruled ${as === 'real' ? 'real' : 'not a conflict'} by ${by}: ${ruled.ruling?.why ?? ''}`);
        ctx.out(as === 'real' ? `Next: change one of the sources so they agree, then ${BRAND.command} compile` : `Next: ${BRAND.command} rule propose --all`);
      }
      return 0;
    }
    const config = await store.readConfig();
    ctx.setWorkspace(workspaceLabel(store.repoRoot, config));
    const promises = await store.readPromises();
    let contradictions = await store.readContradictions();
    let cost: number | null = null;
    let stats: ContradictionStats | null = null;
    if (args.flags.has('find')) {
      // The program compares typed facets with no AI; a model (when set) reads only the pairs it could not decide.
      const model = modelFor(ctx, config, one(args, 'scripted'));
      const found = await findContradictions(promises, contradictions, model);
      contradictions = found.contradictions;
      stats = found.stats;
      cost = found.usage.reduce((n, u) => n + u.usd, 0);
      await store.writeContradictions(contradictions);
    }
    if (args.flags.has('json')) {
      json(ctx, contradictions);
      return 0;
    }
    const byId = new Map(promises.map((p) => [p.id, p]));
    const open = contradictions.filter((c) => c.status === 'open');
    if (!contradictions.length) {
      ctx.out('No conflicts between promises.');
    } else {
      ctx.out(`${ctx.style.bold('Conflicts')}: ${contradictions.length} (${open.length} open)`);
      for (const c of contradictions) for (const line of conflictLines(ctx, c, byId, config)) ctx.out(line);
    }
    if (stats) {
      const structured = contradictions.filter((c) => c.foundBy === 'structured' && c.status !== 'not-a-conflict').length;
      ctx.out(ctx.style.dim(conflictCheckLine(stats, structured)));
    }
    if (cost !== null) ctx.out(`Cost: ${money(cost)}`);
    if (open.length) {
      ctx.out(`Next: change one of the sources so they agree, then ${BRAND.command} compile (or rule: ${BRAND.command} conflicts --rule ${open[0]?.id} --as real --why "...")`);
    }
    else ctx.out(`Next: ${BRAND.command} rule propose --all`);
    return 0;
  },
};
export default command;
