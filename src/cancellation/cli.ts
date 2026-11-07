import type { CliOutput } from '../cli.js';
import { printRecordsConsistent } from '../io/verify-output.js';
import { InvestigatorError } from '../core/errors.js';
import { parseInput, parseJson } from '../core/parse.js';
import { decodeUtf8, readBoundedFile } from '../io/read-file.js';
import { createMetaProvider } from '../providers/meta-config.js';
import {
  evaluateCancellation,
  verifyCancellationTrials,
  writeCancellationTrials,
} from './evaluate.js';
import { verifyCancellationCase } from './report.js';
import { showCancellationCase } from './show.js';
import { cancellationFixtureModeSchema } from './target.js';
import { runCancellationWorkflow, writeCancellationBundle } from './workflow.js';

interface Options {
  readonly json?: boolean | undefined;
  readonly out?: string | undefined;
  readonly live?: boolean | undefined;
  readonly variant?: string | undefined;
  readonly cases?: string | undefined;
  readonly against?: string | undefined;
  readonly format?: string | undefined;
}
export async function runCancellationCli(options: {
  command: string;
  positionals: readonly string[];
  values: Options;
  env: NodeJS.ProcessEnv;
  io: CliOutput;
  signal?: AbortSignal;
}): Promise<number | undefined> {
  const { command, positionals, values, io } = options;
  if (
    !['cancellation-demo', 'cancellation-trials', 'verify-cancellation', 'show'].includes(command)
  )
    return undefined;
  if (command === 'show') {
    if (positionals.length !== 2 || Object.keys(values).length)
      throw new InvestigatorError('INVALID_ARGUMENTS', 'Use: show <case-dir-or-case.json>.');
    const color = options.env.FORCE_COLOR
      ? options.env.FORCE_COLOR !== '0'
      : !!process.stdout.isTTY;
    io.stdout(await showCancellationCase(positionals[1]!, color));
    return 0;
  }
  if (
    values.against ||
    values.format ||
    (command === 'verify-cancellation'
      ? positionals.length !== 2 || values.out || values.live || values.variant || values.cases
      : positionals.length !== 1) ||
    (command !== 'cancellation-demo' && values.variant) ||
    (command !== 'cancellation-trials' && values.cases)
  )
    throw new InvestigatorError(
      'INVALID_ARGUMENTS',
      'Use the documented cancellation-demo, cancellation-trials or verify-cancellation options.',
    );
  if (command === 'verify-cancellation') {
    const input = parseJson(
      decodeUtf8(await readBoundedFile(positionals[1]!, 20_971_520)),
      'INVALID_CANCELLATION_CASE',
    );
    if (
      input &&
      typeof input === 'object' &&
      'format' in input &&
      input.format === 'investigator-cancellation-trials-v1'
    )
      verifyCancellationTrials(input);
    else verifyCancellationCase(input);
    printRecordsConsistent(
      io,
      values.json,
      'Cancellation records consistent. Authorship not established; observations not reexecuted.\n',
    );
    return 0;
  }
  const providerFactory = values.live ? () => createMetaProvider(options.env) : undefined;
  if (providerFactory) providerFactory();
  if (command === 'cancellation-trials') {
    if (values.cases && !/^[1-4]$/.test(values.cases))
      throw new InvestigatorError(
        'INVALID_ARGUMENTS',
        'Choose one to four authored cancellation arrangements.',
      );
    const trials = await evaluateCancellation({
      ...(values.cases ? { maxCases: Number(values.cases) } : {}),
      ...(providerFactory ? { providerFactory } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (values.out) await writeCancellationTrials(values.out, trials);
    io.stdout(
      values.json
        ? `${JSON.stringify(trials, null, 2)}\n`
        : `Mode: ${trials.mode}\nAuthored arrangements: ${trials.totals.executed}/${trials.requestedCases}\nCorrect grounded conclusions: ${trials.totals.correct}\nUnsupported conclusions: ${trials.totals.unsupportedConclusions}\nThis is not an independent customer benchmark.\n`,
    );
    return trials.cancelled ||
      trials.cases.some(
        (trial) =>
          trial.report.before.status === 'failed' ||
          trial.report.execution.cancelled ||
          trial.report.execution.baselineErrors.length > 0 ||
          trial.report.execution.retestErrors.length > 0 ||
          trial.report.execution.repairError !== null,
      )
      ? 2
      : trials.totals.correct === trials.requestedCases
        ? 0
        : 1;
  }
  const mode = parseInput(
    cancellationFixtureModeSchema,
    values.variant ?? 'cached-worker',
    'INVALID_ARGUMENTS',
    'Authored arrangement',
  );
  const report = await runCancellationWorkflow({
    mode,
    ...(providerFactory ? { providerFactory } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (values.out) await writeCancellationBundle(values.out, report);
  io.stdout(
    values.json
      ? `${JSON.stringify(report, null, 2)}\n`
      : `Planning: ${report.before.provider.mode}\nBefore: ${report.before.finding?.verdict ?? 'unresolved'}\nRepair: ${report.repair.status}\nAfter: ${report.after?.finding?.verdict ?? 'not assessed'}\nIndependent work preserved: ${report.verification.independentWorkBefore && report.verification.independentWorkAfter}\nPre-revocation accepted work preserved: ${report.verification.preCutWorkPreserved}\nScope: finite authored loopback workflow\n`,
  );
  if (
    report.before.status !== 'completed' ||
    report.execution.cancelled ||
    report.execution.baselineErrors.length > 0 ||
    report.execution.retestErrors.length > 0 ||
    report.execution.repairError !== null
  )
    return 2;
  if (report.change)
    return report.after?.status === 'completed' &&
      report.verification.closedGap &&
      report.verification.unchangedWorkload &&
      report.verification.independentWorkAfter &&
      report.verification.preCutWorkPreserved &&
      report.verification.contentCanaryAbsent
      ? 0
      : 2;
  return report.before.finding?.verdict === 'supported'
    ? 0
    : report.before.finding?.verdict === 'contradicted'
      ? 1
      : 2;
}
