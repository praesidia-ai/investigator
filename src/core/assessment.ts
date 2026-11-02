import { validateCitations } from './citations.js';
import { findControlProfile } from './control-profiles.js';
import { controlResultReference } from './control-target.js';
import { InvestigatorError } from './errors.js';
import type { EvidenceStore } from './evidence-store.js';
import { jsonDigest } from './json.js';
import { parseInput, parseJson } from './parse.js';
import {
  checkResultSchema,
  jsonValueSchema,
  type CheckResult,
  type Citation,
  type ControlCase,
  type EvidenceArtifact,
  type Finding,
} from './schemas.js';

const INCOMPLETE = 'Mandatory checks or declared evidence coverage are incomplete.';

export function consistentObservations(check: CheckResult): boolean {
  const statuses = check.observations.map((observation) =>
    observation !== null && typeof observation === 'object' && !Array.isArray(observation)
      ? observation['status']
      : undefined,
  );
  if (
    statuses.length === 0 ||
    statuses.some(
      (status) =>
        status !== 'PASS' && status !== 'FAIL' && status !== 'INCOMPLETE' && status !== 'ERROR',
    )
  )
    return false;
  const expected = statuses.includes('ERROR')
    ? 'ERROR'
    : statuses.includes('FAIL')
      ? 'FAIL'
      : statuses.includes('INCOMPLETE')
        ? 'INCOMPLETE'
        : 'PASS';
  return check.status === expected;
}

function unresolved(finding: Finding, reason = INCOMPLETE): Finding {
  return {
    ...finding,
    verdict: 'insufficient_evidence',
    statement:
      'Required checks or their evidence prerequisites are incomplete; the claim remains unresolved.',
    missingEvidence: [
      ...new Set([
        ...finding.missingEvidence.filter((item) => item !== reason).slice(0, 31),
        reason,
      ]),
    ],
  };
}

/** Only an application-generated, target-bound result can witness a behavioral assessment. */
function resultArtifact(
  controlCase: ControlCase,
  evidence: EvidenceStore,
  checks: readonly CheckResult[],
): EvidenceArtifact | undefined {
  const expected = controlCase.referenceTarget
    ? {
        id: 'reference-control-results',
        kind: 'reference-check',
        reference: `customer-export-reference:${controlCase.referenceTarget.variant}:v1`,
      }
    : controlCase.controlledTarget
      ? {
          id: 'control-check-results',
          kind: 'controlled-check',
          reference: controlResultReference(controlCase),
        }
      : undefined;
  if (!expected || checks.length === 0) return undefined;
  const artifact = evidence.all().find((entry) => entry.id === expected.id);
  if (
    !artifact ||
    artifact.redacted ||
    artifact.mediaType !== 'application/json' ||
    artifact.source.kind !== expected.kind ||
    artifact.source.reference !== expected.reference
  )
    return undefined;
  const recorded = parseInput(
    checkResultSchema.array().min(1).max(32),
    parseJson(artifact.content, 'INVALID_CONTROL_EVIDENCE'),
    'INVALID_CONTROL_EVIDENCE',
    'Control result evidence',
  );
  if (
    new Set(recorded.map((check) => check.id)).size !== recorded.length ||
    recorded.some((check) => !consistentObservations(check)) ||
    jsonDigest(
      parseInput(jsonValueSchema, recorded, 'INVALID_CONTROL_EVIDENCE', 'Control result evidence'),
    ) !==
      jsonDigest(parseInput(jsonValueSchema, checks, 'INVALID_CONTROL_EVIDENCE', 'Control results'))
  ) {
    throw new InvestigatorError(
      'INVALID_CONTROL_EVIDENCE',
      'Control results do not match their saved observations.',
    );
  }
  return artifact;
}

function citesCheck(citations: readonly Citation[], artifactId: string, index: number): boolean {
  return citations.some(
    (citation) =>
      citation.evidenceId === artifactId &&
      citation.locator.kind === 'json-pointer' &&
      ['', `/${index}`, `/${index}/status`].includes(citation.locator.pointer),
  );
}

function inputCoverageComplete(
  controlCase: ControlCase,
  evidence: EvidenceStore,
  checkId: string,
): boolean {
  const dependency = controlCase.criterionEvidence?.find((entry) => entry.checkId === checkId);
  if (!dependency || dependency.evidenceIds.length === 0) return false;
  return dependency.evidenceIds.every((id) => {
    const artifact = evidence.get(id);
    return artifact.coverage === 'complete' && !artifact.redacted;
  });
}

function scopedStatement(controlCase: ControlCase, verdict: 'supported' | 'contradicted'): string {
  const subject = JSON.stringify(controlCase.subject.id);
  const revision = JSON.stringify(controlCase.subject.revision);
  return `The declared customer-export approval control is ${verdict} by the required checks for ${subject} at revision ${revision} in ${controlCase.subject.environment} scope. This assesses only the declared controlled test, not deployment-wide or legal compliance.`;
}

/** Machine observations constrain a model assessment; they never establish human acceptance. */
export function assessFinding(
  finding: Finding,
  controlCase: ControlCase,
  evidence: EvidenceStore,
  checks: readonly CheckResult[],
): Finding {
  validateCitations(finding.citations, evidence);
  if (finding.verdict === 'insufficient_evidence') return finding;
  if (finding.citations.length === 0) {
    throw new InvestigatorError(
      'CITATION_REQUIRED',
      'A conclusive finding requires a resolvable evidence citation.',
    );
  }
  const profile = findControlProfile(controlCase.controlProfile);
  if (!profile || controlCase.assessmentMode !== 'controlled-test') {
    return unresolved(
      finding,
      'This assessment mode has no supported behavioral criterion verifier; policy text alone does not establish runtime behavior.',
    );
  }
  const artifact = resultArtifact(controlCase, evidence, checks);
  if (!artifact) return unresolved(finding);
  const required = profile.requiredChecks.map((id) => checks.find((check) => check.id === id));
  const failed = required.filter((check) => check?.status === 'FAIL');
  const allPassed = required.every((check) => check?.status === 'PASS');
  if (finding.verdict === 'supported' && failed.length > 0) {
    throw new InvestigatorError(
      'CHECK_VERDICT_CONFLICT',
      'The proposed finding contradicts an observed failing check.',
    );
  }
  if (finding.verdict === 'contradicted') {
    if (allPassed) {
      throw new InvestigatorError(
        'CHECK_VERDICT_CONFLICT',
        'The declared control cannot be contradicted by passing mandatory checks.',
      );
    }
    const citedFailure = failed.some(
      (check) => check && citesCheck(finding.citations, artifact.id, checks.indexOf(check)),
    );
    if (!citedFailure)
      return unresolved(
        finding,
        'Cite an observed failing mandatory check; a policy quotation or passing check is not a failure witness.',
      );
  } else if (
    !allPassed ||
    artifact.coverage !== 'complete' ||
    profile.requiredChecks.some((id) => !inputCoverageComplete(controlCase, evidence, id))
  ) {
    return unresolved(finding);
  } else if (
    required.some(
      (check) => !check || !citesCheck(finding.citations, artifact.id, checks.indexOf(check)),
    )
  ) {
    return unresolved(finding, 'Cite the observed PASS result for every mandatory criterion.');
  }
  return { ...finding, statement: scopedStatement(controlCase, finding.verdict) };
}
