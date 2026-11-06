// Owner: X-FRONTEND. `jurator report [<run.json>] [--out jurator-report.html]`: one self-contained HTML page.
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { BRAND } from '../../brand.js';
import { displayPath, loadReportInput, renderReport } from '../../report/index.js';
import { runToSarif } from '../../report/sarif.js';
import { JuratorError } from '../../util/errors.js';
import { findRepoRoot, openStore } from '../../workspace/index.js';
import type { Command } from '../context.js';

const DEFAULT_OUT = `${BRAND.command}-report.html`;
const USAGE = `${BRAND.command} report [<run.json>] [--format html|sarif] [--out ${DEFAULT_OUT}] [--json]`;

const command: Command = {
  name: 'report',
  summary: 'Write an HTML report: promises, rules, the last check and the promise graph',
  usage: USAGE,
  async run(ctx) {
    let parsed;
    try {
      parsed = parseArgs({
        args: [...ctx.argv],
        options: { out: { type: 'string', short: 'o' }, json: { type: 'boolean' }, format: { type: 'string' } },
        allowPositionals: true,
        strict: true,
      });
    } catch (error) {
      ctx.err(`${error instanceof Error ? error.message : String(error)}\nUsage: ${USAGE}`);
      return 2;
    }
    if (parsed.positionals.length > 1) {
      ctx.err(`One run at a time. Usage: ${USAGE}`);
      return 2;
    }
    const format = parsed.values.format ?? 'html';
    if (format !== 'html' && format !== 'sarif') {
      ctx.err(`Unknown format ${JSON.stringify(format)}. Usage: ${USAGE}`);
      return 2;
    }
    try {
      const root = await findRepoRoot(ctx.cwd);
      const store = openStore(root);
      if (!(await store.exists())) {
        ctx.err(`No ${BRAND.folder}/ folder in this repo yet.\nNext: ${BRAND.command} init`);
        return 2;
      }
      const runArg = parsed.positionals[0];
      const input = await loadReportInput(store, {
        ...(runArg ? { runPath: resolve(ctx.cwd, runArg) } : {}),
        now: ctx.now,
      });
      if (format === 'sarif' && !input.run) {
        ctx.err(`No check run to export.\nNext: ${BRAND.command} check`);
        return 2;
      }
      const out = resolve(ctx.cwd, parsed.values.out ?? (format === 'sarif' ? `${BRAND.command}.sarif` : DEFAULT_OUT));
      await mkdir(dirname(out), { recursive: true });
      await writeFile(out, format === 'sarif' ? `${JSON.stringify(runToSarif(input.run!), null, 2)}\n` : renderReport(input), 'utf8');
      const shown = displayPath(out, ctx.cwd);
      if (parsed.values.json) {
        ctx.out(JSON.stringify({ out, run: input.run?.id ?? null, promises: input.promises.length, rules: input.rules.length }, null, 2));
        return 0;
      }
      const runNote = input.run ? `run ${input.run.id}` : 'no check run yet';
      ctx.out(`${ctx.style.green('✓')} Wrote ${shown}: ${input.promises.length} promises, ${input.rules.length} rules, ${runNote}.`);
      ctx.out(input.run ? `Next: open ${shown}` : `Next: ${BRAND.command} check, then ${BRAND.command} report again.`);
      return 0;
    } catch (error) {
      if (error instanceof JuratorError) {
        ctx.err(`${error.code}: ${error.message}`);
        return 2;
      }
      throw error;
    }
  },
};
export default command;
