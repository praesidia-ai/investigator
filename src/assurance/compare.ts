import { InvestigatorError } from '../core/errors.js';
import { jsonDigest, type JsonValue } from '../core/json.js';
import { parseInput } from '../core/parse.js';
import {
  assuranceComparisonInputSchema,
  changeInvestigationSchema,
  type AssuranceBlocker,
  type AssuranceContract,
  type AssuranceDependency,
  type AssuranceInventory,
  type ChangeInvestigation,
  type CheckFreshness,
  type DependencyChange,
} from './schemas.js';

const REVIEW_KINDS = new Set<AssuranceDependency['kind']>([
  'policy',
  'agent-instructions',
  'tool-definition',
  'permissions',
  'document',
]);

function invalid(message: string): never {
  throw new InvestigatorError('INVALID_ASSURANCE_INPUT', message);
}

function matchingScope(a: AssuranceInventory['scope'], b: AssuranceInventory['scope']): boolean {
  return a.tenantRef === b.tenantRef && a.workflowRef === b.workflowRef;
}

function validateContractReferences(
  contract: AssuranceContract,
  baseline: AssuranceInventory,
): void {
  const dependencies = new Map(
    baseline.dependencies.map((dependency) => [dependency.id, dependency]),
  );
  const mapped = new Set(contract.checks.flatMap((check) => check.dependencyIds));
  for (const check of contract.checks) {
    if (check.dependencyIds.some((id) => !dependencies.has(id)))
      invalid('Every check dependency must name an inventory entry in the recorded baseline.');
  }
  for (const exclusion of contract.exclusions) {
    if (dependencies.get(exclusion.dependencyId)?.kind !== 'document')
      invalid('Only an existing document dependency can be explicitly excluded.');
    if (mapped.has(exclusion.dependencyId))
      invalid('A dependency cannot be both excluded and mapped to a check.');
  }
}

/**
 * Compare declared, finite dependency snapshots. This never converts historical
 * evidence into a current behavioral verdict, discovers an entire environment or
 * proves that an operator's dependency map is complete.
 */
export function compareAssurance(input: unknown): ChangeInvestigation {
  const { baseline, candidate, contract } = parseInput(
    assuranceComparisonInputSchema,
    input,
    'INVALID_ASSURANCE_INPUT',
    'Assurance comparison',
  );
  if (
    !matchingScope(baseline.scope, candidate.scope) ||
    !matchingScope(baseline.scope, contract.scope)
  )
    invalid('Baseline, candidate and contract must name the same tenant and workflow.');
  if (Date.parse(candidate.capturedAt) < Date.parse(baseline.capturedAt))
    invalid('Candidate capture must not precede its baseline capture.');
  validateContractReferences(contract, baseline);

  const before = new Map(baseline.dependencies.map((dependency) => [dependency.id, dependency]));
  const after = new Map(candidate.dependencies.map((dependency) => [dependency.id, dependency]));
  const mappedIds = new Set(contract.checks.flatMap((check) => check.dependencyIds));
  const exclusions = new Map(
    contract.exclusions.map((exclusion) => [exclusion.dependencyId, exclusion]),
  );
  const changes: DependencyChange[] = [];
  const blockers: AssuranceBlocker[] = [];
  const missingIds = new Set<string>();
  const changedKindIds = new Set<string>();
  let globalUnknown = false;

  if (baseline.coverage.status !== 'complete' || candidate.coverage.status !== 'complete') {
    globalUnknown = true;
    blockers.push({
      code: 'incomplete-coverage',
      dependencyIds: [],
      reason:
        'At least one dependency inventory declares partial or unknown coverage; automatic evidence reuse is blocked.',
    });
  }
  if (baseline.coverage.frontier.length || candidate.coverage.frontier.length) {
    globalUnknown = true;
    blockers.push({
      code: 'coverage-frontier',
      dependencyIds: [],
      reason:
        'An unexplored dependency frontier remains in a selected inventory; the declared map cannot support automatic reuse.',
    });
  }
  const unmapped = baseline.dependencies
    .filter((dependency) => !mappedIds.has(dependency.id) && !exclusions.has(dependency.id))
    .map((dependency) => dependency.id)
    .sort();
  if (unmapped.length) {
    globalUnknown = true;
    blockers.push({
      code: 'unmapped-dependency',
      dependencyIds: unmapped,
      reason:
        'Recorded baseline dependencies are neither mapped to a control check nor explicitly excluded documents.',
    });
  }

  for (const id of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    const original = before.get(id) ?? null;
    const revised = after.get(id) ?? null;
    if (!original) {
      globalUnknown = true;
      changes.push({
        dependencyId: id,
        change: 'added',
        before: null,
        after: revised,
        disposition: 'unknown',
        reason: 'A new dependency is not covered by the recorded control dependency contract.',
      });
      blockers.push({
        code: 'unmapped-dependency',
        dependencyIds: [id],
        reason:
          'A newly supplied dependency requires mapping before earlier evidence can be reused.',
      });
    } else if (!revised) {
      missingIds.add(id);
      changes.push({
        dependencyId: id,
        change: 'removed',
        before: original,
        after: null,
        disposition: 'unknown',
        reason:
          'A recorded dependency is absent from the candidate inventory; absence is not evidence of unchanged behavior.',
      });
      blockers.push({
        code: 'missing-dependency',
        dependencyIds: [id],
        reason: 'A recorded dependency was removed or was not captured in the candidate.',
      });
      if (!mappedIds.has(id)) globalUnknown = true;
    } else if (original.kind !== revised.kind) {
      changedKindIds.add(id);
      changes.push({
        dependencyId: id,
        change: 'kind-changed',
        before: original,
        after: revised,
        disposition: 'unknown',
        reason:
          'A dependency identity changed kind; its recorded control mapping no longer establishes equivalent scope.',
      });
      blockers.push({
        code: 'dependency-kind-changed',
        dependencyIds: [id],
        reason: 'A dependency kind change requires identity and scope reconciliation before reuse.',
      });
      if (exclusions.has(id) || !mappedIds.has(id)) globalUnknown = true;
    } else if (
      original.fingerprint !== revised.fingerprint ||
      original.revision !== revised.revision
    ) {
      const excluded = exclusions.has(id);
      const review = REVIEW_KINDS.has(revised.kind);
      changes.push({
        dependencyId: id,
        change: 'modified',
        before: original,
        after: revised,
        disposition: excluded
          ? 'out-of-declared-scope'
          : !mappedIds.has(id)
            ? 'unknown'
            : review
              ? 'profile-review'
              : 'retest',
        reason: excluded
          ? 'This changed document is explicitly outside the declared control dependency map; its exclusion is an operator declaration, not proof of actual irrelevance.'
          : !mappedIds.has(id)
            ? 'The changed dependency has no recorded check mapping.'
            : review
              ? 'The change may alter the obligation or authority boundary. Repeating old checks cannot establish semantic equivalence; explicit profile review is required.'
              : 'A supported behavior or observer dependency changed; the mapped mandatory checks require fresh execution.',
      });
    }
  }

  const byId = new Map(changes.map((change) => [change.dependencyId, change]));
  const checks: CheckFreshness[] = [...contract.checks]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((check) => {
      const affected = check.dependencyIds.filter((id) => byId.has(id)).sort();
      const unknown =
        globalUnknown ||
        check.dependencyIds.some((id) => missingIds.has(id) || changedKindIds.has(id));
      const review = affected.some((id) => byId.get(id)?.disposition === 'profile-review');
      const reasons = unknown
        ? [
            'Automatic reuse is unavailable because dependency coverage, mapping or identity is unresolved.',
          ]
        : affected.length
          ? affected.map((id) => `${id}: ${byId.get(id)!.reason}`)
          : [
              "The check's recorded dependency fingerprints and revisions are unchanged within the declared map. This is not a current behavioral verdict.",
            ];
      return {
        id: check.id,
        historicalVerdict: check.historicalVerdict,
        currentVerdict: null,
        validity: unknown
          ? 'unknown'
          : affected.length
            ? 'stale'
            : 'unchanged-recorded-dependencies',
        changedDependencyIds: affected,
        requiredAction: unknown
          ? 'resolve-coverage'
          : review
            ? 'profile-review'
            : affected.length
              ? 'retest'
              : 'none',
        reasons,
      };
    });
  const checkDefinitions = new Map(contract.checks.map((check) => [check.id, check]));
  const profileReviewRequired =
    checks.some((check) => check.requiredAction === 'profile-review') ||
    changes.some((change) => change.disposition === 'profile-review');
  const plan = [
    ...new Set(
      checks
        .filter((check) => check.requiredAction === 'retest')
        .flatMap((check) => checkDefinitions.get(check.id)!.retestChecks),
    ),
  ].sort();
  const body = {
    format: 'investigator-assurance-change-v1' as const,
    scope: contract.scope,
    baselineDigest: jsonDigest(baseline as unknown as JsonValue),
    candidateDigest: jsonDigest(candidate as unknown as JsonValue),
    contractDigest: jsonDigest(contract as unknown as JsonValue),
    changes,
    checks,
    blockers,
    retestPlan: {
      checkIds: plan,
      blocked: blockers.length > 0 || profileReviewRequired,
      profileReviewRequired,
      scope: 'declared-dependencies-only' as const,
    },
    limitations: [
      'Dependency fingerprints, coverage and exclusions are operator-supplied declarations, not proof of complete discovery or actual irrelevance.',
      'Unchanged recorded dependencies preserve only the applicability of a historical record within this declared map; every current behavioral verdict remains unset.',
      'The retest plan is the union of declared mapped checks for supported changes, not a globally minimal test suite or a production release authorization.',
      'Policy, instruction, tool-definition, permission and mapped-document changes require explicit profile review; old checks cannot establish a changed obligation.',
      'Capture timestamp changes alone do not invalidate dependency content; changed fingerprints, revision labels, kinds and missing sources remain material.',
      'This comparison checks supplied-record consistency only; it does not attest the current deployed state, authenticate an issuer or authorize a release.',
    ],
  };
  return parseInput(
    changeInvestigationSchema,
    { ...body, digest: jsonDigest(body as unknown as JsonValue) },
    'INVALID_ASSURANCE_RESULT',
    'Change investigation',
  );
}

export type CaseReuse = 'needs-new-test' | 'reusable' | 'unresolved';

/**
 * Per-case reading of a comparison, for imported tool/deployment revisions: a changed mapped
 * dependency needs a new test; recorded-unchanged dependencies are reusable (applicability only,
 * never a current verdict); unresolved coverage/mapping stays visible and is never reusable.
 */
export function caseReuse(investigation: ChangeInvestigation): Record<string, CaseReuse> {
  return Object.fromEntries(
    investigation.checks.map((check) => [
      check.id,
      check.validity === 'unknown'
        ? 'unresolved'
        : check.validity === 'stale'
          ? 'needs-new-test'
          : 'reusable',
    ]),
  );
}
