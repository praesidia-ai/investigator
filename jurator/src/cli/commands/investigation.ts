// Owner: P1 bridge. `jurator investigation export|import|verify`: hand an accepted promise to Investigator as data,
// bring the behavioral result back as a linked record that stays separate from the code check.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { BRAND } from '../../brand.js';
import { InteropError, buildRecord, buildRequest, canonicalJson, parseRequest, sha256Text, verifyRecord } from '../../investigations/index.js';
import { JuratorError } from '../../util/errors.js';
import { prettyJson } from '../../util/json.js';
import { findRepoRoot, listRuns, openStore } from '../../workspace/index.js';
import type { Command, CommandContext } from '../context.js';

const USAGE = [
  `${BRAND.command} investigation export <promiseId> --run <id> --mapping <reviewed.json> --tenant <t> --workflow <w> --env <e> --window <start>..<end> --adapter <id> (--adapter-config <file> | --adapter-digest <sha256>) --out <request.json> [--scope <text>] [--max-turns n] [--max-tool-calls n] [--max-seconds n] [--context-file f] [--evidence-file f] [--json]`,
  `${BRAND.command} investigation import <result.json> [--request <request.json>] [--json]`,
  `${BRAND.command} investigation verify <id|record.json> [--json]`,
].join('\n  ');

const OPTIONS = {
  json: { type: 'boolean' },
  run: { type: 'string' },
  mapping: { type: 'string' },
  tenant: { type: 'string' },
  workflow: { type: 'string' },
  env: { type: 'string' },
  window: { type: 'string' },
  adapter: { type: 'string' },
  'adapter-config': { type: 'string' },
  'adapter-digest': { type: 'string' },
  scope: { type: 'string' },
  'max-turns': { type: 'string' },
  'max-tool-calls': { type: 'string' },
  'max-seconds': { type: 'string' },
  'context-file': { type: 'string' },
  'evidence-file': { type: 'string' },
  out: { type: 'string' },
  request: { type: 'string' },
} as const;

const bad = (message: string) => new JuratorError('BAD_INPUT', `${message}\nUsage:\n  ${USAGE}`);
async function readJson(ctx: CommandContext, path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(resolve(ctx.cwd, path), 'utf8'));
  } catch {
    throw new JuratorError('BAD_INPUT', `Could not read ${path} as JSON.`);
  }
}
const num = (v: string | undefined, d: number, name: string): number => {
  if (v === undefined) return d;
  if (!/^[0-9]+$/u.test(v)) throw bad(`--${name} needs a whole number.`);
  return Number(v);
};

const command: Command = {
  name: 'investigation',
  summary: 'Hand a promise to Investigator as data and link its behavioral result back',
  usage: USAGE,
  async run(ctx) {
    let parsed;
    try {
      parsed = parseArgs({ args: [...ctx.argv], options: OPTIONS, allowPositionals: true, strict: true });
    } catch (e) {
      throw bad(e instanceof Error ? e.message : String(e));
    }
    const { values: v, positionals } = parsed;
    const [sub, arg] = positionals;
    if (!sub || !arg || positionals.length !== 2 || !['export', 'import', 'verify'].includes(sub)) throw bad('Choose export, import or verify, with one argument.');
    const root = await findRepoRoot(ctx.cwd);
    const store = openStore(root);
    if (!(await store.exists())) throw new JuratorError('NO_WORKSPACE', `No ${BRAND.folder}/ folder in this repo. Run ${BRAND.command} init first.`);
    const dir = join(store.dir, 'investigations');
    const requests = join(store.dir, 'local', 'investigations', 'requests');
    const promises = await store.readPromises();
    const s = ctx.style;
    const locks = await store.readLock();
    const currentOf = async (id: string | undefined) => {
      const promise = promises.find((p) => p.id === id);
      return { promise, lockSha256: locks.find((l) => l.alias === promise?.quote.alias)?.sha256 };
    };

    if (sub === 'export') {
      const need = (k: keyof typeof OPTIONS): string => {
        const value = v[k];
        if (typeof value !== 'string') throw bad(`--${k} is required.`);
        return value;
      };
      const promise = promises.find((p) => p.id === arg);
      if (!promise) throw new JuratorError('PROMISE_NOT_FOUND', `No promise ${arg}. Run ${BRAND.command} promises.`);
      const run = (await listRuns(store)).find((r) => r.id === need('run'));
      if (!run) throw new JuratorError('RUN_NOT_FOUND', `No saved run ${need('run')}. Run ${BRAND.command} check first.`);
      const [start, end] = need('window').split('..');
      if (!start || !end) throw bad('--window needs <start>..<end> (ISO times).');
      let configurationDigest = v['adapter-digest'];
      if (v['adapter-config']) configurationDigest = sha256Text(canonicalJson(await readJson(ctx, v['adapter-config'])));
      if (!configurationDigest) throw bad('Give --adapter-config <file> or --adapter-digest <sha256>.');
      const hashFile = async (f: string | undefined) => (f ? sha256Text(await readFile(resolve(ctx.cwd, f), 'utf8')) : undefined);
      const lock = (await store.readLock()).find((l) => l.alias === promise.quote.alias);
      const sourceText = lock ? await store.readSourceText(lock) : '';
      const contextDigest = await hashFile(v['context-file']);
      const evidenceDigest = await hashFile(v['evidence-file']);
      const request = buildRequest({
        promise,
        run,
        lock,
        sourceText,
        mapping: await readJson(ctx, need('mapping')),
        tenant: need('tenant'),
        workflow: need('workflow'),
        environment: need('env'),
        window: { start, end },
        adapter: { id: need('adapter'), configurationDigest },
        scope: v.scope ?? 'Isolated authored workload for the mapped profile only.',
        budget: { maxModelTurns: num(v['max-turns'], 8, 'max-turns'), maxToolCalls: num(v['max-tool-calls'], 12, 'max-tool-calls'), maxRuntimeSeconds: num(v['max-seconds'], 120, 'max-seconds') },
        ...(contextDigest ? { contextDigest } : {}),
        ...(evidenceDigest ? { evidenceDigest } : {}),
        now: ctx.now(),
      });
      const out = resolve(ctx.cwd, need('out'));
      await mkdir(dirname(out), { recursive: true });
      await writeFile(out, prettyJson(request), { flag: 'wx' }).catch(() => {
        throw new JuratorError('OUTPUT_UNAVAILABLE', `${need('out')} already exists or cannot be written. Choose a new file.`);
      });
      await mkdir(requests, { recursive: true });
      await writeFile(join(requests, `${request.digest}.json`), prettyJson(request));
      if (v.json) ctx.out(JSON.stringify(request, null, 2));
      else {
        ctx.out(`${s.green('Exported')} ${request.promise.id} (code check: ${request.trigger.codeCheck.level}/${request.trigger.codeCheck.verdict}) to ${need('out')}`);
        ctx.out(`Request ${request.digest.slice(0, 12)}. It is data, not permission: the operator's adapter config authorizes any run.`);
        ctx.out(`Next: run praesidia-investigator interop-run ${need('out')} --adapter-config <file> --out <new-dir>, then ${BRAND.command} investigation import <new-dir>/result.json`);
      }
      return 0;
    }

    if (sub === 'import') {
      const resultRaw = await readJson(ctx, arg);
      const digest = (resultRaw as { requestDigest?: unknown } | null)?.requestDigest;
      let requestRaw: unknown;
      if (v.request) requestRaw = await readJson(ctx, v.request);
      else if (typeof digest === 'string' && /^[0-9a-f]{64}$/u.test(digest)) requestRaw = await readJson(ctx, join(requests, `${digest}.json`)).catch(() => {
        throw new JuratorError('REQUEST_NOT_FOUND', `No saved request ${digest.slice(0, 12)} on this machine. Pass --request <request.json>.`);
      });
      else throw new JuratorError('INVALID_DOCUMENT', 'The result has no requestDigest.');
      const request = (() => {
        try {
          return parseRequest(requestRaw);
        } catch (e) {
          throw e instanceof InteropError ? new JuratorError(e.code, e.message) : e;
        }
      })();
      const record = buildRecord({ requestRaw, resultRaw, current: await currentOf(request.promise.id), now: ctx.now() });
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, `${record.id}.json`), prettyJson(record));
      if (v.json) ctx.out(JSON.stringify(record, null, 2));
      else {
        ctx.out(`${s.green('Imported')} ${record.id}`);
        ctx.out(`  Code check:  ${record.codeCheck.level} / ${record.codeCheck.verdict}`);
        ctx.out(`  Behavioral:  ${record.behavioral.execution}${record.behavioral.verdict ? ` / ${record.behavioral.verdict}` : ''}`);
        if (record.mismatch) ctx.out(`  ${s.red('Mismatch')}: ${record.mismatch.explanation} Both results are kept.`);
        ctx.out(`Next: ${BRAND.command} investigation verify ${record.id}`);
      }
      return record.behavioral.verdict === 'contradicted' ? 1 : 0;
    }

    const file = arg.endsWith('.json') ? resolve(ctx.cwd, arg) : join(dir, `${arg}.json`);
    const raw = await readJson(ctx, file);
    const id = (raw as { promiseId?: string } | null)?.promiseId;
    const report = verifyRecord(raw, await currentOf(id));
    if (v.json) ctx.out(JSON.stringify(report, null, 2));
    else {
      ctx.out(report.ok ? `${s.green('✓')} Verified ${arg}: digests, policy source hash, exact quote and request binding match. Authorship not established (records are unsigned).` : `${s.red('✗')} Not verified: ${report.problems.length} problem${report.problems.length === 1 ? '' : 's'}.`);
      for (const p of report.problems) ctx.out(`  - ${p}`);
      for (const n of report.notes) ctx.out(s.dim(n));
      if (!report.ok) ctx.out(`Next: ${BRAND.command} investigation export ${id ?? '<promiseId>'} ... to start a fresh investigation.`);
    }
    return report.ok ? 0 : 1;
  },
};
export default command;
