import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CliOutput } from '../cli.js';
import { InvestigatorError } from '../core/errors.js';
import { INTEROP_PROFILES } from './profiles.js';
import { readAdapterConfig, runInteropRequest } from './run.js';
import { InteropError } from './schema.js';
import { verifyInterop } from './verify.js';

interface Options {
  readonly json?: boolean | undefined;
  readonly out?: string | undefined;
  readonly request?: string | undefined;
  readonly 'adapter-config'?: string | undefined;
  readonly [k: string]: unknown;
}
const bad = (message: string) => new InvestigatorError('INVALID_ARGUMENTS', message);
async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    throw new InvestigatorError('SOURCE_UNAVAILABLE', 'The selected JSON file is not readable.');
  }
}
const wrap = <T>(f: () => T): T => {
  try {
    return f();
  } catch (e) {
    if (e instanceof InteropError) throw new InvestigatorError(e.code, e.message);
    throw e;
  }
};

/** interop-run, verify-interop, interop-profiles. Returns undefined for other commands. */
export async function runInteropCli(o: {
  command: string;
  positionals: readonly string[];
  values: Options;
  io: CliOutput;
  signal?: AbortSignal;
}): Promise<number | undefined> {
  const { command, positionals, values, io } = o;
  if (!['interop-run', 'verify-interop', 'interop-profiles'].includes(command)) {
    if (values.request !== undefined || values['adapter-config'] !== undefined)
      throw bad('--request and --adapter-config are only available for interop commands.');
    return undefined;
  }
  const stray = Object.keys(values).filter(
    (k) => !['json', 'out', 'request', 'adapter-config'].includes(k),
  );
  if (stray.length) throw bad('Unsupported option for an interop command.');
  if (command === 'interop-profiles') {
    if (positionals.length !== 1 || values.out || values.request || values['adapter-config'])
      throw bad('interop-profiles accepts only --json.');
    io.stdout(
      values.json
        ? `${JSON.stringify(INTEROP_PROFILES, null, 2)}\n`
        : `${INTEROP_PROFILES.map((p) => `${p.id} v${p.version} requirements ${p.requirementsDigest}`).join('\n')}\n`,
    );
    return 0;
  }
  if (command === 'verify-interop') {
    if (positionals.length !== 2 || !positionals[1] || values.out || values['adapter-config'])
      throw bad('Use verify-interop <result.json> [--request request.json] [--json].');
    const result = await readJson(positionals[1]);
    const request = values.request ? await readJson(values.request) : undefined;
    const v = wrap(() => verifyInterop(result, request));
    io.stdout(
      values.json
        ? `${JSON.stringify(v, null, 2)}\n`
        : `Integrity: ${v.integrity}\nRequest binding: ${v.requestBinding}\nExecution: ${v.execution}\nBehavioral: ${v.behavioral ?? 'none'}\nMismatch: ${v.mismatch?.kind ?? 'none'}\nAuthorship: not established\n`,
    );
    return 0;
  }
  if (
    positionals.length !== 2 ||
    !positionals[1] ||
    !values['adapter-config'] ||
    !values.out ||
    values.request
  )
    throw bad(
      'Use interop-run <request.json> --adapter-config <file> --out <new-directory> [--json].',
    );
  const request = await readJson(positionals[1]);
  const adapter = await wrap(() => readAdapterConfig(values['adapter-config']!)).catch(
    (e: unknown) => {
      throw e instanceof InteropError ? new InvestigatorError(e.code, e.message) : e;
    },
  );
  const result = await runInteropRequest({
    request,
    adapter,
    ...(o.signal ? { signal: o.signal } : {}),
  }).catch((e: unknown) => {
    throw e instanceof InteropError ? new InvestigatorError(e.code, e.message) : e;
  });
  await mkdir(values.out, { mode: 0o700 }).catch(() => {
    throw new InvestigatorError('OUTPUT_UNAVAILABLE', 'Choose an available new output directory.');
  });
  await writeFile(join(values.out, 'result.json'), `${JSON.stringify(result, null, 2)}\n`, {
    flag: 'wx',
    mode: 0o600,
  });
  io.stdout(
    values.json
      ? `${JSON.stringify(result, null, 2)}\n`
      : `Execution: ${result.execution.status}\nBehavioral: ${result.behavioral.verdict ?? 'none'}\nCode check (unchanged): ${result.static.level}/${result.static.verdict}\nMismatch: ${result.mismatch?.kind ?? 'none'}\nSaved ${join(values.out, 'result.json')}\n`,
  );
  return result.execution.status === 'completed' && result.behavioral.verdict === 'supported'
    ? 0
    : result.execution.status === 'completed' && result.behavioral.verdict === 'contradicted'
      ? 1
      : 2;
}
