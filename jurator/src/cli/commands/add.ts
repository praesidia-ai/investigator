// Owner: WP-P. jurator add: add a policy file as a source, or one promise sentence to the local source.
import type { Command } from '../context.js';
import { one, parseArgs } from '../../policy/args.js';
import { json, openWorkspace } from '../../policy/cli.js';
import { addFileSource, addLocalPromise } from '../../policy/flows.js';
import { BRAND } from '../../brand.js';

const USAGE = `${BRAND.command} add <file> [--alias name] | ${BRAND.command} add --promise "sentence"`;

const command: Command = {
  name: 'add',
  summary: 'Add a policy source (a file) or a single promise',
  usage: USAGE,
  async run(ctx) {
    const args = parseArgs(ctx.argv, { flags: ['json'], values: ['alias', 'promise'] }, USAGE);
    const sentence = one(args, 'promise');
    const file = args.positionals[0];
    if ((sentence === undefined) === (file === undefined) || args.positionals.length > 1) {
      ctx.err(`Give one file or one --promise. Usage: ${USAGE}`);
      return 2;
    }
    const { store } = await openWorkspace(ctx);
    if (sentence !== undefined) {
      const result = await addLocalPromise(store, sentence);
      if (args.flags.has('json')) json(ctx, result);
      else {
        ctx.out(result.added ? `Added to your local promises (${result.path}).` : `Already in ${result.path}.`);
        ctx.out(`Next: ${BRAND.command} compile`);
      }
      return 0;
    }
    const result = await addFileSource(store, ctx.cwd, file as string, one(args, 'alias'));
    if (args.flags.has('json')) json(ctx, result);
    else {
      const { alias, connector, locator } = result.source;
      ctx.out(result.already ? `${locator} is already a source (${alias}).` : `Added ${ctx.style.bold(alias)} (${connector}: ${locator}).`);
      ctx.out(`Next: ${BRAND.command} compile`);
    }
    return 0;
  },
};
export default command;
