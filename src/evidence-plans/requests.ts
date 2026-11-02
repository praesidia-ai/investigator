import { z } from 'zod';
import { validateCitations } from '../core/citations.js';
import type { EvidenceStore } from '../core/evidence-store.js';
import { InvestigatorError } from '../core/errors.js';
import { parseInput } from '../core/parse.js';
import { citationSchema } from '../core/schemas.js';
import type { ClientSystemSnapshot } from '../context/schemas.js';
import { EXPORT_EVIDENCE_REQUIREMENTS } from './requirements.js';

export const evidenceRequestSchema = z
  .object({
    action: z.enum(['instrument-authored-example', 'request-source-access']),
    gapIds: z.array(z.string().min(1).max(160)).min(1).max(16),
    sourceId: z.string().min(1).max(160),
    producerCitation: citationSchema,
    fields: z.array(z.enum(EXPORT_EVIDENCE_REQUIREMENTS.collectionFields)).max(10),
    explanation: z.string().min(1).max(4096),
  })
  .strict();
export type EvidenceRequest = z.infer<typeof evidenceRequestSchema>;

/** A proposal never creates a new capability or changes the host's proof obligations. */
export function validateEvidenceRequest(
  input: unknown,
  options: {
    readonly snapshot: ClientSystemSnapshot;
    readonly evidence: EvidenceStore;
    readonly gapIds: readonly string[];
    readonly producerEvidenceId: string;
  },
): EvidenceRequest {
  const request = parseInput(
    evidenceRequestSchema,
    input,
    'INVALID_EVIDENCE_REQUEST',
    'Evidence request',
  );
  const source = options.snapshot.context.sources.find(
    (candidate) => candidate.id === request.sourceId,
  );
  if (
    !source ||
    !source.permittedReads.includes('read-evidence') ||
    !source.evidenceIds.includes(request.producerCitation.evidenceId) ||
    request.producerCitation.evidenceId !== options.producerEvidenceId ||
    request.gapIds.some((id) => !options.gapIds.includes(id)) ||
    new Set(request.gapIds).size !== request.gapIds.length ||
    new Set(request.fields).size !== request.fields.length
  )
    throw new InvestigatorError(
      'INVALID_EVIDENCE_REQUEST',
      'The request exceeds the selected source or diagnosed gaps.',
    );
  validateCitations([request.producerCitation], options.evidence);
  if (
    request.action === 'instrument-authored-example' &&
    EXPORT_EVIDENCE_REQUIREMENTS.collectionFields.some((field) => !request.fields.includes(field))
  )
    throw new InvestigatorError(
      'INVALID_EVIDENCE_REQUEST',
      'The supported recipe requires its complete declared witness schema.',
    );
  return request;
}
