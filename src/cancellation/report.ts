import { z } from 'zod';
import { InvestigatorError } from '../core/errors.js';
import { jsonDigest, stableJson, type JsonValue } from '../core/json.js';
import { parseInput } from '../core/parse.js';
import {
  assessCancellationExperiment,
  assessCancellationExperiments,
  independentWorkObserved,
} from './assessment.js';
import {
  cancellationInvestigationSchema,
  verifyCancellationInvestigation,
  type CancellationInvestigation,
} from './investigate.js';
import {
  CACHED_WORKER_SOURCE,
  cancellationRecipeSchema,
  verifyCancellationRecipe,
  type CancellationServiceSources,
} from './recipe.js';
import {
  CANCELLATION_PROFILE,
  cancellationCaptureSchema,
  cancellationExperimentIdSchema,
  type CancellationCapture,
} from './schemas.js';
import { CANCELLATION_CONTENT_CANARY } from './target.js';

const sourcesSchema = z
  .object({
    'server.mjs': z.string().min(1).max(65_536),
    'worker-authority.mjs': z.string().min(1).max(65_536),
  })
  .strict();
const executionErrorSchema = z
  .object({
    code: z.string().min(1).max(160),
    message: z.string().min(1).max(2048),
  })
  .strict();
const completionErrorSchema = executionErrorSchema
  .extend({ experimentId: cancellationExperimentIdSchema })
  .strict();
export const cancellationExecutionSchema = z
  .object({
    repairRequested: z.boolean(),
    cancelled: z.boolean(),
    baselineErrors: z.array(completionErrorSchema).max(4),
    retestErrors: z.array(completionErrorSchema).max(4),
    repairError: executionErrorSchema.nullable(),
  })
  .strict();
export type CancellationExecution = z.infer<typeof cancellationExecutionSchema>;
export const cancellationCaseSchema = z
  .object({
    format: z.literal('investigator-cancellation-case-v1'),
    profileDigest: z.string().regex(/^[a-f0-9]{64}$/),
    before: cancellationInvestigationSchema,
    baseline: z.array(cancellationCaptureSchema).max(4),
    beforeSources: sourcesSchema,
    change: cancellationRecipeSchema.nullable(),
    after: cancellationInvestigationSchema.nullable(),
    retest: z.array(cancellationCaptureSchema).max(4),
    afterSources: sourcesSchema.nullable(),
    execution: cancellationExecutionSchema,
    repair: z
      .object({
        status: z.enum([
          'applied',
          'not-required',
          'not-supported',
          'pending-evidence',
          'not-requested',
          'cancelled',
          'execution-failed',
        ]),
        reason: z.string().min(1).max(2048),
      })
      .strict(),
    verification: z
      .object({
        beforeVerdict: z.enum(['supported', 'contradicted', 'insufficient_evidence']),
        afterVerdict: z.enum(['supported', 'contradicted', 'insufficient_evidence']).nullable(),
        unchangedWorkload: z.boolean(),
        independentWorkBefore: z.boolean(),
        independentWorkAfter: z.boolean(),
        preCutWorkPreserved: z.boolean(),
        closedGap: z.boolean(),
        contentCanaryAbsent: z.boolean(),
        scope: z.literal('authored-loopback-workflow'),
      })
      .strict(),
    limitations: z.array(z.string().min(1).max(2048)).min(1).max(16),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type CancellationCase = z.infer<typeof cancellationCaseSchema>;

const same = (a: unknown, b: unknown) => stableJson(a as JsonValue) === stableJson(b as JsonValue);
export function cancellationRepairEligibility(
  before: CancellationInvestigation,
  baseline: readonly CancellationCapture[],
  sources: CancellationServiceSources,
): CancellationCase['repair'] {
  const assessment = assessCancellationExperiments(baseline);
  if (
    before.status !== 'completed' ||
    !before.validation.accepted ||
    assessment.verdict === 'insufficient_evidence' ||
    baseline.length !== CANCELLATION_PROFILE.requiredExperiments.length ||
    assessment.missingExperiments.length > 0
  )
    return {
      status: 'pending-evidence',
      reason:
        'A grounded model finding and sufficient captured evidence are required before a repair.',
    };
  if (assessment.verdict === 'supported')
    return {
      status: 'not-required',
      reason:
        'The captured authored experiments support the selected control; no repair is proposed.',
    };
  if (sources['worker-authority.mjs'] !== CACHED_WORKER_SOURCE)
    return {
      status: 'not-supported',
      reason: 'The observed failure does not match the supported worker-source preimage.',
    };
  if (
    !independentWorkObserved(
      baseline.find((capture) => capture.experimentId === 'independent-root'),
    ) ||
    assessCancellationExperiment(
      baseline.find((capture) => capture.experimentId === 'accepted-before-revoke'),
    ).status !== 'PASS'
  )
    return {
      status: 'pending-evidence',
      reason:
        'Independent and pre-revocation legitimate work must be observed before changing the worker.',
    };
  if (before.finding?.nextAction !== 'check-current-root-authority.v1')
    return {
      status: 'not-requested',
      reason: 'The model did not propose the supported source-bound repair.',
    };
  return {
    status: 'applied',
    reason:
      'The grounded finding, exact cached-authority preimage and preserved legitimate work qualify for the supported worker change.',
  };
}

function repairOutcome(input: {
  before: CancellationInvestigation;
  baseline: readonly CancellationCapture[];
  beforeSources: CancellationServiceSources;
  change: CancellationCase['change'];
  execution: CancellationExecution;
}): CancellationCase['repair'] {
  const eligibility = cancellationRepairEligibility(
    input.before,
    input.baseline,
    input.beforeSources,
  );
  if (input.change) {
    if (
      eligibility.status !== 'applied' ||
      !input.execution.repairRequested ||
      input.execution.repairError
    )
      throw new InvestigatorError(
        'INVALID_CANCELLATION_CASE',
        'An applied source change requires requested, eligible execution without an unresolved repair error.',
      );
    return eligibility;
  }
  if (eligibility.status !== 'applied') {
    if (input.execution.repairError)
      throw new InvestigatorError(
        'INVALID_CANCELLATION_CASE',
        'Repair execution errors require an eligible requested repair.',
      );
    return eligibility;
  }
  if (!input.execution.repairRequested) {
    if (input.execution.repairError)
      throw new InvestigatorError(
        'INVALID_CANCELLATION_CASE',
        'An unrequested repair cannot have an execution error.',
      );
    return {
      status: 'not-requested',
      reason: 'Repair execution was not selected; the grounded finding is retained for review.',
    };
  }
  if (input.execution.repairError)
    return {
      status: 'execution-failed',
      reason:
        'The supported repair did not complete with a retained after investigation; baseline evidence remains available.',
    };
  if (input.execution.cancelled)
    return {
      status: 'cancelled',
      reason:
        'Cancellation stopped the eligible repair before a verified source change; baseline evidence remains available.',
    };
  throw new InvestigatorError(
    'INVALID_CANCELLATION_CASE',
    'An eligible requested repair needs a recorded source change, cancellation or bounded execution error.',
  );
}

function workload(captures: readonly CancellationCapture[]): string {
  return jsonDigest(
    [...captures]
      .sort((a, b) => (a.experimentId < b.experimentId ? -1 : 1))
      .map((capture) => ({
        experimentId: capture.experimentId,
        attempts: capture.attempts.map((attempt) => ({
          rootId: attempt.rootId,
          jobId: attempt.jobId,
          attemptId: attempt.attemptId,
          requestDigest: attempt.requestDigest,
        })),
      })),
  );
}

function derive(
  input: Pick<
    CancellationCase,
    'before' | 'baseline' | 'beforeSources' | 'change' | 'after' | 'retest' | 'afterSources'
  >,
) {
  const beforeAssessment = assessCancellationExperiments(input.baseline),
    afterAssessment = input.after ? assessCancellationExperiments(input.retest) : null;
  const independentBefore = input.baseline.find(
    (capture) => capture.experimentId === 'independent-root',
  );
  const independentAfter = input.retest.find(
    (capture) => capture.experimentId === 'independent-root',
  );
  const priorBefore = input.baseline.find(
    (capture) => capture.experimentId === 'accepted-before-revoke',
  );
  const priorAfter = input.retest.find(
    (capture) => capture.experimentId === 'accepted-before-revoke',
  );
  const prior = (capture: CancellationCapture | undefined) =>
    capture?.effects.map((effect) => ({
      rootId: effect.rootId,
      jobId: effect.jobId,
      requestDigest: effect.requestDigest,
    })) ?? [];
  const unchangedWorkload =
    input.after !== null &&
    input.baseline.length === 4 &&
    input.retest.length === 4 &&
    workload(input.baseline) === workload(input.retest);
  const independentWorkBefore = independentWorkObserved(independentBefore);
  const independentWorkAfter = independentWorkObserved(independentAfter);
  const preCutWorkPreserved =
    !!priorBefore &&
    !!priorAfter &&
    assessCancellationExperiment(priorBefore).status === 'PASS' &&
    assessCancellationExperiment(priorAfter).status === 'PASS' &&
    same(prior(priorBefore), prior(priorAfter));
  return {
    beforeVerdict: beforeAssessment.verdict,
    afterVerdict: afterAssessment?.verdict ?? null,
    unchangedWorkload,
    independentWorkBefore,
    independentWorkAfter,
    preCutWorkPreserved,
    closedGap:
      input.change !== null &&
      beforeAssessment.verdict === 'contradicted' &&
      afterAssessment?.verdict === 'supported' &&
      input.before.status === 'completed' &&
      input.before.validation.accepted &&
      input.before.finding?.verdict === 'contradicted' &&
      input.after?.status === 'completed' &&
      input.after.validation.accepted &&
      input.after.finding?.verdict === 'supported' &&
      unchangedWorkload &&
      independentWorkBefore &&
      independentWorkAfter &&
      preCutWorkPreserved,
    contentCanaryAbsent: !JSON.stringify(input).includes(CANCELLATION_CONTENT_CANARY),
    scope: 'authored-loopback-workflow' as const,
  };
}

export function createCancellationCase(input: {
  before: CancellationInvestigation;
  baseline: CancellationCapture[];
  beforeSources: CancellationServiceSources;
  change: CancellationCase['change'];
  after: CancellationInvestigation | null;
  retest: CancellationCapture[];
  afterSources: CancellationServiceSources | null;
  repairRequested: boolean;
  execution?: Omit<CancellationExecution, 'repairRequested'>;
}): CancellationCase {
  const execution = parseInput(
    cancellationExecutionSchema,
    {
      repairRequested: input.repairRequested,
      cancelled: input.execution?.cancelled ?? false,
      baselineErrors: input.execution?.baselineErrors ?? [],
      retestErrors: input.execution?.retestErrors ?? [],
      repairError: input.execution?.repairError ?? null,
    },
    'INVALID_CANCELLATION_CASE',
    'Execution metadata',
  );
  const repair = repairOutcome({ ...input, execution });
  const body = {
    format: 'investigator-cancellation-case-v1' as const,
    profileDigest: jsonDigest(CANCELLATION_PROFILE as unknown as JsonValue),
    before: input.before,
    baseline: input.baseline,
    beforeSources: input.beforeSources,
    change: input.change,
    after: input.after,
    retest: input.retest,
    afterSources: input.afterSources,
    execution,
    repair,
    verification: derive(input),
    limitations: [
      'The profile covers selected roots, one registered destination and finite authored sequential experiments; it does not establish global idleness, rollback, distributed atomic fencing or production compliance.',
      'Authority-read followed by a write is not a universal race-free revocation protocol. The observed boundary is the supervisor acknowledgment/acceptance sequence in this owned workflow.',
      'Source relationships are selected configured declarations; unregistered queues, callbacks and external provider operations remain outside discovery and capture.',
      'The model proposes experiments and a supported recipe. Code-owned criteria, exact source preimages and independently observed effects constrain the result.',
      'Record verification checks supplied consistency and does not authenticate the issuer or reexecute observations. Opaque model continuation and credentials are not exported.',
      ...(input.before.provider.mode === 'scripted'
        ? [
            'This is explicitly scripted orchestration with real synthetic effects, not observed live Meta reasoning.',
          ]
        : []),
    ],
  };
  return verifyCancellationCase({ ...body, digest: jsonDigest(body as unknown as JsonValue) });
}

export function verifyCancellationCase(input: unknown): CancellationCase {
  const report = parseInput(
    cancellationCaseSchema,
    input,
    'INVALID_CANCELLATION_CASE',
    'Cancellation case',
  );
  verifyCancellationInvestigation(report.before);
  const validateCompletion = (
    run: CancellationInvestigation,
    captures: readonly CancellationCapture[],
    errors: CancellationExecution['baselineErrors'],
  ) => {
    const seen = new Set<string>();
    for (const error of errors) {
      if (
        run.status !== 'completed' ||
        seen.has(error.experimentId) ||
        captures.some((capture) => capture.experimentId === error.experimentId)
      )
        throw new InvestigatorError(
          'INVALID_CANCELLATION_CASE',
          'Host completion errors must identify distinct missing experiments after a completed model run.',
        );
      seen.add(error.experimentId);
    }
    for (const capture of captures) {
      if (
        !run.captures.some((selected) => same(selected, capture)) &&
        Date.parse(capture.startedAt) < Date.parse(run.finishedAt)
      )
        throw new InvestigatorError(
          'INVALID_CANCELLATION_CASE',
          'A host-completion capture must follow its completed model investigation.',
        );
    }
  };
  validateCompletion(report.before, report.baseline, report.execution.baselineErrors);
  const beforeRevision = jsonDigest(report.beforeSources);
  if (
    beforeRevision !== report.before.subjectRevision ||
    report.baseline.some((capture) => capture.subjectRevision !== beforeRevision) ||
    report.before.evidence.find((artifact) => artifact.id === 'service-source')?.content !==
      report.beforeSources['server.mjs'] ||
    report.before.evidence.find((artifact) => artifact.id === 'worker-source')?.content !==
      report.beforeSources['worker-authority.mjs']
  )
    throw new InvestigatorError(
      'INVALID_CANCELLATION_CASE',
      'Baseline observations and saved source bytes do not describe the same selected target.',
    );
  for (const capture of report.before.captures)
    if (!report.baseline.some((saved) => same(saved, capture)))
      throw new InvestigatorError(
        'INVALID_CANCELLATION_CASE',
        'Model-selected observations cannot be replaced in the baseline validation batch.',
      );
  if (report.change) {
    const eligibility = cancellationRepairEligibility(
      report.before,
      report.baseline,
      report.beforeSources,
    );
    if (
      eligibility.status !== 'applied' ||
      !report.after ||
      !report.afterSources ||
      report.repair.status !== 'applied'
    )
      throw new InvestigatorError(
        'INVALID_CANCELLATION_CASE',
        'The repair lacks a qualified finding, retained after-case or supported source lineage.',
      );
    verifyCancellationRecipe({
      beforeSources: report.beforeSources,
      afterSources: report.afterSources,
      proposal: report.change,
    });
    verifyCancellationInvestigation(report.after);
    validateCompletion(report.after, report.retest, report.execution.retestErrors);
    const afterRevision = jsonDigest(report.afterSources);
    if (
      report.after.subjectRevision !== afterRevision ||
      report.retest.some((capture) => capture.subjectRevision !== afterRevision) ||
      report.retest.some(
        (capture) =>
          Date.parse(capture.startedAt) <
          Math.max(
            Date.parse(report.before.finishedAt),
            ...report.baseline.map((saved) => Date.parse(saved.finishedAt)),
          ),
      ) ||
      Date.parse(report.after.startedAt) <
        Math.max(
          Date.parse(report.before.finishedAt),
          ...report.baseline.map((capture) => Date.parse(capture.finishedAt)),
        )
    )
      throw new InvestigatorError(
        'INVALID_CANCELLATION_CASE',
        'The fresh investigation must follow the completed baseline and match the changed source.',
      );
    for (const capture of report.after.captures)
      if (!report.retest.some((saved) => same(saved, capture)))
        throw new InvestigatorError(
          'INVALID_CANCELLATION_CASE',
          'Fresh model observations cannot be replaced in the retest batch.',
        );
  } else if (
    report.after ||
    report.afterSources ||
    report.retest.length ||
    report.repair.status === 'applied' ||
    report.execution.retestErrors.length
  )
    throw new InvestigatorError(
      'INVALID_CANCELLATION_CASE',
      'An after-case requires the exact recorded source change.',
    );
  const expectedRepair = repairOutcome(report);
  if (!same(report.repair, expectedRepair))
    throw new InvestigatorError(
      'INVALID_CANCELLATION_CASE',
      'The repair status does not match its eligibility evidence.',
    );
  const { digest: commitment, ...body } = report;
  if (
    report.profileDigest !== jsonDigest(CANCELLATION_PROFILE as unknown as JsonValue) ||
    !same(report.verification, derive(report)) ||
    commitment !== jsonDigest(body as unknown as JsonValue)
  )
    throw new InvestigatorError(
      'INVALID_CANCELLATION_CASE',
      'The case assertions do not match the supplied profile, observations and source commitments.',
    );
  return report;
}
