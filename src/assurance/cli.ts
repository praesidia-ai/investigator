import { writeFile } from 'node:fs/promises';
import type { CliOutput } from '../cli.js';
import { loadMcpExport } from '../context/load-mcp.js';
import { InvestigatorError } from '../core/errors.js';
import { parseJson } from '../core/parse.js';
import { decodeUtf8, readBoundedFile } from '../io/read-file.js';
import { createMetaProvider } from '../providers/meta-config.js';
import { createAssuranceCheckpoint } from './checkpoint.js';
import { createAssuranceChangeReport, verifyAssuranceChangeReport } from './report.js';
import {
  runAssuranceDemo,
  verifyAssuranceDemo,
  writeAssuranceBundle,
  writeAssuranceDemo,
} from './workflow.js';

interface AssuranceCliOptions {
  readonly out?: string | undefined;
  readonly json?: boolean | undefined;
  readonly live?: boolean | undefined;
  readonly variant?: string | undefined;
  readonly against?: string | undefined;
  readonly format?: string | undefined;
  readonly cases?: string | undefined;
}
const COMMANDS = new Set([
  'import-mcp',
  'checkpoint',
  'assurance-diff',
  'assurance-demo',
  'verify-assurance',
]);
async function readJson(path: string): Promise<unknown> {
  return parseJson(decodeUtf8(await readBoundedFile(path, 20_971_520)), 'INVALID_ASSURANCE_INPUT');
}
async function saveJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, {
    flag: 'wx',
    mode: 0o600,
    encoding: 'utf8',
  }).catch(() => {
    throw new InvestigatorError(
      'OUTPUT_UNAVAILABLE',
      'Choose an available new snapshot output file.',
    );
  });
}

/** Separate read-only source/assurance commands from ordinary control investigations. */
export async function runAssuranceCli(options: {
  readonly command: string;
  readonly positionals: readonly string[];
  readonly values: AssuranceCliOptions;
  readonly env: NodeJS.ProcessEnv;
  readonly io: CliOutput;
  readonly signal?: AbortSignal;
}): Promise<number | undefined> {
  const { command, positionals, values, io } = options;
  if (!COMMANDS.has(command)) return undefined;
  const required = command === 'assurance-demo' ? 1 : command === 'assurance-diff' ? 3 : 2;
  if (
    positionals.length !== required ||
    values.variant ||
    values.against ||
    values.format ||
    values.cases ||
    (command !== 'assurance-demo' && values.live) ||
    (command === 'verify-assurance' && values.out)
  )
    throw new InvestigatorError(
      'INVALID_ARGUMENTS',
      'Use the documented import-mcp, checkpoint, assurance-diff, assurance-demo or verify-assurance arguments.',
    );
  if (command === 'import-mcp') {
    const imported = await loadMcpExport(positionals[1]!);
    if (values.out) await saveJson(values.out, imported);
    io.stdout(
      values.json
        ? `${JSON.stringify(imported, null, 2)}\n`
        : `Imported tools: ${imported.dependencies.length}\nSource coverage: partial; selected saved export only\nRuntime permissions and effects: not established\n`,
    );
    return 0;
  }
  if (command === 'checkpoint') {
    const checkpoint = createAssuranceCheckpoint(await readJson(positionals[1]!));
    if (values.out) await saveJson(values.out, checkpoint);
    io.stdout(
      values.json
        ? `${JSON.stringify(checkpoint, null, 2)}\n`
        : `Historical checkpoint: ${checkpoint.contract.checks.length} checks\nDependencies: ${checkpoint.inventory.dependencies.length}\nScope: ${checkpoint.inventory.scope.workflowRef}\nCurrent behavior: not assessed\n`,
    );
    return 0;
  }
  if (command === 'assurance-diff') {
    const report = createAssuranceChangeReport(
      await readJson(positionals[1]!),
      await readJson(positionals[2]!),
    );
    if (values.out) await writeAssuranceBundle(values.out, report);
    io.stdout(
      values.json
        ? `${JSON.stringify(report, null, 2)}\n`
        : `${report.investigation.checks.map((check) => `${check.id}: historical ${check.historicalVerdict}; ${check.validity}; ${check.requiredAction}`).join('\n')}\nRetest: ${report.retestStatus}\nCurrent behavioral verdict: not established by comparison\n`,
    );
    return report.investigation.retestPlan.blocked
      ? 2
      : report.investigation.checks.some((check) => check.validity === 'stale')
        ? 1
        : 0;
  }
  if (command === 'verify-assurance') {
    const input = await readJson(positionals[1]!);
    if (
      input &&
      typeof input === 'object' &&
      'format' in input &&
      input.format === 'investigator-assurance-demo-v1'
    )
      verifyAssuranceDemo(input);
    else verifyAssuranceChangeReport(input);
    const result = {
      integrity: 'consistent-with-supplied-records',
      authenticity: 'not-established',
      execution: 'not-reexecuted',
    };
    io.stdout(
      values.json
        ? `${JSON.stringify(result)}\n`
        : 'Change records consistent. Authorship not established; recorded workload not reexecuted.\n',
    );
    return 0;
  }
  const demo = await runAssuranceDemo({
    ...(values.live ? { provider: createMetaProvider(options.env) } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (values.out) await writeAssuranceDemo(values.out, demo);
  io.stdout(
    values.json
      ? `${JSON.stringify(demo, null, 2)}\n`
      : `Planning: ${demo.checkpoint.evidencePlan.planning.provider.mode}\nHistorical supported finding preserved\n${demo.cases.map((item) => `${item.id}: ${item.report.retestStatus}${item.report.retest ? `; fresh result ${item.report.retest.assessment.verdict}` : ''}`).join('\n')}\nComparison never renews a current behavioral verdict.\n`,
  );
  return 0;
}
