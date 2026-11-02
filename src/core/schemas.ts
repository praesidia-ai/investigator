import { z } from 'zod';
import {
  CONTROL_RESULT_EVIDENCE_IDS,
  CUSTOMER_EXPORT_APPROVAL_PROFILE,
} from './control-profiles.js';
import type { JsonValue } from './json.js';

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);
const identifier = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const boundedText = z.string().min(1).max(16_384);
export const assessmentModeSchema = z.enum(['documentary', 'recorded-behavior', 'controlled-test']);
export type AssessmentMode = z.infer<typeof assessmentModeSchema>;
export const controlProfileSchema = z
  .object({
    id: z.literal(CUSTOMER_EXPORT_APPROVAL_PROFILE.id),
    version: z.literal(CUSTOMER_EXPORT_APPROVAL_PROFILE.version),
  })
  .strict();
export const criterionEvidenceSchema = z
  .object({
    checkId: identifier,
    evidenceIds: z.array(identifier).min(1).max(64),
  })
  .strict();
export const referenceVariantSchema = z.enum([
  'request-unbound',
  'request-bound',
  'block-all',
  'false-refusal',
  'unavailable',
]);
export type ReferenceVariant = z.infer<typeof referenceVariantSchema>;
export const sourceDeclarationSchema = z
  .object({
    id: identifier,
    path: z.string().min(1).max(1024),
    mediaType: z.enum(['text/plain', 'text/markdown', 'application/json']),
    coverage: z.enum(['complete', 'partial', 'unknown']),
    redacted: z.boolean().default(false),
  })
  .strict();
export const controlCaseSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: identifier,
    claim: boundedText,
    assessmentMode: assessmentModeSchema.default('documentary'),
    controlProfile: controlProfileSchema.optional(),
    subject: z
      .object({
        id: identifier,
        environment: z.enum(['reference-test', 'repository', 'deployment-evidence']),
        revision: z.string().min(1).max(256),
      })
      .strict(),
    requiredChecks: z.array(identifier).min(1).max(32),
    criterionEvidence: z.array(criterionEvidenceSchema).min(1).max(32).optional(),
    sources: z.array(sourceDeclarationSchema).min(1).max(64),
    referenceTarget: z
      .object({ kind: z.literal('customer-export-reference'), variant: referenceVariantSchema })
      .strict()
      .optional(),
    controlledTarget: z
      .object({
        kind: identifier,
        version: z.literal(1),
        configurationDigest: digest.optional(),
      })
      .strict()
      .optional(),
    workContext: z
      .object({
        objective: boundedText,
        accountableParty: z.string().min(1).max(256),
        parentWorkRef: z.string().min(1).max(256).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const issue = (path: (string | number)[], message: string): void => {
      context.addIssue({ code: 'custom', path, message });
    };
    if (value.referenceTarget && value.subject.environment !== 'reference-test') {
      context.addIssue({
        code: 'custom',
        path: ['referenceTarget'],
        message: 'Reference targets require reference-test scope',
      });
    }
    if (
      value.sources.some((source) => CONTROL_RESULT_EVIDENCE_IDS.some((id) => id === source.id))
    ) {
      context.addIssue({
        code: 'custom',
        path: ['sources'],
        message: 'The reference result ID is reserved',
      });
    }
    if (new Set(value.sources.map((source) => source.id)).size !== value.sources.length) {
      context.addIssue({
        code: 'custom',
        path: ['sources'],
        message: 'Evidence IDs must be unique',
      });
    }
    if (new Set(value.requiredChecks).size !== value.requiredChecks.length) {
      context.addIssue({
        code: 'custom',
        path: ['requiredChecks'],
        message: 'Check IDs must be unique',
      });
    }
    if (value.referenceTarget && value.controlledTarget) {
      issue(['controlledTarget'], 'Select only one control target');
    }
    if (
      value.controlledTarget &&
      (value.subject.environment !== 'repository' ||
        !digest.safeParse(value.subject.revision).success)
    ) {
      issue(
        ['subject'],
        'Controlled application targets require repository scope and a SHA-256 source revision',
      );
    }
    if (
      value.controlledTarget &&
      value.controlledTarget.kind !== 'local-http-export' &&
      !value.controlledTarget.configurationDigest
    )
      issue(
        ['controlledTarget', 'configurationDigest'],
        'External target transports require an operator configuration digest',
      );
    if (
      (value.referenceTarget || value.controlledTarget) &&
      (value.assessmentMode !== 'controlled-test' || !value.controlProfile)
    ) {
      issue(['assessmentMode'], 'Control targets require a known profile and controlled-test mode');
    }
    if (value.controlProfile) {
      if (value.claim !== CUSTOMER_EXPORT_APPROVAL_PROFILE.claim) {
        issue(['claim'], 'The claim must match its versioned control profile');
      }
      const expected = CUSTOMER_EXPORT_APPROVAL_PROFILE.requiredChecks;
      if (
        value.requiredChecks.length !== expected.length ||
        expected.some((id) => !value.requiredChecks.includes(id))
      ) {
        issue(['requiredChecks'], 'Every check in the versioned control profile is mandatory');
      }
      if (
        !value.criterionEvidence ||
        value.criterionEvidence.length !== expected.length ||
        expected.some((id) => !value.criterionEvidence?.some((entry) => entry.checkId === id))
      ) {
        issue(['criterionEvidence'], 'Declare input evidence for every mandatory criterion');
      }
    }
    if (value.criterionEvidence) {
      const sourceIds = new Set(value.sources.map((source) => source.id));
      const checkIds = new Set<string>();
      for (const [index, dependency] of value.criterionEvidence.entries()) {
        if (
          checkIds.has(dependency.checkId) ||
          !value.requiredChecks.includes(dependency.checkId)
        ) {
          issue(
            ['criterionEvidence', index, 'checkId'],
            'Criterion dependencies must name distinct required checks',
          );
        }
        checkIds.add(dependency.checkId);
        if (
          new Set(dependency.evidenceIds).size !== dependency.evidenceIds.length ||
          dependency.evidenceIds.some((id) => !sourceIds.has(id))
        ) {
          issue(
            ['criterionEvidence', index, 'evidenceIds'],
            'Dependencies must name distinct declared evidence sources',
          );
        }
      }
    }
  });
export type ControlCase = z.infer<typeof controlCaseSchema>;

export const evidenceArtifactSchema = z
  .object({
    id: identifier,
    source: z
      .object({
        kind: z.enum(['local-file', 'reference-check', 'controlled-check']),
        reference: z.string().min(1).max(1024),
      })
      .strict(),
    mediaType: z.enum(['text/plain', 'text/markdown', 'application/json']),
    capturedAt: z.iso.datetime(),
    sha256: digest,
    byteLength: z.number().int().nonnegative().max(1_048_576),
    content: z.string().max(1_048_576),
    coverage: z.enum(['complete', 'partial', 'unknown']),
    redacted: z.boolean(),
  })
  .strict();
export type EvidenceArtifact = z.infer<typeof evidenceArtifactSchema>;

export const locatorSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('lines'),
      start: z.number().int().min(1),
      end: z.number().int().min(1),
    })
    .strict(),
  z.object({ kind: z.literal('json-pointer'), pointer: z.string().max(2048) }).strict(),
]);
export type EvidenceLocator = z.infer<typeof locatorSchema>;
export const citationSchema = z
  .object({ evidenceId: identifier, locator: locatorSchema, quote: boundedText })
  .strict();
export type Citation = z.infer<typeof citationSchema>;

export const checkResultSchema = z
  .object({
    id: identifier,
    status: z.enum(['PASS', 'FAIL', 'INCOMPLETE', 'ERROR']),
    summary: boundedText,
    observations: z.array(jsonValueSchema).max(64),
  })
  .strict();
export type CheckResult = z.infer<typeof checkResultSchema>;
export const findingSchema = z
  .object({
    verdict: z.enum(['supported', 'contradicted', 'insufficient_evidence']),
    statement: boundedText,
    citations: z.array(citationSchema).max(32),
    missingEvidence: z.array(z.string().min(1).max(1024)).max(32),
  })
  .strict();
export type Finding = z.infer<typeof findingSchema>;
