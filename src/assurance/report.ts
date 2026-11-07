import { z } from 'zod';
import { InvestigatorError } from '../core/errors.js';
import { jsonDigest, stableJson, type JsonValue } from '../core/json.js';
import { parseInput } from '../core/parse.js';
import { assessEvidenceCapture, evidenceAssessmentSchema } from '../evidence-plans/gap-analysis.js';
import {
  approvalCommitment,
  evidenceGapRunSchema,
  type EvidenceGapRun,
} from '../targets/evidence-gap-service.js';
import {
  ASSURANCE_VERIFIER_VERSION,
  assuranceCheckpointSchema,
  fixtureAssuranceStateSchema,
  inventoryFromFixtureState,
  verifyAssuranceCheckpoint,
  type AssuranceCheckpoint,
} from './checkpoint.js';
import { compareAssurance } from './compare.js';
import {
  assuranceInventorySchema,
  changeInvestigationSchema,
  type ChangeInvestigation,
} from './schemas.js';

export const assuranceChangeReportSchema = z
  .object({
    format: z.literal('investigator-assurance-report-v1'),
    checkpoint: assuranceCheckpointSchema,
    candidate: fixtureAssuranceStateSchema,
    inventory: assuranceInventorySchema,
    investigation: changeInvestigationSchema,
    retest: z
      .object({
        run: evidenceGapRunSchema,
        assessment: evidenceAssessmentSchema,
        requiredChecks: z.array(z.string().min(1).max(160)).max(32),
        executedChecks: z.array(z.string().min(1).max(160)).max(32),
      })
      .strict()
      .nullable(),
    retestStatus: z.enum(['not-run', 'completed', 'blocked', 'not-needed', 'unsupported']),
    limitations: z.array(z.string().min(1).max(2048)).min(1).max(16),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type AssuranceChangeReport = z.infer<typeof assuranceChangeReportSchema>;

export function supportsFixtureRetest(
  checkpoint: AssuranceCheckpoint,
  candidate: z.infer<typeof fixtureAssuranceStateSchema>,
  investigation: ChangeInvestigation,
): boolean {
  return (
    !investigation.retestPlan.blocked &&
    investigation.retestPlan.checkIds.length > 0 &&
    candidate.observerVersion === ASSURANCE_VERIFIER_VERSION &&
    stableJson(candidate.application) === stableJson(checkpoint.state.application) &&
    investigation.changes.every((change) =>
      ['authorization-binding', 'operator-notes'].includes(change.dependencyId),
    )
  );
}

/** Attempt and approval semantics remain fixed while testing the changed implementation setting. */
export function assuranceWorkloadDigest(run: EvidenceGapRun): string {
  return jsonDigest(
    run.scenarios.map((scenario) => ({
      id: scenario.id,
      expectation: scenario.expectation,
      attempt: scenario.attempt,
      approval: approvalCommitment(scenario.approval),
    })),
  );
}

export function createAssuranceChangeReport(
  checkpointInput: unknown,
  candidateInput: unknown,
  freshRun?: EvidenceGapRun,
): AssuranceChangeReport {
  const checkpoint = verifyAssuranceCheckpoint(checkpointInput);
  const candidate = parseInput(
    fixtureAssuranceStateSchema,
    candidateInput,
    'INVALID_ASSURANCE_STATE',
    'Candidate state',
  );
  const inventory = inventoryFromFixtureState(candidate);
  const investigation = compareAssurance({
    baseline: checkpoint.inventory,
    candidate: inventory,
    contract: checkpoint.contract,
  });
  let retest: AssuranceChangeReport['retest'] = null;
  let retestStatus: AssuranceChangeReport['retestStatus'] = investigation.retestPlan.blocked
    ? 'blocked'
    : !investigation.retestPlan.checkIds.length
      ? 'not-needed'
      : supportsFixtureRetest(checkpoint, candidate, investigation)
        ? 'not-run'
        : 'unsupported';
  if (freshRun) {
    const run = parseInput(
      evidenceGapRunSchema,
      freshRun,
      'INVALID_ASSURANCE_RETEST',
      'Fresh controlled capture',
    );
    if (
      !supportsFixtureRetest(checkpoint, candidate, investigation) ||
      run.sourceRevision !== jsonDigest(candidate.application) ||
      run.authorization !== candidate.authorization ||
      run.instrumentation !== 'bound' ||
      Date.parse(run.startedAt) < Date.parse(candidate.capturedAt) ||
      assuranceWorkloadDigest(run) !== assuranceWorkloadDigest(checkpoint.evidencePlan.after.safe)
    )
      throw new InvestigatorError(
        'INVALID_ASSURANCE_RETEST',
        'Fresh evidence must match the supported candidate, fixed workload and post-change capture window.',
      );
    const assessment = assessEvidenceCapture(run);
    retest = {
      run,
      assessment,
      requiredChecks: [...investigation.retestPlan.checkIds],
      executedChecks: run.scenarios.map((scenario) => scenario.id).sort(),
    };
    retestStatus = 'completed';
  }
  const body = {
    format: 'investigator-assurance-report-v1' as const,
    checkpoint,
    candidate,
    inventory,
    investigation,
    retest,
    retestStatus,
    limitations: [
      'Historical verdict, dependency applicability and fresh test outcome are distinct. A comparison never renews a behavioral finding.',
      'Fingerprints describe selected supplied inputs. Neither the original evidence nor candidate sources have independently authenticated authorship.',
      'The checkpoint map is code-owned for one finite authored export workload. It is not complete enterprise discovery or production release authorization.',
      'Changed policy, agent instructions, tool schemas or permissions require explicit profile review; rerunning old tests does not establish the new obligation.',
      'The supported adapter executes the full frozen four-attempt batch even when fewer checks are identified in the dependency plan; no execution-cost savings are claimed.',
      'The fixture tool definition is a selected configuration dependency; the example does not run a production MCP server or establish upstream tool permissions.',
    ],
  };
  return { ...body, digest: jsonDigest(body as unknown as JsonValue) };
}

/** Recompute the entire supplied dependency investigation and recorded retest bindings. */
export function verifyAssuranceChangeReport(input: unknown): AssuranceChangeReport {
  const report = parseInput(
    assuranceChangeReportSchema,
    input,
    'INVALID_ASSURANCE_REPORT',
    'Change investigation report',
  );
  const expected = createAssuranceChangeReport(
    report.checkpoint,
    report.candidate,
    report.retest?.run,
  );
  if (stableJson(report as unknown as JsonValue) !== stableJson(expected as unknown as JsonValue))
    throw new InvestigatorError(
      'INVALID_ASSURANCE_REPORT',
      'The supplied change report does not match its frozen checkpoint, candidate bytes and recorded retest.',
    );
  return expected;
}
