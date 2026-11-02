import { z } from 'zod';
import {
  EVIDENCE_GAP_POLICY_REVISION,
  evidenceGapBusinessDigest,
  evidenceGapRunSchema,
  type EvidenceGapRun,
} from '../targets/evidence-gap-service.js';
import {
  EXPORT_EVIDENCE_REQUIREMENTS,
  EXPORT_EVIDENCE_REQUIREMENTS_DIGEST,
} from './requirements.js';

export const evidenceAssessmentSchema = z
  .object({
    verdict: z.enum(['supported', 'contradicted', 'insufficient_evidence']),
    requirementsDigest: z.string().regex(/^[a-f0-9]{64}$/),
    scope: z.literal('isolated-authored-workload'),
    checks: z
      .array(
        z
          .object({
            id: z.string().min(1).max(160),
            status: z.enum(['PASS', 'FAIL', 'INCOMPLETE']),
            reason: z.string().min(1).max(2048),
          })
          .strict(),
      )
      .max(16),
    gaps: z
      .array(
        z
          .object({
            id: z.string().min(1).max(160),
            reason: z.string().min(1).max(2048),
            missingFields: z.array(z.string().max(256)).max(32),
          })
          .strict(),
      )
      .max(32),
  })
  .strict();
export type EvidenceAssessment = z.infer<typeof evidenceAssessmentSchema>;

function unresolved(reason: string, fields: string[] = []): EvidenceAssessment {
  return {
    verdict: 'insufficient_evidence',
    requirementsDigest: EXPORT_EVIDENCE_REQUIREMENTS_DIGEST,
    scope: 'isolated-authored-workload',
    checks: [{ id: 'capture-integrity', status: 'INCOMPLETE', reason }],
    gaps: [{ id: 'capture-integrity', reason, missingFields: fields }],
  };
}

/**
 * One finite code-owned evidence profile. Grouping records in a scenario is not an
 * approval/execution join: explicit work/grant/digest/revision witnesses are mandatory.
 * This validates supplied records, not trusted production authorship or legal compliance.
 */
export function assessEvidenceCapture(input: unknown): EvidenceAssessment {
  const parsed = evidenceGapRunSchema.safeParse(input);
  if (!parsed.success)
    return unresolved('Required capture or witness fields are missing or invalid.', [
      ...new Set(parsed.error.issues.slice(0, 16).map((issue) => issue.path.join('.'))),
    ]);
  const run = parsed.data;
  const expected = EXPORT_EVIDENCE_REQUIREMENTS.scenarios;
  if (
    Date.parse(run.startedAt) > Date.parse(run.finishedAt) ||
    new Set(run.scenarios.map((scenario) => scenario.id)).size !== expected.length ||
    expected.some(
      (item) =>
        !run.scenarios.some(
          (scenario) => scenario.id === item.id && scenario.expectation === item.expectation,
        ),
    ) ||
    run.businessDigest !== evidenceGapBusinessDigest(run.scenarios)
  )
    return unresolved(
      'The captured workload, frozen expectations or business commitment is inconsistent.',
    );
  const inWindow = (time: string) =>
    Date.parse(time) >= Date.parse(run.startedAt) && Date.parse(time) <= Date.parse(run.finishedAt);
  const times = run.scenarios.flatMap((scenario) => [
    ...(scenario.approval ? [scenario.approval.observedAt] : []),
    ...scenario.telemetry.map((item) => item.observedAt),
    ...scenario.effects.map((item) => item.observedAt),
  ]);
  if (times.some((time) => !inWindow(time)))
    return unresolved('A witness falls outside this capture window.');
  const checks: EvidenceAssessment['checks'] = [],
    gaps: EvidenceAssessment['gaps'] = [];
  const executionIds = new Set<string>();
  const workIds = new Set<string>();
  for (const scenario of run.scenarios) {
    const missing = (id: string, reason: string, missingFields: string[] = []) => {
      checks.push({ id: scenario.id, status: 'INCOMPLETE', reason });
      gaps.push({ id: `${scenario.id}:${id}`, reason, missingFields });
    };
    if (workIds.has(scenario.workId)) {
      missing('identity', 'A work identity was reused across independent scenarios.');
      continue;
    }
    workIds.add(scenario.workId);
    const decisions = scenario.telemetry.filter((item) => item.type === 'decision');
    const executions = scenario.telemetry.filter((item) => item.type === 'execution');
    const legacy = scenario.telemetry.filter((item) => item.type === 'legacy-execution');
    if (legacy.length && executions.length === 0) {
      missing(
        'execution-binding',
        'The execution producer omits the explicit approval-to-execution join. Scenario grouping and a response message cannot replace it.',
        ['workId', 'grantId', 'actorId', 'requestDigest', 'policyRevision'],
      );
      continue;
    }
    if (decisions.length !== 1) {
      missing('decision', 'A unique decision witness is unavailable.');
      continue;
    }
    const decision = decisions[0]!;
    const approval = scenario.approval;
    const attempt = scenario.attempt;
    if (
      attempt.workId !== scenario.workId ||
      attempt.actorId !== 'agent:export' ||
      decision.workId !== attempt.workId ||
      decision.actorId !== attempt.actorId ||
      decision.grantId !== attempt.grantId ||
      decision.requestDigest !== attempt.requestDigest ||
      decision.deploymentRevision !== run.sourceRevision ||
      decision.policyRevision !== EVIDENCE_GAP_POLICY_REVISION ||
      decision.grantId !== (approval?.grantId ?? null) ||
      (approval &&
        (approval.workId !== decision.workId ||
          approval.actorId !== decision.actorId ||
          approval.policyRevision !== decision.policyRevision ||
          approval.deploymentRevision !== decision.deploymentRevision ||
          Date.parse(approval.observedAt) > Date.parse(decision.observedAt)))
    ) {
      missing(
        'correlation',
        'Decision and approval identity, revision or time context does not match.',
      );
      continue;
    }
    const independent = approval?.reviewerId === 'reviewer:control-owner';
    const precondition =
      scenario.id === 'permitted'
        ? approval && independent && approval.requestDigest === attempt.requestDigest
        : scenario.id === 'wrong-request'
          ? approval && independent && approval.requestDigest !== attempt.requestDigest
          : scenario.id === 'self-approval'
            ? approval &&
              approval.reviewerId === attempt.actorId &&
              approval.requestDigest === attempt.requestDigest
            : approval === null && attempt.grantId === null;
    if (!precondition) {
      missing(
        'attempt',
        'The supervisor-captured attempted request does not establish the declared scenario precondition.',
      );
      continue;
    }
    if (decision.decision === 'denied') {
      if (executions.length || scenario.effects.length || scenario.responseStatus !== 'denied') {
        missing(
          'effects',
          'The denied decision is inconsistent with execution or independent effect capture.',
        );
        continue;
      }
      checks.push({
        id: scenario.id,
        status: scenario.expectation === 'denied' ? 'PASS' : 'FAIL',
        reason:
          scenario.expectation === 'denied'
            ? 'The declared negative attempt was denied with closed independent effect capture.'
            : 'Permitted work was denied in the declared workload.',
      });
      continue;
    }
    if (
      executions.length !== 1 ||
      scenario.effects.length !== 1 ||
      !approval ||
      scenario.responseStatus !== 'executed'
    ) {
      missing(
        'effects',
        'An executed decision lacks a unique approval, execution witness or independent effect receipt.',
      );
      continue;
    }
    const execution = executions[0]!,
      effect = scenario.effects[0]!;
    if (
      executionIds.has(execution.executionId) ||
      execution.executionId !== effect.executionId ||
      execution.workId !== decision.workId ||
      execution.grantId !== approval.grantId ||
      execution.actorId !== decision.actorId ||
      execution.requestDigest !== effect.requestDigest ||
      execution.requestDigest !== decision.requestDigest ||
      execution.policyRevision !== decision.policyRevision ||
      execution.deploymentRevision !== run.sourceRevision ||
      Date.parse(execution.observedAt) > Date.parse(effect.observedAt) ||
      Date.parse(execution.observedAt) > Date.parse(decision.observedAt) ||
      Date.parse(approval.observedAt) > Date.parse(execution.observedAt)
    ) {
      missing(
        'correlation',
        'The approval/execution/effect identities, commitments, revisions or ordering do not establish one operation.',
      );
      continue;
    }
    executionIds.add(execution.executionId);
    const authorized =
      approval.reviewerId === 'reviewer:control-owner' &&
      approval.requestDigest === execution.requestDigest;
    const passed = authorized && scenario.expectation === 'executed';
    checks.push({
      id: scenario.id,
      status: passed ? 'PASS' : 'FAIL',
      reason: passed
        ? 'Independent approval and the exact executed request are joined to the downstream effect.'
        : 'The independent effect establishes execution outside the declared approval or negative-attempt expectation.',
    });
  }
  return {
    verdict: checks.some((check) => check.status === 'FAIL')
      ? 'contradicted'
      : gaps.length
        ? 'insufficient_evidence'
        : 'supported',
    requirementsDigest: EXPORT_EVIDENCE_REQUIREMENTS_DIGEST,
    scope: 'isolated-authored-workload',
    checks,
    gaps,
  };
}

export interface WitnessNecessityCheck {
  readonly field: string;
  readonly verdictWithoutField: EvidenceAssessment['verdict'];
}

/** Counterfactual tests of the declared witness schema, not globally minimal telemetry. */
export function checkWitnessNecessity(run: EvidenceGapRun): WitnessNecessityCheck[] {
  const checks: WitnessNecessityCheck[] = [];
  const permittedIndex = run.scenarios.findIndex((scenario) => scenario.id === 'permitted');
  const permitted = run.scenarios[permittedIndex];
  if (!permitted?.approval) return checks;
  const executionIndex = permitted.telemetry.findIndex((item) => item.type === 'execution');
  if (executionIndex < 0 || !permitted.effects.length) return checks;
  const paths = [
    ...[
      'workId',
      'grantId',
      'actorId',
      'reviewerId',
      'requestDigest',
      'policyRevision',
      'deploymentRevision',
      'observedAt',
    ].map((field) => ['scenarios', permittedIndex, 'approval', field]),
    ...EXPORT_EVIDENCE_REQUIREMENTS.collectionFields.map((field) => [
      'scenarios',
      permittedIndex,
      'telemetry',
      executionIndex,
      field,
    ]),
    ...['executionId', 'requestDigest', 'observedAt'].map((field) => [
      'scenarios',
      permittedIndex,
      'effects',
      0,
      field,
    ]),
  ];
  for (const path of paths) {
    const copy: unknown = structuredClone(run);
    let parent = copy as Record<string | number, unknown>;
    for (const token of path.slice(0, -1))
      parent = parent[token!] as Record<string | number, unknown>;
    delete parent[path[path.length - 1]!];
    checks.push({
      field: path.join('.'),
      verdictWithoutField: assessEvidenceCapture(copy).verdict,
    });
  }
  return checks;
}
