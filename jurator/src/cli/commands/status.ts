// Owner: WP-W (coverage line: WP-K2, verified pair: WP-C). `jurator status`: coverage by rules, sources, promises,
// rules, the last check, and the last verified (code commit, policy state) pair.
import { lastVerified, policyStateOf, withEffectiveScope } from '../../cache/index.js';
import { readInfeasible, terminalWidth } from '../../check/local.js';
import type { CodeSnapshot } from '../../contracts.js';
import { isWorkspaceRepo, openRepo } from '../../git/index.js';
import { JuratorError } from '../../util/errors.js';
import { findRepoRoot, listRuns, openStore } from '../../workspace/index.js';
import type { Command } from '../context.js';
import { BRAND } from '../../brand.js';
import { dressed, workspaceLabel } from '../../render/screen.js';

const command: Command = {
  name: 'status',
  summary: 'Show sources, promises, rules and the last check',
  usage: `${BRAND.command} status [--json]`,
  async run(ctx0) {
    const ctx = dressed(ctx0, 'status');
    let json = false;
    for (const arg of ctx.argv) {
      if (arg === '--json') json = true;
      else throw new JuratorError('BAD_ARGS', `Unknown option "${arg}". Usage: ${command.usage}`);
    }
    const root = await findRepoRoot(ctx.cwd);
    const store = openStore(root);
    if (!(await store.exists())) {
      throw new JuratorError('NO_WORKSPACE', `No ${BRAND.folder}/ in ${root}. Run ${BRAND.command} init first.`);
    }
    const [config, lock, promises, rules, contradictions, runs] = await Promise.all([
      store.readConfig(),
      store.readLock(),
      store.readPromises(),
      store.readRules(),
      store.readContradictions(),
      listRuns(store),
    ]);
    ctx.setWorkspace(workspaceLabel(root, config));
    const lockBy = new Map(lock.map((e) => [e.alias, e]));
    const sources = config.sources.map((s) => {
      const e = lockBy.get(s.alias);
      return {
        alias: s.alias,
        connector: s.connector,
        locator: s.locator,
        sha256: e?.sha256 ?? null,
        upstreamVersion: e?.upstreamVersion ?? null,
        fetchedAt: e?.fetchedAt ?? null,
        promises: promises.filter((p) => p.id.startsWith(`${s.alias}.`) && p.status !== 'retired').length,
      };
    });
    const count = (status: string) => promises.filter((p) => p.status === status).length;
    const promiseCounts = { total: promises.length, accepted: count('accepted'), draft: count('draft'), retired: count('retired') };
    const ruleCounts = {
      total: rules.length,
      accepted: rules.filter((r) => r.status === 'accepted').length,
      proposed: rules.filter((r) => r.status === 'proposed').length,
    };
    const codePromises = promises.filter((p) => p.status === 'accepted' && p.checkable === 'code');
    const ruled = new Set(rules.filter((r) => r.status === 'accepted').map((r) => r.promiseId));
    const coverage = { covered: codePromises.filter((p) => ruled.has(p.id)).length, codePromises: codePromises.length };
    const infeasible = new Set(await readInfeasible(store.dir));
    const uncovered = codePromises
      .filter((p) => !ruled.has(p.id))
      .map((p) => ({ id: p.id, noRulePossible: infeasible.has(p.id) }))
      .sort((a, b) => a.id.localeCompare(b.id));
    const openConflicts = contradictions.filter((c) => c.status === 'open').length;
    const last = runs.at(-1) ?? null;
    // The verified pair (WP-C): what the next check can skip.
    const policyState = policyStateOf(
      withEffectiveScope(promises.filter((p) => p.status === 'accepted'), config.codeScope),
      rules,
    );
    const pair = await lastVerified(store);
    let headCommit: string | null = null;
    // R4-WS: a multi-repo workspace shows each repo's branch and commit; HEAD is the composite commit.
    let workspace: { repos: NonNullable<CodeSnapshot['repos']> } | null = null;
    try {
      const repo = await openRepo(root);
      if (isWorkspaceRepo(repo)) {
        const snap = await repo.snapshot();
        headCommit = snap.commit;
        workspace = { repos: snap.repos ?? [] };
      } else headCommit = await repo.resolve('HEAD');
    } catch {
      headCommit = null;
    }
    const verified = pair
      ? {
          ...pair,
          codeChanged: headCommit === null ? null : headCommit !== pair.commit,
          policiesChanged: pair.policyState !== policyState,
        }
      : null;

    let next: string;
    if (config.sources.length === 0) next = `${BRAND.command} add <policy file>`;
    else if (promises.length === 0) next = `${BRAND.command} compile`;
    else if (promiseCounts.draft > 0) next = `${BRAND.command} promises, then ${BRAND.command} accept <id>... or --all`;
    else if (openConflicts > 0) next = `${BRAND.command} conflicts`;
    else if (uncovered.some((u) => !u.noRulePossible)) next = `${BRAND.command} rule propose --all`;
    else if (ruleCounts.proposed > 0) next = `${BRAND.command} rule accept --all`;
    else next = `${BRAND.command} check`;

    if (json) {
      ctx.out(
        JSON.stringify(
          {
            repoRoot: root,
            ...(workspace ? { workspace } : {}),
            failMode: config.failMode,
            sources,
            promises: promiseCounts,
            contradictions: { total: contradictions.length, open: openConflicts },
            rules: ruleCounts,
            coverage,
            uncovered,
            lastRun: last
              ? { id: last.id, createdAt: last.createdAt, status: last.status, snapshot: last.snapshot, summary: last.summary }
              : null,
            policyState,
            verified,
            next,
          },
          null,
          2,
        ),
      );
      return 0;
    }

    const s = ctx.style;
    const termW = terminalWidth();
    ctx.out(`${s.bold(BRAND.name)} in ${root} ${s.dim(`(${workspace ? `workspace · ${workspace.repos.length} repos · ` : ''}fail mode: ${config.failMode})`)}`);
    if (workspace) {
      const w = Math.max(0, ...workspace.repos.map((r) => r.name.length));
      for (const r of workspace.repos) {
        ctx.out(`  ${s.bold(r.name.padEnd(w))}  ${r.branch ?? 'detached'}@${r.commit.slice(0, 7)}${r.dirty ? s.yellow(' (uncommitted changes)') : ''}`);
      }
    }
    ctx.out('');
    const cells = Math.min(coverage.codePromises, 20);
    const filled = coverage.codePromises === 0 ? 0 : Math.round((coverage.covered / coverage.codePromises) * cells);
    const bar = cells > 0 ? `  ${s.green('█'.repeat(filled))}${s.dim('░'.repeat(cells - filled))}` : '';
    ctx.out(`${s.bold(`Covered by rules: ${coverage.covered} of ${coverage.codePromises} code promises`)}${bar}`);
    ctx.out('');
    ctx.out(s.bold(`Sources (${sources.length})`));
    if (sources.length === 0) ctx.out('  none yet');
    const width = Math.max(0, ...sources.map((x) => x.alias.length));
    for (const x of sources) {
      const pulled = x.sha256
        ? `${x.sha256.slice(0, 8)}${x.upstreamVersion ? ` v${x.upstreamVersion}` : ''}`
        : s.yellow('not pulled yet');
      ctx.out(`  ${s.bold(x.alias.padEnd(width))}  ${pulled}  ${x.promises} promises  ${s.dim(`${x.connector}:${x.locator}`)}`);
    }
    ctx.out('');
    ctx.out(
      `Promises:  ${promiseCounts.total} (${promiseCounts.accepted} accepted, ${promiseCounts.draft} draft, ${promiseCounts.retired} retired)`,
    );
    ctx.out(`Conflicts: ${openConflicts > 0 ? s.yellow(`${openConflicts} open`) : '0 open'} of ${contradictions.length}`);
    ctx.out(`Rules:     ${ruleCounts.total} (${ruleCounts.accepted} accepted, ${ruleCounts.proposed} proposed)`);
    ctx.out(`Coverage:  ${coverage.covered} of ${coverage.codePromises} code promises covered by rules`);
    // The promises still on AI reads, wrapped under the line above.
    const lead = '           on AI reads:';
    let line = lead;
    for (const [i, u] of uncovered.entries()) {
      const item = ` ${u.noRulePossible ? `${u.id} (no rule possible)` : u.id}${i < uncovered.length - 1 ? ',' : ''}`;
      if (line.length + item.length + 1 > termW && line.trim().length > 0) {
        ctx.out(s.dim(line));
        line = ' '.repeat(lead.length);
      }
      line += item;
    }
    if (uncovered.length > 0) ctx.out(s.dim(line));
    if (last) {
      const where = `${last.snapshot.branch ?? 'detached'}@${last.snapshot.commit.slice(0, 7)}${last.snapshot.dirty ? ' (dirty)' : ''}`;
      const sum = last.summary;
      const broken = sum.broken + sum.looksBroken;
      const limited = last.results.filter((r) => r.verdict === 'holds' && (r.assurance?.openCounterexamples ?? 0) > 0).length;
      const verdicts = `${sum.holds - limited} hold${limited > 0 ? `, ${limited} hold with known misses (limited)` : ''}, ${sum.broken} broken, ${sum.looksKept} look kept, ${sum.looksBroken} look broken, ${sum.cantTell} can't tell`;
      ctx.out(`Last check: ${last.id} at ${last.createdAt} on ${where}: ${last.status}; ${broken > 0 ? s.red(verdicts) : verdicts}`);
    } else {
      ctx.out(`Last check: ${s.dim('none yet')}`);
    }
    if (verified) {
      const what =
        verified.codeChanged === false && !verified.policiesChanged
          ? 'code and policies unchanged since: nothing to recheck'
          : [
              verified.codeChanged ? `code changed since (HEAD ${headCommit?.slice(0, 7) ?? '?'})` : null,
              verified.policiesChanged ? `policies changed since (now ${policyState.slice(0, 7)})` : null,
            ]
              .filter((x): x is string => x !== null)
              .join(', ') || 'code unknown';
      ctx.out(
        `Verified:  code ${verified.commit.slice(0, 7)} + policies ${verified.policyState.slice(0, 7)} ${s.dim(`(run ${verified.runId})`)}; ${what}`,
      );
    } else {
      ctx.out(`Verified:  ${s.dim('no completed check yet')}`);
    }
    ctx.out(`Next: ${next}`);
    return 0;
  },
};
export default command;
