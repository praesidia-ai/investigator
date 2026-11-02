import { z } from 'zod';
import { citationSchema } from '../core/schemas.js';

const identifier = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/);
const text = z.string().min(1).max(2048);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const clientEntityKindSchema = z.enum([
  'system',
  'agent',
  'document',
  'identity',
  'tool',
  'data-store',
  'workflow',
  'approval',
  'queue',
]);
export const sourceQualifiedRefSchema = z
  .object({
    sourceId: identifier,
    tenant: text,
    kind: clientEntityKindSchema,
    nativeId: text,
  })
  .strict();
export type SourceQualifiedRef = z.infer<typeof sourceQualifiedRefSchema>;

export const contextWindowSchema = z
  .object({
    from: z.iso.datetime(),
    to: z.iso.datetime(),
  })
  .strict()
  .refine((window) => Date.parse(window.from) <= Date.parse(window.to), {
    message: 'Window end must not precede its start',
  });
export const sourceCapabilitySchema = z
  .object({
    id: identifier,
    tenant: text,
    kind: z.enum(['local-bundle', 'api-export', 'praesidia']),
    entityKinds: z.array(clientEntityKindSchema).min(1).max(9),
    permittedReads: z
      .array(z.enum(['list-entities', 'read-evidence', 'read-relationships']))
      .max(3),
    evidenceIds: z.array(identifier).min(1).max(64),
    coverage: z.enum(['complete', 'partial', 'unknown']),
    captureWindow: contextWindowSchema,
    pagination: z.enum(['complete', 'partial', 'unknown', 'not-applicable']),
    frontier: z.array(text).max(64),
  })
  .strict();
export type SourceCapability = z.infer<typeof sourceCapabilitySchema>;

export const clientEntitySchema = z
  .object({
    ref: sourceQualifiedRefSchema,
    displayName: text,
    revision: z.string().min(1).max(256),
    citations: z.array(citationSchema).min(1).max(16),
  })
  .strict();
export type ClientEntity = z.infer<typeof clientEntitySchema>;

export const contextAssertionSchema = z
  .object({
    id: identifier,
    subject: sourceQualifiedRefSchema,
    relation: identifier,
    object: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('entity'), ref: sourceQualifiedRefSchema }).strict(),
      z.object({ kind: z.literal('value'), value: text }).strict(),
    ]),
    basis: z.enum(['declared', 'configured', 'observed', 'derived']),
    citations: z.array(citationSchema).min(1).max(16),
    sourceRevision: z.string().min(1).max(256),
    effectiveFrom: z.iso.datetime().nullable(),
    effectiveUntil: z.iso.datetime().nullable(),
    observedAt: z.iso.datetime().nullable(),
    capturedAt: z.iso.datetime(),
    verification: z.enum(['unverified', 'integrity-checked', 'source-authenticated']),
    assessment: z.enum(['supported', 'contradicted', 'unresolved']),
  })
  .strict()
  .superRefine((assertion, context) => {
    const issue = (path: string, message: string) => {
      context.addIssue({ code: 'custom', path: [path], message });
    };
    if (assertion.basis === 'observed' && assertion.observedAt === null)
      issue('observedAt', 'Observed assertions need an observation time');
    if (assertion.basis !== 'observed' && assertion.observedAt !== null)
      issue('observedAt', 'Only observed assertions declare an observation time');
    if (
      assertion.effectiveFrom &&
      assertion.effectiveUntil &&
      Date.parse(assertion.effectiveFrom) > Date.parse(assertion.effectiveUntil)
    )
      issue('effectiveUntil', 'Effective end must not precede start');
    if (assertion.observedAt && Date.parse(assertion.observedAt) > Date.parse(assertion.capturedAt))
      issue('capturedAt', 'Capture must not precede observation');
  });
export type ContextAssertion = z.infer<typeof contextAssertionSchema>;

export const clientContextInputSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: identifier,
    scope: z
      .object({
        tenantRef: text,
        workflowRef: text,
        window: contextWindowSchema,
        excludedResources: z.array(text).max(64),
      })
      .strict(),
    sources: z.array(sourceCapabilitySchema).min(1).max(32),
    entities: z.array(clientEntitySchema).min(1).max(512),
    assertions: z.array(contextAssertionSchema).max(2048),
    unresolvedQuestions: z.array(text).max(128),
  })
  .strict();
export type ClientContextInput = z.infer<typeof clientContextInputSchema>;

export const clientSystemSnapshotSchema = z
  .object({
    format: z.literal('investigator-client-context-v1'),
    context: clientContextInputSchema,
    evidenceManifest: z
      .array(
        z
          .object({
            id: identifier,
            sha256: digest,
            byteLength: z.number().int().min(0).max(1_048_576),
            capturedAt: z.iso.datetime(),
            coverage: z.enum(['complete', 'partial', 'unknown']),
          })
          .strict(),
      )
      .min(1)
      .max(64),
    digest,
    scope: z.literal('selected-sources-only'),
    authenticity: z.literal('not-established'),
  })
  .strict();
export type ClientSystemSnapshot = z.infer<typeof clientSystemSnapshotSchema>;

export const contextQuerySchema = z
  .object({
    anchors: z.array(sourceQualifiedRefSchema).min(1).max(32),
    maxDepth: z.number().int().min(0).max(8),
    maxEntities: z.number().int().min(1).max(256),
    relations: z.array(identifier).min(1).max(32).optional(),
  })
  .strict();
export type ContextQuery = z.infer<typeof contextQuerySchema>;

export interface ContextQueryResult {
  readonly entities: readonly ClientEntity[];
  readonly assertions: readonly ContextAssertion[];
  readonly frontier: readonly {
    readonly reason:
      'depth-limit' | 'entity-limit' | 'source-boundary' | 'excluded-resource' | 'relation-filter';
    readonly reference: string;
  }[];
  readonly truncated: boolean;
  readonly scope: 'selected-sources-only';
  readonly completeness: 'not-established';
}
