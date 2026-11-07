import { z } from 'zod';
import { verifyClientSystemSnapshot } from '../context/project.js';
import { clientSystemSnapshotSchema } from '../context/schemas.js';
import { EvidenceStore } from '../core/evidence-store.js';
import { InvestigatorError } from '../core/errors.js';
import { jsonDigest, stableJson } from '../core/json.js';
import { parseInput } from '../core/parse.js';
import {
  evidenceArtifactSchema,
  jsonValueSchema,
  knownUsageSchema,
  providerIdentitySchema,
  type EvidenceArtifact,
} from '../core/schemas.js';
import {
  evidenceRecipeProposalSchema,
  verifyEvidenceRecipe,
} from '../remediation/evidence-recipe.js';
import {
  evidenceGapRunSchema,
  SYNTHETIC_CUSTOMER_CANARY,
} from '../targets/evidence-gap-service.js';
import {
  assessEvidenceCapture,
  checkWitnessNecessity,
  evidenceAssessmentSchema,
} from './gap-analysis.js';
import type { EvidencePlanningRun } from './investigate.js';
import { evidenceRequestSchema, validateEvidenceRequest } from './requests.js';
import { EXPORT_EVIDENCE_REQUIREMENTS_DIGEST } from './requirements.js';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const sources = z
  .object({
    'server.mjs': z.string().min(1).max(65_536),
    'instrumentation.mjs': z.string().min(1).max(65_536),
  })
  .strict();
const pair = z.object({ safe: evidenceGapRunSchema, unsafe: evidenceGapRunSchema }).strict();
const assessments = z
  .object({
    safeBefore: evidenceAssessmentSchema,
    safeAfter: evidenceAssessmentSchema,
    unsafeBefore: evidenceAssessmentSchema,
    unsafeAfter: evidenceAssessmentSchema,
  })
  .strict();
const planningSchema = z
  .object({
    provider: providerIdentitySchema,
    request: evidenceRequestSchema,
    calls: z
      .array(
        z
          .object({
            tool: z.enum(['inspect_client_context', 'read_client_evidence']),
            argumentsDigest: digest,
            resultDigest: digest,
          })
          .strict(),
      )
      .min(2)
      .max(8),
    usage: knownUsageSchema,
  })
  .strict();
export const evidencePlanReportSchema = z
  .object({
    format: z.literal('investigator-evidence-plan-v1'),
    requirementsDigest: digest,
    context: clientSystemSnapshotSchema,
    evidence: z.array(evidenceArtifactSchema).min(1).max(64),
    planning: planningSchema,
    application: z.object({ before: sources, after: sources }).strict(),
    change: evidenceRecipeProposalSchema,
    before: pair,
    after: pair,
    assessments,
    validation: z
      .object({
        safeBehaviorPreserved: z.boolean(),
        unsafeBehaviorPreserved: z.boolean(),
        safeBecameAssessable: z.boolean(),
        unsafeStillFails: z.boolean(),
        witnessChecks: z
          .array(
            z
              .object({
                field: z.string().min(1).max(256),
                verdictWithoutField: z.enum(['supported', 'contradicted', 'insufficient_evidence']),
              })
              .strict(),
          )
          .max(32),
        excludedCanaryAbsent: z.boolean(),
      })
      .strict(),
    limitations: z.array(z.string().min(1).max(2048)).min(1).max(16),
    authenticity: z.literal('not-established'),
  })
  .strict();
export type EvidencePlanReport = z.infer<typeof evidencePlanReportSchema>;

export function deriveEvidencePlanValidation(report: {
  readonly before: EvidencePlanReport['before'];
  readonly after: EvidencePlanReport['after'];
  readonly planning: EvidencePlanningRun;
  readonly evidence: readonly EvidenceArtifact[];
}) {
  const assessments = {
    safeBefore: assessEvidenceCapture(report.before.safe),
    safeAfter: assessEvidenceCapture(report.after.safe),
    unsafeBefore: assessEvidenceCapture(report.before.unsafe),
    unsafeAfter: assessEvidenceCapture(report.after.unsafe),
  };
  const validation = {
    safeBehaviorPreserved: report.before.safe.businessDigest === report.after.safe.businessDigest,
    unsafeBehaviorPreserved:
      report.before.unsafe.businessDigest === report.after.unsafe.businessDigest,
    safeBecameAssessable:
      assessments.safeBefore.verdict === 'insufficient_evidence' &&
      assessments.safeAfter.verdict === 'supported',
    unsafeStillFails: assessments.unsafeAfter.verdict === 'contradicted',
    witnessChecks: checkWitnessNecessity(report.after.safe),
    excludedCanaryAbsent: !JSON.stringify({
      before: report.before,
      after: report.after,
      planning: report.planning,
      evidence: report.evidence,
    }).includes(SYNTHETIC_CUSTOMER_CANARY),
  };
  return { assessments, validation };
}

/** Validate supplied snapshots and retest records; this does not authenticate or rerun history. */
export function verifyEvidencePlanReport(input: unknown): EvidencePlanReport {
  const report = parseInput(
    evidencePlanReportSchema,
    input,
    'INVALID_EVIDENCE_PLAN_REPORT',
    'Evidence plan report',
  );
  const evidence = new EvidenceStore(report.evidence);
  verifyClientSystemSnapshot(report.context, evidence);
  verifyEvidenceRecipe({
    beforeSources: report.application.before,
    afterSources: report.application.after,
    proposal: report.change,
  });
  const same = (a: unknown, b: unknown) =>
    stableJson(jsonValueSchema.parse(a)) === stableJson(jsonValueSchema.parse(b));
  const expected = deriveEvidencePlanValidation(report);
  const request = validateEvidenceRequest(report.planning.request, {
    snapshot: report.context,
    evidence,
    producerEvidenceId: 'producer',
    gapIds: expected.assessments.safeBefore.gaps.map((gap) => gap.id),
  });
  const readArguments = jsonDigest(
    jsonValueSchema.parse({
      evidenceId: request.producerCitation.evidenceId,
      locator: request.producerCitation.locator,
    }),
  );
  const readResult = jsonDigest(jsonValueSchema.parse(request.producerCitation));
  if (
    !report.planning.calls.some((call) => call.tool === 'inspect_client_context') ||
    !report.planning.calls.some(
      (call) =>
        call.tool === 'read_client_evidence' &&
        call.argumentsDigest === readArguments &&
        call.resultDigest === readResult,
    )
  )
    throw new InvestigatorError(
      'INVALID_EVIDENCE_PLAN_REPORT',
      'The saved planning trace does not bind an exact producer read to its proposal.',
    );
  if (
    Math.max(...Object.values(report.before).map((run) => Date.parse(run.finishedAt))) >
    Math.min(...Object.values(report.after).map((run) => Date.parse(run.startedAt)))
  )
    throw new InvestigatorError(
      'INVALID_EVIDENCE_PLAN_REPORT',
      'The after-change capture must follow the completed before-change workload.',
    );
  if (
    request.action !== 'instrument-authored-example' ||
    evidence.get('producer').content !== report.application.before['instrumentation.mjs'] ||
    report.requirementsDigest !== EXPORT_EVIDENCE_REQUIREMENTS_DIGEST ||
    !same(report.assessments, expected.assessments) ||
    !same(report.validation, expected.validation)
  )
    throw new InvestigatorError(
      'INVALID_EVIDENCE_PLAN_REPORT',
      'The plan assertions do not match the selected producer, fixed requirements and supplied evidence.',
    );
  for (const phase of ['before', 'after'] as const) {
    for (const authorization of ['safe', 'unsafe'] as const) {
      const run = report[phase][authorization];
      if (
        run.authorization !== authorization ||
        run.instrumentation !== (phase === 'before' ? 'legacy' : 'bound') ||
        run.sourceRevision !== jsonDigest({ ...report.application[phase] })
      )
        throw new InvestigatorError(
          'INVALID_EVIDENCE_PLAN_REPORT',
          'Captured runs do not match their application source and configuration lineage.',
        );
    }
  }
  return report;
}
