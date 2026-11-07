import { z } from 'zod';
import { digestSchema as digest, shortTextSchema } from '../core/schemas.js';

const identifier = z.string().min(1).max(160);
const sequence = z.number().int().positive().safe();
const time = z.iso.datetime();

export const CANCELLATION_EXPERIMENT_IDS = Object.freeze([
  'queued-after-revoke',
  'retry-after-revoke',
  'independent-root',
  'accepted-before-revoke',
] as const);
export const cancellationExperimentIdSchema = z.enum(CANCELLATION_EXPERIMENT_IDS);
export type CancellationExperimentId = z.infer<typeof cancellationExperimentIdSchema>;

export const ROOT_TO_REVOKE = 'root:retired';
export const INDEPENDENT_ROOT = 'root:independent';
export const CANCELLATION_PROFILE = Object.freeze({
  id: 'work-revocation.v1' as const,
  version: 1 as const,
  claim:
    'Acknowledged revocation of the selected work root prevents new protected downstream acceptances for that root; independently authorized work remains possible and pre-revocation acceptances are not rollback failures.',
  requiredExperiments: Object.freeze([...CANCELLATION_EXPERIMENT_IDS]),
});

export const cancellationAttemptSchema = z
  .object({
    rootId: identifier,
    jobId: identifier,
    attemptId: identifier,
    requestDigest: digest,
    enqueueSequence: sequence,
    dispatchSequence: sequence,
  })
  .strict();
export type CancellationAttempt = z.infer<typeof cancellationAttemptSchema>;

export const cancellationEffectSchema = z
  .object({
    rootId: identifier,
    jobId: identifier,
    attemptId: identifier,
    requestDigest: digest,
    acceptSequence: sequence,
    observedAt: time,
  })
  .strict();
export type CancellationEffect = z.infer<typeof cancellationEffectSchema>;

export const cancellationWorkerClaimSchema = z
  .object({
    rootId: identifier,
    jobId: identifier,
    state: z.enum(['queued', 'cancelled', 'accepted', 'denied']),
  })
  .strict();
export type CancellationWorkerClaim = z.infer<typeof cancellationWorkerClaimSchema>;

export const cancellationCaptureSchema = z
  .object({
    schemaVersion: z.literal(1),
    experimentId: cancellationExperimentIdSchema,
    runId: identifier,
    subjectRevision: digest,
    startedAt: time,
    finishedAt: time,
    scope: z.literal('authored-loopback-workflow'),
    observation: z
      .object({
        status: z.enum(['complete', 'partial']),
        windowClosed: z.boolean(),
        limitations: z.array(shortTextSchema).max(32),
      })
      .strict(),
    cut: z
      .object({
        rootId: identifier,
        ackSequence: sequence,
        observedAt: time,
      })
      .strict()
      .nullable(),
    attempts: z.array(cancellationAttemptSchema).min(1).max(8),
    effects: z.array(cancellationEffectSchema).max(16),
    workerClaims: z.array(cancellationWorkerClaimSchema).max(16),
  })
  .strict();
export type CancellationCapture = z.infer<typeof cancellationCaptureSchema>;

export const cancellationCheckSchema = z
  .object({
    experimentId: cancellationExperimentIdSchema.nullable(),
    status: z.enum(['PASS', 'FAIL', 'INCOMPLETE']),
    reason: shortTextSchema,
    witnessPointers: z.array(z.string().max(512)).max(32),
  })
  .strict();
export type CancellationCheck = z.infer<typeof cancellationCheckSchema>;

export const cancellationAssessmentSchema = z
  .object({
    profileId: z.literal('work-revocation.v1'),
    scope: z.literal('authored-loopback-workflow'),
    subjectRevision: digest.nullable(),
    verdict: z.enum(['supported', 'contradicted', 'insufficient_evidence']),
    checks: z.array(cancellationCheckSchema).max(4),
    missingExperiments: z.array(cancellationExperimentIdSchema).max(4),
    limitations: z.array(shortTextSchema).min(1).max(16),
  })
  .strict();
export type CancellationAssessment = z.infer<typeof cancellationAssessmentSchema>;
