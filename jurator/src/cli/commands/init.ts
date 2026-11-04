// Owner: WP-W (workspace mode: R4-WS). `jurator init`: create .jurator/ and find the repo's policies. In a folder that
// holds several git repos (or with --repo name=path), it makes a multi-repo workspace: the folder becomes its own git
// repo for .jurator/ and policies/, the code repos stay separate, and every code path is prefixed with its repo name.
import { resolve } from 'node:path';
import { DEFAULT_CONFIG, type PolicySourceConfig } from '../../contracts.js';
import { CONNECTOR_IDS } from '../../connectors/index.js';
import type { RepoRef } from '../../git/index.js';
import { JuratorError } from '../../util/errors.js';
import { findRepoRoot, initWorkspace, openStore } from '../../workspace/index.js';
import { detectSources, parseSourceFlag } from '../../workspace/detect.js';
import { detectWorkspaceRepos, inspectRepos, parseRepoFlag, prepareWorkspaceRoot, type RepoInfo } from '../../workspace/multi.js';
import type { Command, CommandContext } from '../context.js';
import { BRAND } from '../../brand.js';
import { dressed } from '../../render/screen.js';
import { basename } from 'node:path';

const command: Command = {
  name: 'init',
  summary: `Create ${BRAND.folder}/ in this repo (or a folder of repos) and find your policies`,
  usage: `${BRAND.command} init [--source alias=connector:locator]... [--repo name=path]... [--json]`,
  async run(ctx0) {
    const ctx = dressed(ctx0, 'init');
    ctx.setWorkspace(basename(resolve(ctx.cwd)));
    let json = false;
    const overrides: PolicySourceConfig[] = [];
    const repoFlags: RepoRef[] = [];
    const args = [...ctx.argv];
    while (args.length > 0) {
      const arg = args.shift() as string;
      if (arg === '--json') json = true;
      else if (arg === '--source' || arg.startsWith('--source=')) {
        const value = arg === '--source' ? args.shift() : arg.slice('--source='.length);
        if (!value) throw new JuratorError('BAD_ARGS', '--source needs a value: alias=connector:locator.');
        overrides.push(parseSourceFlag(value, CONNECTOR_IDS));
      } else if (arg === '--repo' || arg.startsWith('--repo=')) {
        const value = arg === '--repo' ? args.shift() : arg.slice('--repo='.length);
        if (!value) throw new JuratorError('BAD_ARGS', '--repo needs a value: name=path.');
        repoFlags.push(parseRepoFlag(value));
      } else throw new JuratorError('BAD_ARGS', `Unknown option "${arg}". Usage: ${command.usage}`);
    }
    const aliases = overrides.map((s) => s.alias);
    const dup = aliases.find((a, i) => aliases.indexOf(a) !== i);
    if (dup) throw new JuratorError('BAD_ARGS', `Alias "${dup}" is used twice.`);
    const names = repoFlags.map((r) => r.name);
    const dupRepo = names.find((n, i) => names.indexOf(n) !== i);
    if (dupRepo) throw new JuratorError('BAD_ARGS', `Repo "${dupRepo}" is given twice.`);

    const repos = repoFlags.length > 0 ? repoFlags : await detectWorkspaceRepos(ctx.cwd);
    if (repos.length > 0) return initMulti(ctx, resolve(ctx.cwd), repos, overrides, repoFlags.length === 0, json);

    const root = await findRepoRoot(ctx.cwd);
    const sources = overrides.length > 0 ? overrides : await detectSources(root);
    const store = await initWorkspace(root, { ...DEFAULT_CONFIG, sources });
    // FX-4: init infers the code scope from the repo's layout; say what it chose, so a wrong guess is seen early.
    const codeScope = (await store.readConfig()).codeScope;
    const next = sources.length > 0 ? `${BRAND.command} compile` : `${BRAND.command} add <policy file>`;

    if (json) {
      ctx.out(JSON.stringify({ dir: store.dir, detected: overrides.length === 0, sources, codeScope, next }, null, 2));
      return 0;
    }
    ctx.out(`Created ${ctx.style.bold(`${BRAND.folder}/`)} in ${root}`);
    printSources(ctx, sources, overrides.length > 0);
    ctx.out(`Code scope: ${codeScope.join(', ')} ${ctx.style.dim(`(change it in ${BRAND.folder}/config.json)`)}`);
    ctx.out(`Next: ${next}`);
    return 0;
  },
};

function printSources(ctx: CommandContext, sources: readonly PolicySourceConfig[], given: boolean): void {
  if (sources.length === 0) {
    ctx.out('No policy files found (looked for privacy, security, gdpr and similar .md/.mdx files, and policies/*.json).');
    return;
  }
  ctx.out(`${given ? 'Using' : 'Found'} ${sources.length} ${sources.length === 1 ? 'policy' : 'policies'}:`);
  const width = Math.max(...sources.map((s) => s.alias.length));
  for (const s of sources) ctx.out(`  ${ctx.style.bold(s.alias.padEnd(width))}  ${ctx.style.dim(`${s.connector}:`)}${s.locator}`);
}

/** Workspace mode: one .jurator/ at the folder root for several code repos. */
async function initMulti(
  ctx: CommandContext,
  root: string,
  repos: readonly RepoRef[],
  overrides: readonly PolicySourceConfig[],
  detectedRepos: boolean,
  json: boolean,
): Promise<number> {
  // Check every repo before writing anything.
  if (await openStore(root).exists()) {
    throw new JuratorError('WORKSPACE_EXISTS', `${BRAND.folder}/config.json already exists in ${root}. Nothing changed.`);
  }
  const infos: RepoInfo[] = await inspectRepos(root, repos);
  const sources =
    overrides.length > 0
      ? [...overrides]
      : await detectSources(root, { skipDirs: repos.map((r) => r.path.replace(/^\.\//u, '').replace(/\/$/u, '')), policiesFolder: true });
  const codeScope = infos.flatMap((r) => r.codeScope);
  const config = { ...DEFAULT_CONFIG, sources, codeScope, repos: repos.map((r) => ({ name: r.name, path: r.path })) };
  const prepared = await prepareWorkspaceRoot(root, repos);
  const store = await initWorkspace(root, config);
  const next = sources.length > 0 ? `${BRAND.command} compile` : `${BRAND.command} add <policy file>`;

  if (json) {
    ctx.out(
      JSON.stringify(
        {
          dir: store.dir,
          detected: overrides.length === 0,
          sources,
          codeScope,
          workspace: {
            root,
            detectedRepos,
            gitInit: prepared.gitInit,
            gitignoreAdded: prepared.ignored,
            repos: infos.map((r) => ({ name: r.name, path: r.path, branch: r.branch, commit: r.commit, files: r.files, codeScope: r.codeScope })),
          },
          next,
        },
        null,
        2,
      ),
    );
    return 0;
  }
  const s = ctx.style;
  ctx.out(`Created ${s.bold(`${BRAND.folder}/`)} in ${root} ${s.dim(`(workspace · ${infos.length} ${infos.length === 1 ? 'repo' : 'repos'})`)}`);
  if (prepared.gitInit) ctx.out(`Made ${root} a git repo for ${BRAND.folder}/ and policies/ ${s.dim('(the code repos stay separate)')}`);
  if (prepared.ignored.length > 0) ctx.out(`Listed the code repos in .gitignore: ${prepared.ignored.join(' ')}`);
  ctx.out(`Repos (${infos.length}):`);
  const width = Math.max(...infos.map((r) => r.name.length));
  for (const r of infos) {
    ctx.out(`  ${s.bold(r.name.padEnd(width))}  ${r.branch ?? 'detached'}@${r.commit.slice(0, 7)}  ${s.dim(`${r.files} files`)}`);
  }
  printSources(ctx, sources, overrides.length > 0);
  ctx.out(`Code scope: ${codeScope.join(', ')} ${s.dim(`(change it in ${BRAND.folder}/config.json)`)}`);
  ctx.out(`Paths are prefixed with the repo name, e.g. ${(infos[0] as RepoInfo).name}/... in promises, rules and reports.`);
  ctx.out(`Next: ${next}`);
  return 0;
}

export default command;
