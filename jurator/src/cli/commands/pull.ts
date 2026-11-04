// Owner: WP-W. `jurator pull`: fetch every policy source read-only and update the lock.
import { makeConnectorContext, pullSources } from '../../connectors/index.js';
import { JuratorError } from '../../util/errors.js';
import { findRepoRoot, openStore } from '../../workspace/index.js';
import type { Command } from '../context.js';
import { BRAND } from '../../brand.js';

const command: Command = {
  name: 'pull',
  summary: 'Fetch every policy source read-only and update the lock',
  usage: `${BRAND.command} pull [--check] [--json]`,
  async run(ctx) {
    let check = false;
    let json = false;
    for (const arg of ctx.argv) {
      if (arg === '--check') check = true;
      else if (arg === '--json') json = true;
      else throw new JuratorError('BAD_ARGS', `Unknown option "${arg}". Usage: ${command.usage}`);
    }
    const root = await findRepoRoot(ctx.cwd);
    const store = openStore(root);
    if (!(await store.exists())) {
      throw new JuratorError('NO_WORKSPACE', `No ${BRAND.folder}/ in ${root}. Run ${BRAND.command} init first.`);
    }
    const result = await pullSources(store, makeConnectorContext(root, ctx.env, ctx.now), !check);
    const changed = new Set(result.changed);
    const code = check && changed.size > 0 ? 1 : 0;
    const next =
      changed.size === 0
        ? `${BRAND.command} check`
        : check
          ? `${BRAND.command} pull, then ${BRAND.command} compile`
          : `${BRAND.command} compile`;

    if (json) {
      ctx.out(
        JSON.stringify(
          {
            check,
            changed: result.changed,
            sources: result.docs.map((d) => ({
              alias: d.alias,
              connector: d.connector,
              locator: d.locator,
              sha256: d.sha256,
              upstreamVersion: d.upstreamVersion ?? null,
              changed: changed.has(d.alias),
            })),
            next,
          },
          null,
          2,
        ),
      );
      return code;
    }
    if (result.docs.length === 0) {
      ctx.out(`No sources in ${BRAND.folder}/config.json.`);
      ctx.out(`Next: ${BRAND.command} add <policy file>`);
      return 0;
    }
    const width = Math.max(...result.docs.map((d) => d.alias.length));
    for (const d of result.docs) {
      const version = d.upstreamVersion !== undefined ? ` v${d.upstreamVersion}` : '';
      const mark = changed.has(d.alias) ? ctx.style.yellow('changed') : ctx.style.dim('unchanged');
      ctx.out(`  ${ctx.style.bold(d.alias.padEnd(width))}  ${d.sha256.slice(0, 8)}${version}  ${mark}  ${ctx.style.dim(`${d.connector}:${d.locator}`)}`);
    }
    if (check) {
      ctx.out(
        changed.size > 0
          ? ctx.style.red(`Policy text changed since the last pull: ${result.changed.join(', ')}.`)
          : ctx.style.green('Every policy matches the lock.'),
      );
    } else {
      ctx.out(changed.size > 0 ? `Saved ${changed.size} changed ${changed.size === 1 ? 'source' : 'sources'} to ${BRAND.folder}/.` : 'Nothing changed.');
    }
    ctx.out(`Next: ${next}`);
    return code;
  },
};
export default command;
