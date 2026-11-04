// Owner: WP-K. `jurator verify <run.json>`: no AI; recomputes the digest and re-reads every code quote from git.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { verifyRun } from '../../check/index.js';
import type { CheckRun, GitRepo, Store } from '../../contracts.js';
import { openRepo } from '../../git/index.js';
import { findRepoRoot, openStore } from '../../workspace/index.js';
import type { Command } from '../context.js';
import { BRAND } from '../../brand.js';

const USAGE = `${BRAND.command} verify <run.json> [--json]`;

const command: Command = {
  name: 'verify',
  summary: 'Re-check a saved run’s digest and quotes, and re-run its rules, with no AI',
  usage: USAGE,
  async run(ctx) {
    let parsed;
    try {
      parsed = parseArgs({
        args: [...ctx.argv],
        options: { json: { type: 'boolean' } },
        allowPositionals: true,
        strict: true,
      });
    } catch (error) {
      ctx.err(`${error instanceof Error ? error.message : String(error)}\nUsage: ${USAGE}`);
      return 2;
    }
    const file = parsed.positionals[0];
    if (!file) {
      ctx.err(`Which run? Usage: ${USAGE}`);
      return 2;
    }
    let run: CheckRun;
    try {
      run = JSON.parse(await readFile(resolve(ctx.cwd, file), 'utf8')) as CheckRun;
    } catch (error) {
      ctx.err(`Could not read ${file} as JSON: ${error instanceof Error ? error.message : String(error)}`);
      return 2;
    }
    let repo: GitRepo | null = null;
    let store: Store | null = null;
    try {
      const root = await findRepoRoot(ctx.cwd);
      repo = await openRepo(root);
      store = openStore(root);
      if (!(await store.exists())) store = null;
    } catch {
      repo = null;
    }
    // FX-1: verify also re-runs the record's rules at its commit (rules from git there, else this workspace).
    const report = await verifyRun(run, repo, { store });
    if (parsed.values.json) {
      ctx.out(JSON.stringify(report, null, 2));
      return report.ok ? 0 : 1;
    }
    const s = ctx.style;
    if (report.ok) {
      ctx.out(`${s.green('✓')} Verified ${run.id}: digest matches; ${report.checkedQuotes} code quote${report.checkedQuotes === 1 ? '' : 's'} match git; the rules give the same outcomes.`);
    } else {
      ctx.out(`${s.red('✗')} Not verified: ${report.problems.length} problem${report.problems.length === 1 ? '' : 's'}.`);
      for (const p of report.problems) ctx.out(`  - ${p}`);
    }
    for (const n of report.notes) ctx.out(s.dim(n));
    if (!report.ok) ctx.out(`Next: run ${BRAND.command} check again to get a fresh record.`);
    return report.ok ? 0 : 1;
  },
};
export default command;
