// Owner: WP-P. jurator accept: a person accepts draft promises (only accepted promises are checked).
import type { Command } from '../context.js';
import { parseArgs } from '../../policy/args.js';
import { json, openWorkspace } from '../../policy/cli.js';
import { acceptPromises } from '../../policy/flows.js';
import { BRAND } from '../../brand.js';
import { dressed, workspaceLabel } from '../../render/screen.js';
import { idRange } from '../../ui/text.js';

const USAGE = `${BRAND.command} accept <id>... | --all [--json]`;

const plural = (n: number): string => `${n} promise${n === 1 ? '' : 's'}`;

const command: Command = {
  name: 'accept',
  summary: 'Accept draft promises',
  usage: USAGE,
  async run(ctx0) {
    // R5-B: the new look (header, Next arrow) like promises and conflicts; ids as a compact range, not 32 on one line.
    const ctx = dressed(ctx0, 'accept');
    const args = parseArgs(ctx.argv, { flags: ['all', 'json'] }, USAGE);
    if (!args.flags.has('all') && !args.positionals.length) {
      ctx.err(`Name the promises to accept. Usage: ${USAGE}`);
      return 2;
    }
    const { root, store } = await openWorkspace(ctx);
    ctx.setWorkspace(workspaceLabel(root, await store.readConfig()));
    const result = await acceptPromises(store, args.positionals, args.flags.has('all'));
    if (args.flags.has('json')) {
      json(ctx, result);
      return 0;
    }
    if (result.accepted.length) ctx.out(`${ctx.style.green(`Accepted ${plural(result.accepted.length)}`)}: ${idRange(result.accepted)}`);
    if (result.already.length) ctx.out(`Already accepted: ${plural(result.already.length)}: ${idRange(result.already)}`);
    if (!result.accepted.length && !result.already.length) ctx.out('No draft promises to accept.');
    ctx.out(`Next: ${BRAND.command} rule propose --all`);
    return 0;
  },
};
export default command;
