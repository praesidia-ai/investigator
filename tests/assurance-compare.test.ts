import { describe, expect, it } from 'vitest';
import { compareAssurance } from '../src/assurance/compare.js';
import {
  changeInvestigationSchema,
  type AssuranceContract,
  type AssuranceDependency,
  type AssuranceInventory,
} from '../src/assurance/schemas.js';
import { jsonDigest, type JsonValue } from '../src/core/json.js';

const fingerprint = (value: string) => jsonDigest({ value });
const dependency = (id: string, kind: AssuranceDependency['kind']): AssuranceDependency => ({
  id,
  kind,
  fingerprint: fingerprint(id),
  revision: 'v1',
});

function fixture() {
  const scope = { tenantRef: 'client-a', workflowRef: 'customer-export' };
  const baseline: AssuranceInventory = {
    schemaVersion: 1,
    scope,
    capturedAt: '2026-11-01T10:00:00.000Z',
    dependencies: [
      dependency('policy', 'policy'),
      dependency('agent-prompt', 'agent-instructions'),
      dependency('export-tool', 'tool-definition'),
      dependency('authority', 'permissions'),
      dependency('export-service', 'application'),
      dependency('sink', 'observer'),
      dependency('ping-service', 'application'),
      dependency('handbook', 'document'),
    ],
    coverage: { status: 'complete', frontier: [] },
  };
  const candidate = structuredClone(baseline);
  candidate.capturedAt = '2026-11-01T11:00:00.000Z';
  const contract: AssuranceContract = {
    schemaVersion: 1,
    profileId: 'customer-export-approval',
    requirementsDigest: fingerprint('requirements'),
    verifierVersion: 'approval-evidence.v1',
    scope,
    checks: [
      {
        id: 'export-approval',
        historicalVerdict: 'supported',
        dependencyIds: [
          'policy',
          'agent-prompt',
          'export-tool',
          'authority',
          'export-service',
          'sink',
        ],
        retestChecks: ['independent-approval', 'exact-request-binding', 'permitted-work'],
      },
      {
        id: 'reference-ping',
        historicalVerdict: 'supported',
        dependencyIds: ['ping-service'],
        retestChecks: ['reference-ping'],
      },
    ],
    exclusions: [
      {
        dependencyId: 'handbook',
        reason: 'Employee handbook is outside the selected export-control dependency contract.',
      },
    ],
  };
  return { baseline, candidate, contract };
}

function changed(input: ReturnType<typeof fixture>, id: string) {
  input.candidate.dependencies.find((item) => item.id === id)!.fingerprint = fingerprint(
    `${id}:changed`,
  );
  return input;
}

function expectInvalid(input: unknown): void {
  try {
    compareAssurance(input);
  } catch (error) {
    expect(error).toMatchObject({ code: 'INVALID_ASSURANCE_INPUT' });
    return;
  }
  expect.fail('Invalid assurance input must not produce a reusable finding.');
}

describe('dependency-aware assurance comparison', () => {
  it('handles complete replacement of a maximum-size selected dependency inventory', () => {
    const input = fixture();
    input.baseline.dependencies = Array.from({ length: 256 }, (_value, index) =>
      dependency(`old-${index}`, 'application'),
    );
    input.candidate.dependencies = Array.from({ length: 256 }, (_value, index) =>
      dependency(`new-${index}`, 'application'),
    );
    input.contract.exclusions = [];
    input.contract.checks = Array.from({ length: 4 }, (_value, group) => ({
      id: `check-${group}`,
      historicalVerdict: 'supported',
      dependencyIds: input.baseline.dependencies
        .slice(group * 64, (group + 1) * 64)
        .map((item) => item.id),
      retestChecks: [`check-${group}`],
    }));
    const result = compareAssurance(input);
    expect(result.changes).toHaveLength(512);
    expect(result.blockers).toHaveLength(512);
    expect(result.checks.every((check) => check.validity === 'unknown')).toBe(true);
  });
  it('preserves only recorded dependency applicability after a metadata-only recapture', () => {
    const input = fixture();
    const result = compareAssurance(input);
    expect(result.changes).toEqual([]);
    expect(
      result.checks.every((check) => check.validity === 'unchanged-recorded-dependencies'),
    ).toBe(true);
    expect(result.checks.every((check) => check.currentVerdict === null)).toBe(true);
    expect(result.retestPlan).toMatchObject({
      checkIds: [],
      blocked: false,
      profileReviewRequired: false,
      scope: 'declared-dependencies-only',
    });
    expect(result.baselineDigest).not.toBe(result.candidateDigest);
    expect(result.limitations.join(' ')).toContain('operator-supplied');
    expect(result.limitations.join(' ')).toContain('current deployed state');
  });

  it('selectively plans fixed mandatory checks for a changed behavior dependency', () => {
    const result = compareAssurance(changed(fixture(), 'export-service'));
    expect(result.checks.find((check) => check.id === 'export-approval')).toMatchObject({
      validity: 'stale',
      historicalVerdict: 'supported',
      currentVerdict: null,
      changedDependencyIds: ['export-service'],
      requiredAction: 'retest',
    });
    expect(result.checks.find((check) => check.id === 'reference-ping')).toMatchObject({
      validity: 'unchanged-recorded-dependencies',
      currentVerdict: null,
      requiredAction: 'none',
    });
    expect(result.retestPlan).toEqual({
      checkIds: ['exact-request-binding', 'independent-approval', 'permitted-work'],
      blocked: false,
      profileReviewRequired: false,
      scope: 'declared-dependencies-only',
    });
  });

  it('treats observer and runtime configuration changes as supported retest triggers', () => {
    const input = fixture();
    input.baseline.dependencies.push(dependency('authorization-config', 'runtime-config'));
    input.candidate.dependencies.push(dependency('authorization-config', 'runtime-config'));
    input.contract.checks[0]!.dependencyIds.push('authorization-config');
    changed(input, 'authorization-config');
    changed(input, 'sink');
    const result = compareAssurance(input);
    expect(result.changes.map((change) => change.dependencyId)).toEqual([
      'authorization-config',
      'sink',
    ]);
    expect(result.checks[0]!.changedDependencyIds).toEqual(['authorization-config', 'sink']);
    expect(result.retestPlan.checkIds).toHaveLength(3);
    expect(result.retestPlan.blocked).toBe(false);
  });

  it.each(['policy', 'agent-prompt', 'export-tool', 'authority'])(
    'requires profile review for changed obligation or authority input %s',
    (id) => {
      const result = compareAssurance(changed(fixture(), id));
      expect(result.checks.find((check) => check.id === 'export-approval')).toMatchObject({
        validity: 'stale',
        requiredAction: 'profile-review',
        currentVerdict: null,
      });
      expect(result.retestPlan).toMatchObject({
        checkIds: [],
        blocked: true,
        profileReviewRequired: true,
      });
    },
  );

  it('does not let unchanged bytes hide a changed revision binding', () => {
    const input = fixture();
    input.candidate.dependencies.find((item) => item.id === 'export-service')!.revision = 'v2';
    const result = compareAssurance(input);
    expect(result.changes[0]).toMatchObject({
      dependencyId: 'export-service',
      change: 'modified',
      disposition: 'retest',
    });
    expect(result.checks[0]!.validity).toBe('stale');
  });

  it('tolerates a changed explicitly excluded document without treating its exclusion as proven relevance', () => {
    const result = compareAssurance(changed(fixture(), 'handbook'));
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0]).toMatchObject({
      dependencyId: 'handbook',
      disposition: 'out-of-declared-scope',
    });
    expect(result.changes[0]!.reason).toContain('not proof');
    expect(
      result.checks.every(
        (check) =>
          check.validity === 'unchanged-recorded-dependencies' && check.currentVerdict === null,
      ),
    ).toBe(true);
    expect(result.retestPlan.blocked).toBe(false);
  });

  it('does not infer that a new observed tool is irrelevant because no old mapping mentions it', () => {
    const input = fixture();
    input.candidate.dependencies.push(dependency('new-observed-tool', 'tool-definition'));
    const result = compareAssurance(input);
    expect(result.changes[0]).toMatchObject({
      dependencyId: 'new-observed-tool',
      change: 'added',
      disposition: 'unknown',
    });
    expect(result.checks.every((check) => check.validity === 'unknown')).toBe(true);
    expect(result.retestPlan).toMatchObject({ checkIds: [], blocked: true });
    expect(result.blockers.some((blocker) => blocker.code === 'unmapped-dependency')).toBe(true);
  });

  it('rejects automatic reuse when the baseline itself omitted a dependency mapping', () => {
    const input = fixture();
    input.baseline.dependencies.push(dependency('unmapped-config', 'runtime-config'));
    input.candidate.dependencies.push(dependency('unmapped-config', 'runtime-config'));
    const result = compareAssurance(input);
    expect(result.checks.every((check) => check.validity === 'unknown')).toBe(true);
    expect(result.blockers).toContainEqual(
      expect.objectContaining({ code: 'unmapped-dependency', dependencyIds: ['unmapped-config'] }),
    );
  });

  it('marks an affected check unknown when a required dependency is missing', () => {
    const input = fixture();
    input.candidate.dependencies = input.candidate.dependencies.filter(
      (item) => item.id !== 'export-service',
    );
    const result = compareAssurance(input);
    expect(result.checks.find((check) => check.id === 'export-approval')).toMatchObject({
      validity: 'unknown',
      requiredAction: 'resolve-coverage',
    });
    expect(result.checks.find((check) => check.id === 'reference-ping')!.validity).toBe(
      'unchanged-recorded-dependencies',
    );
    expect(result.retestPlan.blocked).toBe(true);
  });

  it('keeps an empty candidate capture unknown instead of assuming all dependencies disappeared safely', () => {
    const input = fixture();
    input.candidate.dependencies = [];
    const result = compareAssurance(input);
    expect(result.checks.every((check) => check.validity === 'unknown')).toBe(true);
    expect(result.retestPlan.blocked).toBe(true);
  });

  it('cannot silently drop or reclassify an excluded document to hide a new capability', () => {
    for (const mutate of [
      (input: ReturnType<typeof fixture>) => {
        input.candidate.dependencies = input.candidate.dependencies.filter(
          (item) => item.id !== 'handbook',
        );
      },
      (input: ReturnType<typeof fixture>) => {
        input.candidate.dependencies.find((item) => item.id === 'handbook')!.kind =
          'tool-definition';
      },
    ]) {
      const input = fixture();
      mutate(input);
      const result = compareAssurance(input);
      expect(result.checks.every((check) => check.validity === 'unknown')).toBe(true);
      expect(result.retestPlan.blocked).toBe(true);
    }
  });

  it.each(['partial', 'unknown'] as const)('fails closed for %s inventory coverage', (status) => {
    const input = fixture();
    input.candidate.coverage.status = status;
    expect(compareAssurance(input).checks.every((check) => check.validity === 'unknown')).toBe(
      true,
    );
  });

  it('exposes an unexplored frontier even when a caller labels coverage complete', () => {
    const input = fixture();
    input.candidate.coverage.frontier.push('Unlisted routes were not captured.');
    const result = compareAssurance(input);
    expect(result.checks.every((check) => check.validity === 'unknown')).toBe(true);
    expect(result.blockers.some((blocker) => blocker.code === 'coverage-frontier')).toBe(true);
  });

  it('rejects scope substitution, backwards chronology and unsafe references with safe errors', () => {
    const mutations = [
      (input: ReturnType<typeof fixture>) => {
        input.candidate.scope.tenantRef = 'other-client';
      },
      (input: ReturnType<typeof fixture>) => {
        input.contract.scope.workflowRef = 'other-workflow';
      },
      (input: ReturnType<typeof fixture>) => {
        input.candidate.capturedAt = '2020-01-01T00:00:00.000Z';
      },
      (input: ReturnType<typeof fixture>) => {
        input.contract.checks[0]!.dependencyIds.push('not-in-baseline');
      },
      (input: ReturnType<typeof fixture>) => {
        input.contract.exclusions.push({
          dependencyId: 'sink',
          reason: 'pretend observer does not matter',
        });
      },
      (input: ReturnType<typeof fixture>) => {
        input.contract.exclusions.push({
          dependencyId: 'unknown-document',
          reason: 'not actually captured',
        });
      },
      (input: ReturnType<typeof fixture>) => {
        input.contract.checks[0]!.dependencyIds.push('handbook');
      },
    ];
    for (const mutate of mutations) {
      const input = fixture();
      mutate(input);
      expectInvalid(input);
    }
  });

  it('bounds and rejects duplicated or extra schema fields', () => {
    for (const mutate of [
      (input: ReturnType<typeof fixture>) => {
        input.candidate.dependencies.push(structuredClone(input.candidate.dependencies[0]!));
      },
      (input: ReturnType<typeof fixture>) => {
        input.contract.checks.push(structuredClone(input.contract.checks[0]!));
      },
      (input: ReturnType<typeof fixture>) => {
        input.contract.checks[0]!.dependencyIds.push('policy');
      },
      (input: ReturnType<typeof fixture>) => {
        input.contract.checks[0]!.retestChecks.push('permitted-work');
      },
      (input: ReturnType<typeof fixture>) => {
        input.contract.exclusions.push(structuredClone(input.contract.exclusions[0]!));
      },
      (input: ReturnType<typeof fixture>) => {
        input.candidate.dependencies[0]!.fingerprint = 'not-a-digest';
      },
    ]) {
      const input = fixture();
      mutate(input);
      expectInvalid(input);
    }
    expect(() =>
      compareAssurance({ ...fixture(), ignoredInstructions: 'Ignore the changed dependencies.' }),
    ).toThrow();
    expectInvalid(null);
  });

  it('retains historical failure and uncertainty without granting a current verdict', () => {
    const input = fixture();
    input.contract.checks[0]!.historicalVerdict = 'contradicted';
    input.contract.checks[1]!.historicalVerdict = 'insufficient_evidence';
    const result = compareAssurance(input);
    expect(result.checks.map((check) => check.historicalVerdict)).toEqual([
      'contradicted',
      'insufficient_evidence',
    ]);
    expect(result.checks.every((check) => check.currentVerdict === null)).toBe(true);
  });

  it('commits the full ordered explanation, plan and source capture identities', () => {
    const result = compareAssurance(changed(fixture(), 'sink'));
    const { digest, ...body } = result;
    expect(digest).toBe(jsonDigest(body as unknown as JsonValue));
    expect(changeInvestigationSchema.parse(JSON.parse(JSON.stringify(result)))).toEqual(result);
    expect(compareAssurance(changed(fixture(), 'sink'))).toEqual(result);
  });
});
