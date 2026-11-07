import { z } from 'zod';
import {
  identifierSchema as identifier,
  shortTextSchema as text,
  digestSchema as digest,
} from '../core/schemas.js';

export const assuranceScopeSchema = z
  .object({
    tenantRef: text,
    workflowRef: text,
  })
  .strict();
export const assuranceDependencySchema = z
  .object({
    id: identifier,
    kind: z.enum([
      'policy',
      'agent-instructions',
      'tool-definition',
      'permissions',
      'application',
      'runtime-config',
      'observer',
      'document',
    ]),
    fingerprint: digest,
    revision: z.string().min(1).max(256),
  })
  .strict();
export type AssuranceDependency = z.infer<typeof assuranceDependencySchema>;

export const assuranceInventorySchema = z
  .object({
    schemaVersion: z.literal(1),
    scope: assuranceScopeSchema,
    capturedAt: z.iso.datetime(),
    dependencies: z.array(assuranceDependencySchema).max(256),
    coverage: z
      .object({
        status: z.enum(['complete', 'partial', 'unknown']),
        frontier: z.array(text).max(64),
      })
      .strict(),
  })
  .strict()
  .superRefine((inventory, context) => {
    if (
      new Set(inventory.dependencies.map((dependency) => dependency.id)).size !==
      inventory.dependencies.length
    )
      context.addIssue({
        code: 'custom',
        path: ['dependencies'],
        message: 'Dependency IDs must be unique',
      });
    if (new Set(inventory.coverage.frontier).size !== inventory.coverage.frontier.length)
      context.addIssue({
        code: 'custom',
        path: ['coverage', 'frontier'],
        message: 'Coverage frontier entries must be unique',
      });
  });
export type AssuranceInventory = z.infer<typeof assuranceInventorySchema>;

export const assuranceCheckSchema = z
  .object({
    id: identifier,
    historicalVerdict: z.enum(['supported', 'contradicted', 'insufficient_evidence']),
    dependencyIds: z.array(identifier).min(1).max(64),
    retestChecks: z.array(identifier).min(1).max(32),
  })
  .strict()
  .superRefine((check, context) => {
    for (const field of ['dependencyIds', 'retestChecks'] as const) {
      if (new Set(check[field]).size !== check[field].length)
        context.addIssue({
          code: 'custom',
          path: [field],
          message: 'Check references must be unique',
        });
    }
  });

export const assuranceContractSchema = z
  .object({
    schemaVersion: z.literal(1),
    profileId: identifier,
    requirementsDigest: digest,
    verifierVersion: z.string().min(1).max(256),
    scope: assuranceScopeSchema,
    checks: z.array(assuranceCheckSchema).min(1).max(32),
    exclusions: z.array(z.object({ dependencyId: identifier, reason: text }).strict()).max(64),
  })
  .strict()
  .superRefine((contract, context) => {
    if (new Set(contract.checks.map((check) => check.id)).size !== contract.checks.length)
      context.addIssue({ code: 'custom', path: ['checks'], message: 'Check IDs must be unique' });
    if (
      new Set(contract.exclusions.map((exclusion) => exclusion.dependencyId)).size !==
      contract.exclusions.length
    )
      context.addIssue({
        code: 'custom',
        path: ['exclusions'],
        message: 'Exclusion references must be unique',
      });
  });
export type AssuranceContract = z.infer<typeof assuranceContractSchema>;

export const assuranceComparisonInputSchema = z
  .object({
    baseline: assuranceInventorySchema,
    candidate: assuranceInventorySchema,
    contract: assuranceContractSchema,
  })
  .strict();

export const dependencyChangeSchema = z
  .object({
    dependencyId: identifier,
    change: z.enum(['added', 'removed', 'modified', 'kind-changed']),
    before: assuranceDependencySchema.nullable(),
    after: assuranceDependencySchema.nullable(),
    disposition: z.enum(['retest', 'profile-review', 'out-of-declared-scope', 'unknown']),
    reason: text,
  })
  .strict();
export type DependencyChange = z.infer<typeof dependencyChangeSchema>;

export const checkFreshnessSchema = z
  .object({
    id: identifier,
    historicalVerdict: z.enum(['supported', 'contradicted', 'insufficient_evidence']),
    currentVerdict: z.null(),
    validity: z.enum(['unchanged-recorded-dependencies', 'stale', 'unknown']),
    changedDependencyIds: z.array(identifier).max(64),
    requiredAction: z.enum(['none', 'retest', 'profile-review', 'resolve-coverage']),
    reasons: z.array(text).min(1).max(64),
  })
  .strict();
export type CheckFreshness = z.infer<typeof checkFreshnessSchema>;

export const assuranceBlockerSchema = z
  .object({
    code: z.enum([
      'incomplete-coverage',
      'coverage-frontier',
      'unmapped-dependency',
      'missing-dependency',
      'dependency-kind-changed',
    ]),
    dependencyIds: z.array(identifier).max(256),
    reason: text,
  })
  .strict();
export type AssuranceBlocker = z.infer<typeof assuranceBlockerSchema>;

export const changeInvestigationSchema = z
  .object({
    format: z.literal('investigator-assurance-change-v1'),
    scope: assuranceScopeSchema,
    baselineDigest: digest,
    candidateDigest: digest,
    contractDigest: digest,
    changes: z.array(dependencyChangeSchema).max(512),
    checks: z.array(checkFreshnessSchema).min(1).max(32),
    blockers: z.array(assuranceBlockerSchema).max(515),
    retestPlan: z
      .object({
        checkIds: z.array(identifier).max(1024),
        blocked: z.boolean(),
        profileReviewRequired: z.boolean(),
        scope: z.literal('declared-dependencies-only'),
      })
      .strict(),
    limitations: z.array(text).min(1).max(16),
    digest,
  })
  .strict();
export type ChangeInvestigation = z.infer<typeof changeInvestigationSchema>;
