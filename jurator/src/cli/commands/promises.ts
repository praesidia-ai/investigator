// Owner: WP-P. jurator promises: list promises, optionally those that apply to some files.
import type { Command } from '../context.js';
import type { PromiseRecord } from '../../contracts.js';
import { parseArgs } from '../../policy/args.js';
import { json, openWorkspace, quoteDisplay, sourceRank, where } from '../../policy/cli.js';
import { byPromiseId } from '../../policy/compile.js';
import { facetsLine } from '../../policy/facets.js';
import { promisesFor, repoPath } from '../../policy/flows.js';
import { BRAND } from '../../brand.js';
import { dressed, fancy, workspaceLabel } from '../../render/screen.js';
import { shortIdsFor } from '../../explain/index.js';

const USAGE = `${BRAND.command} promises [--for <file>...] [--all] [--json]`;

const command: Command = {
  name: 'promises',
  summary: 'List promises (optionally those that apply to files)',
  usage: USAGE,
  async run(ctx0) {
    const ctx = dressed(ctx0, 'promises');
    const args = parseArgs(ctx.argv, { flags: ['json', 'all'], lists: ['for'] }, USAGE);
    const { root, store } = await openWorkspace(ctx);
    const config = await store.readConfig();
    ctx.setWorkspace(workspaceLabel(root, config));
    // Order: the order of sources in config (the order people added them), then by number.
    const rank = (id: string) => sourceRank(config, id);
    let list: PromiseRecord[] = (await store.readPromises()).sort((a, b) => rank(a.id) - rank(b.id) || byPromiseId(a, b));
    if (!args.flags.has('all')) list = list.filter((p) => p.status !== 'retired');
    const files = (args.values.get('for') ?? []).map((f) => repoPath(root, ctx.cwd, f));
    if (files.length) list = promisesFor(list, files, config.codeScope);
    if (args.flags.has('json')) {
      json(ctx, list);
      return 0;
    }
    const s = ctx.style;
    if (!list.length) {
      ctx.out(files.length ? `No promises apply to ${files.join(', ')}.` : 'No promises yet.');
      ctx.out(files.length ? `Next: ${BRAND.command} promises` : `Next: ${BRAND.command} compile`);
      return 0;
    }
    const width = Math.max(...list.map((p) => p.id.length));
    const status = (p: PromiseRecord) =>
      p.status === 'accepted' ? s.green('accepted') : p.status === 'draft' ? s.yellow('draft   ') : s.dim('retired ');
    if (files.length) ctx.out(`Promises that apply to ${files.join(', ')}:`);
    // HZ-1: screens show a long source alias short (doc.09); say so once per promise, in the new look only.
    const ids = fancy(ctx0) ? shortIdsFor(list) : null;
    for (const p of list) {
      ctx.out(`${s.bold(p.id.padEnd(width))}  ${status(p)}  ${p.kind.padEnd(8)} ${p.checkable.padEnd(7)}  ${p.wording}`);
      const alias = ids && ids.short(p.id) !== p.id ? `  shown as ${ids.short(p.id)}` : '';
      const scope = (p.scope.length ? `  scope ${p.scope.join(', ')}` : '') + alias;
      ctx.out(`${' '.repeat(width)}  ${s.dim(`${quoteDisplay(p)}  ${where(config, p)}${scope}`)}`);
      if (p.facets) ctx.out(`${' '.repeat(width)}  ${s.dim(`typed: ${facetsLine(p.facets)}`)}`);
    }
    const counts = ['accepted', 'draft', 'retired']
      .map((st) => [st, list.filter((p) => p.status === st).length] as const)
      .filter(([, n]) => n > 0)
      .map(([st, n]) => `${n} ${st}`);
    ctx.out(`${list.length} promise${list.length === 1 ? '' : 's'}: ${counts.join(' · ')}`);
    const drafts = list.filter((p) => p.status === 'draft');
    if (drafts.length) ctx.out(`Next: ${BRAND.command} accept ${drafts.length === 1 ? drafts[0]?.id : '--all'}`);
    else ctx.out(`Next: ${BRAND.command} rule propose --all`);
    return 0;
  },
};
export default command;
