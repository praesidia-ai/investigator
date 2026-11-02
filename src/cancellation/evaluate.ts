import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { InvestigatorError } from '../core/errors.js';
import { jsonDigest, stableJson, type JsonValue } from '../core/json.js';
import { parseInput } from '../core/parse.js';
import type { ModelProvider } from '../providers/model-provider.js';
import { renderCancellationHtml } from '../reports/cancellation-html.js';
import { CACHED_WORKER_SOURCE, CURRENT_WORKER_SOURCE, BLOCKED_WORKER_SOURCE } from './recipe.js';
import { cancellationCaseSchema, verifyCancellationCase, type CancellationCase } from './report.js';
import { cancellationFixtureModeSchema } from './target.js';
import { runCancellationWorkflow } from './workflow.js';

const ARRANGEMENTS = [
  { id: 'trial-01', mode: 'cached-worker', expected: 'contradicted' },
  { id: 'trial-02', mode: 'current-worker', expected: 'supported' },
  { id: 'trial-03', mode: 'capture-gap', expected: 'insufficient_evidence' },
  { id: 'trial-04', mode: 'block-all', expected: 'contradicted' },
] as const;
const verdict = z.enum(['supported', 'contradicted', 'insufficient_evidence']);
export const cancellationTrialsSchema = z
  .object({
    format: z.literal('investigator-cancellation-trials-v1'),
    mode: z.enum(['live-authored-concealed-variant-trials', 'scripted-engineering-regression']),
    requestedCases: z.number().int().min(1).max(4),
    cancelled: z.boolean(),
    cases: z
      .array(
        z
          .object({
            id: z.string().min(1).max(160),
            operatorMode: cancellationFixtureModeSchema,
            expectedVerdict: verdict,
            report: cancellationCaseSchema,
            groundedConclusionCorrect: z.boolean(),
            unsupportedConclusion: z.boolean(),
          })
          .strict(),
      )
      .max(4),
    totals: z
      .object({
        executed: z.number().int().min(0).max(4),
        correct: z.number().int().min(0).max(4),
        unsupportedConclusions: z.number().int().min(0).max(4),
        knownInputTokens: z.number().int().nonnegative().safe(),
        knownOutputTokens: z.number().int().nonnegative().safe(),
        usageComplete: z.boolean(),
      })
      .strict(),
    limitations: z.array(z.string().min(1).max(2048)).min(1).max(16),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type CancellationTrials = z.infer<typeof cancellationTrialsSchema>;

function score(report: CancellationCase, expected: (typeof ARRANGEMENTS)[number]['expected']) {
  const observedMissingBoundary =
    report.before.captures.length > 0 &&
    report.before.captures.every(
      (capture) =>
        capture.cut === null &&
        capture.observation.status === 'partial' &&
        capture.observation.windowClosed,
    );
  return {
    groundedConclusionCorrect:
      report.before.status === 'completed' &&
      report.before.validation.accepted &&
      report.before.finding?.verdict === expected &&
      (expected !== 'insufficient_evidence' || observedMissingBoundary),
    unsupportedConclusion:
      report.before.proposedFinding !== null &&
      report.before.proposedFinding.verdict !== 'insufficient_evidence' &&
      !report.before.validation.accepted,
  };
}
function totals(cases: CancellationTrials['cases']) {
  return {
    executed: cases.length,
    correct: cases.filter((item) => item.groundedConclusionCorrect).length,
    unsupportedConclusions: cases.filter((item) => item.unsupportedConclusion).length,
    knownInputTokens: cases.reduce(
      (sum, item) => sum + item.report.before.usage.knownInputTokens,
      0,
    ),
    knownOutputTokens: cases.reduce(
      (sum, item) => sum + item.report.before.usage.knownOutputTokens,
      0,
    ),
    usageComplete: cases.every((item) => item.report.before.usage.complete),
  };
}

/** Expected labels and operator selection remain outside every model request. */
export async function evaluateCancellation(
  options: {
    readonly maxCases?: number;
    readonly providerFactory?: () => ModelProvider;
    readonly signal?: AbortSignal;
  } = {},
): Promise<CancellationTrials> {
  const count = options.maxCases ?? 3;
  if (!Number.isInteger(count) || count < 1 || count > 4)
    throw new InvestigatorError(
      'INVALID_ARGUMENTS',
      'Select one to four authored cancellation arrangements.',
    );
  const cases: CancellationTrials['cases'] = [];
  for (const arrangement of ARRANGEMENTS.slice(0, count)) {
    if (options.signal?.aborted) break;
    const report = await runCancellationWorkflow({
      mode: arrangement.mode,
      repair: false,
      ...(options.providerFactory ? { providerFactory: options.providerFactory } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    cases.push({
      id: arrangement.id,
      operatorMode: arrangement.mode,
      expectedVerdict: arrangement.expected,
      report,
      ...score(report, arrangement.expected),
    });
  }
  const body = {
    format: 'investigator-cancellation-trials-v1' as const,
    mode: cases.some((item) => item.report.before.provider.mode === 'live')
      ? ('live-authored-concealed-variant-trials' as const)
      : ('scripted-engineering-regression' as const),
    requestedCases: count,
    cancelled: options.signal?.aborted ?? false,
    cases,
    totals: totals(cases),
    limitations: [
      'These are authored arrangements with labels concealed from model inputs, not an independent held-out customer benchmark or a general accuracy estimate.',
      'Scripted reference success validates the execution, grounding and uncertainty contracts; only explicit live mode measures this selected model on these authored cases.',
      'Source code is available as selected evidence. Operator modes, expected verdicts and capture configuration are not supplied to the model.',
      'Reported token counts are known usage only; no monetary cost, production safety or market superiority is established.',
    ],
  };
  return verifyCancellationTrials({ ...body, digest: jsonDigest(body as unknown as JsonValue) });
}

export function verifyCancellationTrials(input: unknown): CancellationTrials {
  const report = parseInput(
    cancellationTrialsSchema,
    input,
    'INVALID_CANCELLATION_TRIALS',
    'Cancellation trial results',
  );
  if (
    report.cases.length > report.requestedCases ||
    (!report.cancelled && report.cases.length !== report.requestedCases)
  )
    throw new InvestigatorError(
      'INVALID_CANCELLATION_TRIALS',
      'The requested authored arrangements are incomplete.',
    );
  for (let index = 0; index < report.cases.length; index += 1) {
    const trial = report.cases[index]!,
      arrangement = ARRANGEMENTS[index]!;
    verifyCancellationCase(trial.report);
    const expectedSource =
      trial.operatorMode === 'current-worker'
        ? CURRENT_WORKER_SOURCE
        : trial.operatorMode === 'block-all'
          ? BLOCKED_WORKER_SOURCE
          : CACHED_WORKER_SOURCE;
    if (
      trial.id !== arrangement.id ||
      trial.operatorMode !== arrangement.mode ||
      trial.expectedVerdict !== arrangement.expected ||
      trial.report.change ||
      trial.report.beforeSources['worker-authority.mjs'] !== expectedSource ||
      trial.report.baseline.some((capture) =>
        trial.operatorMode === 'capture-gap'
          ? capture.cut !== null ||
            capture.observation.status !== 'partial' ||
            !capture.observation.windowClosed
          : capture.cut === null ||
            capture.observation.status !== 'complete' ||
            !capture.observation.windowClosed,
      ) ||
      JSON.stringify(score(trial.report, trial.expectedVerdict)) !==
        JSON.stringify({
          groundedConclusionCorrect: trial.groundedConclusionCorrect,
          unsupportedConclusion: trial.unsupportedConclusion,
        })
    )
      throw new InvestigatorError(
        'INVALID_CANCELLATION_TRIALS',
        'Trial labels, source arrangements or scores do not match their supplied cases.',
      );
  }
  const modes = new Set(report.cases.map((item) => item.report.before.provider.mode));
  if (
    modes.size > 1 ||
    (modes.has('live')
      ? 'live-authored-concealed-variant-trials'
      : 'scripted-engineering-regression') !== report.mode
  )
    throw new InvestigatorError(
      'INVALID_CANCELLATION_TRIALS',
      'Live and scripted evidence cannot be conflated.',
    );
  const { digest, ...body } = report;
  if (
    stableJson(totals(report.cases)) !== stableJson(report.totals) ||
    digest !== jsonDigest(body as unknown as JsonValue)
  )
    throw new InvestigatorError(
      'INVALID_CANCELLATION_TRIALS',
      'Trial totals do not match the recorded evidence.',
    );
  return report;
}

export async function writeCancellationTrials(
  directory: string,
  input: CancellationTrials,
): Promise<void> {
  const report = verifyCancellationTrials(input);
  await mkdir(directory, { mode: 0o700 }).catch(() => {
    throw new InvestigatorError(
      'OUTPUT_UNAVAILABLE',
      'Choose an available new trial-results directory.',
    );
  });
  try {
    await writeFile(join(directory, 'trials.json'), `${JSON.stringify(report, null, 2)}\n`, {
      mode: 0o600,
      flag: 'wx',
    });
    for (const trial of report.cases) {
      await writeFile(
        join(directory, `${trial.id}.json`),
        `${JSON.stringify(trial.report, null, 2)}\n`,
        { mode: 0o600, flag: 'wx' },
      );
      await writeFile(join(directory, `${trial.id}.html`), renderCancellationHtml(trial.report), {
        mode: 0o600,
        flag: 'wx',
      });
    }
  } catch {
    await rm(directory, { recursive: true, force: true });
    throw new InvestigatorError(
      'OUTPUT_UNAVAILABLE',
      'The authored trial results could not be saved.',
    );
  }
}
