import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publicError } from '../core/errors.js';
import { writeBundle } from '../io/write-bundle.js';
import type { ModelProvider } from '../providers/model-provider.js';
import { ScriptedCancellationProvider } from '../providers/scripted-cancellation.js';
import { renderCancellationHtml } from '../reports/cancellation-html.js';
import { createCancellationClient } from './client.js';
import { investigateCancellation, type CancellationInvestigation } from './investigate.js';
import { applyCancellationRecipe } from './recipe.js';
import {
  createCancellationCase,
  cancellationRepairEligibility,
  verifyCancellationCase,
  type CancellationCase,
  type CancellationExecution,
} from './report.js';
import { CANCELLATION_EXPERIMENT_IDS, type CancellationCapture } from './schemas.js';
import {
  cancellationServiceRevision,
  cancellationServiceSources,
  prepareCancellationService,
  runCancellationExperiment,
  type CancellationFixtureMode,
} from './target.js';

/** The operator selects the authored arrangement; labels never enter model inputs. */
export async function runCancellationWorkflow(
  options: {
    readonly mode?: CancellationFixtureMode;
    readonly providerFactory?: () => ModelProvider;
    readonly repair?: boolean;
    readonly signal?: AbortSignal;
  } = {},
): Promise<CancellationCase> {
  const directory = await mkdtemp(join(tmpdir(), 'investigator-work-revocation-'));
  try {
    const repairRequested = options.repair !== false;
    const execution: CancellationExecution = {
      repairRequested,
      cancelled: options.signal?.aborted ?? false,
      baselineErrors: [],
      retestErrors: [],
      repairError: null,
    };
    const executionError = (error: unknown) => {
      const safe = options.signal?.aborted
        ? {
            code: 'RUN_ABORTED',
            message: 'Execution was cancelled; known observations were retained.',
          }
        : publicError(error);
      return {
        code: safe.code.slice(0, 160) || 'EXECUTION_FAILED',
        message: safe.message.slice(0, 2048) || 'The operation did not complete.',
      };
    };
    await prepareCancellationService(directory, options.mode ?? 'cached-worker');
    const beforeSources = await cancellationServiceSources(directory);
    const investigate = async () => {
      const client = createCancellationClient(await cancellationServiceSources(directory));
      return investigateCancellation({
        context: client.context,
        evidence: client.evidence,
        subjectRevision: await cancellationServiceRevision(directory),
        provider: options.providerFactory?.() ?? new ScriptedCancellationProvider(),
        runExperiment: (experimentId, signal) =>
          runCancellationExperiment({ directory, experimentId, signal }),
        ...(options.signal ? { signal: options.signal } : {}),
      });
    };
    const completeSuite = async (
      run: CancellationInvestigation,
      errors: CancellationExecution['baselineErrors'],
    ): Promise<CancellationCapture[]> => {
      const captures = [...run.captures];
      if (run.status === 'completed')
        for (const experimentId of CANCELLATION_EXPERIMENT_IDS) {
          if (options.signal?.aborted) {
            execution.cancelled = true;
            break;
          }
          if (!captures.some((capture) => capture.experimentId === experimentId)) {
            try {
              captures.push(
                await runCancellationExperiment({
                  directory,
                  experimentId,
                  ...(options.signal ? { signal: options.signal } : {}),
                }),
              );
            } catch (error) {
              errors.push({ experimentId, ...executionError(error) });
              execution.cancelled ||= options.signal?.aborted ?? false;
              break;
            }
          }
        }
      return captures;
    };
    const before = await investigate();
    const baseline = await completeSuite(before, execution.baselineErrors);
    let change: CancellationCase['change'] = null,
      after: CancellationCase['after'] = null,
      afterSources: CancellationCase['afterSources'] = null;
    let retest: CancellationCapture[] = [];
    if (
      repairRequested &&
      !options.signal?.aborted &&
      cancellationRepairEligibility(before, baseline, beforeSources).status === 'applied'
    ) {
      try {
        const proposal = await applyCancellationRecipe(directory);
        const changedSources = await cancellationServiceSources(directory);
        const afterInvestigation = await investigate();
        change = proposal;
        afterSources = changedSources;
        after = afterInvestigation;
        retest = await completeSuite(after, execution.retestErrors);
      } catch (error) {
        execution.repairError = executionError(error);
        execution.cancelled ||= options.signal?.aborted ?? false;
        change = null;
        afterSources = null;
        after = null;
        retest = [];
      }
    }
    execution.cancelled ||= options.signal?.aborted ?? false;
    return createCancellationCase({
      before,
      baseline,
      beforeSources,
      change,
      after,
      retest,
      afterSources,
      repairRequested,
      execution,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function writeCancellationBundle(
  directory: string,
  input: CancellationCase,
): Promise<void> {
  const report = verifyCancellationCase(input);
  await writeBundle(
    directory,
    {
      unavailable: 'Choose an available new cancellation-case directory.',
      failed: 'The cancellation case could not be written.',
    },
    () => {
      const files: Record<string, string> = {
        'case.json': `${JSON.stringify(report, null, 2)}\n`,
        'before.json': `${JSON.stringify(report.before, null, 2)}\n`,
        'report.html': renderCancellationHtml(report),
      };
      if (report.after) files['after.json'] = `${JSON.stringify(report.after, null, 2)}\n`;
      if (report.change) files['repair.diff'] = report.change.diff;
      return files;
    },
  );
}
