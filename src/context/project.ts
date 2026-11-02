import { validateCitations } from '../core/citations.js';
import type { EvidenceStore } from '../core/evidence-store.js';
import { InvestigatorError } from '../core/errors.js';
import { jsonDigest, stableJson, type JsonValue } from '../core/json.js';
import { parseInput } from '../core/parse.js';
import type { Citation } from '../core/schemas.js';
import {
  clientContextInputSchema,
  clientSystemSnapshotSchema,
  type ClientContextInput,
  type ClientSystemSnapshot,
  type SourceCapability,
  type SourceQualifiedRef,
} from './schemas.js';

/** Tuple encoding avoids delimiter collisions and never joins similar display names. */
export function entityKey(ref: SourceQualifiedRef): string {
  return stableJson([ref.sourceId, ref.tenant, ref.kind, ref.nativeId]);
}

function invalid(message: string): never {
  throw new InvestigatorError('INVALID_CLIENT_CONTEXT', message);
}

function unique(items: readonly string[], label: string): void {
  if (new Set(items).size !== items.length) invalid(`${label} must be unique.`);
}

function inWindow(time: string, window: { from: string; to: string }): boolean {
  return Date.parse(time) >= Date.parse(window.from) && Date.parse(time) <= Date.parse(window.to);
}

function validateReferences(context: ClientContextInput): void {
  unique(
    context.sources.map((source) => source.id),
    'Source IDs',
  );
  unique(
    context.entities.map((entity) => entityKey(entity.ref)),
    'Qualified entity IDs',
  );
  unique(
    context.assertions.map((assertion) => assertion.id),
    'Assertion IDs',
  );
  const sources = new Map(context.sources.map((source) => [source.id, source]));
  const entities = new Map(context.entities.map((entity) => [entityKey(entity.ref), entity]));
  for (const entity of context.entities) {
    const source = sources.get(entity.ref.sourceId);
    if (
      !source ||
      source.tenant !== entity.ref.tenant ||
      !source.entityKinds.includes(entity.ref.kind)
    )
      invalid('Every entity reference must match a selected source, tenant and entity kind.');
  }
  for (const assertion of context.assertions) {
    const subject = entities.get(entityKey(assertion.subject));
    if (!subject || subject.revision !== assertion.sourceRevision)
      invalid('Every assertion must name an existing subject at its recorded revision.');
    if (assertion.object.kind === 'entity' && !entities.has(entityKey(assertion.object.ref)))
      invalid('An assertion object must name an existing qualified entity.');
  }
}

function validateContext(context: ClientContextInput, evidence: EvidenceStore): void {
  validateReferences(context);
  const sources = new Map(context.sources.map((source) => [source.id, source]));
  const entities = new Map(context.entities.map((entity) => [entityKey(entity.ref), entity]));
  let selectedBytes = 0;
  const selectedEvidenceIds = new Set<string>();
  for (const source of context.sources) {
    unique(source.entityKinds, 'Source entity kinds');
    unique(source.permittedReads, 'Source read capabilities');
    unique(source.evidenceIds, 'Source evidence IDs');
    unique(source.frontier, 'Source frontier entries');
    if (!source.permittedReads.includes('read-evidence'))
      invalid('A selected source must permit reading its cited evidence.');
    for (const id of source.evidenceIds) {
      const artifact = evidence.get(id);
      if (!selectedEvidenceIds.has(id)) {
        selectedBytes += artifact.byteLength;
        selectedEvidenceIds.add(id);
      }
      if (source.coverage === 'complete' && artifact.coverage !== 'complete')
        invalid('Source coverage cannot upgrade incomplete evidence to complete.');
    }
  }
  if (selectedEvidenceIds.size > 64 || selectedBytes > 4_194_304)
    invalid('Selected context evidence exceeds the supported count or byte limit.');

  const sourceFor = (ref: SourceQualifiedRef): SourceCapability => {
    const source = sources.get(ref.sourceId);
    if (!source || source.tenant !== ref.tenant || !source.entityKinds.includes(ref.kind))
      invalid('Every entity reference must match a selected source, tenant and entity kind.');
    return source;
  };
  const cite = (citations: readonly Citation[], allowedEvidenceIds: readonly string[]) => {
    if (citations.some((citation) => !allowedEvidenceIds.includes(citation.evidenceId)))
      invalid('Citations must name evidence declared by the relevant selected sources.');
    validateCitations(citations, evidence);
  };
  for (const entity of context.entities) {
    const source = sourceFor(entity.ref);
    if (!source.permittedReads.includes('list-entities'))
      invalid('A source without entity-read capability cannot supply an entity.');
    cite(entity.citations, source.evidenceIds);
  }
  for (const assertion of context.assertions) {
    const subjectSource = sourceFor(assertion.subject);
    const subject = entities.get(entityKey(assertion.subject));
    if (!subject) invalid('An assertion subject must name an existing qualified entity.');
    if (subject.revision !== assertion.sourceRevision)
      invalid('Assertion and subject source revisions must agree.');
    if (!subjectSource.permittedReads.includes('read-relationships'))
      invalid('A source without relationship-read capability cannot supply an assertion.');
    const allowedEvidence = new Set(subjectSource.evidenceIds);
    if (assertion.object.kind === 'entity') {
      const objectSource = sourceFor(assertion.object.ref);
      if (!entities.has(entityKey(assertion.object.ref)))
        invalid('An assertion object must name an existing qualified entity.');
      for (const id of objectSource.evidenceIds) allowedEvidence.add(id);
    }
    cite(assertion.citations, [...allowedEvidence]);
    const earliestSnapshot = Math.min(
      ...assertion.citations.map((citation) =>
        Date.parse(evidence.get(citation.evidenceId).capturedAt),
      ),
    );
    if (Date.parse(assertion.capturedAt) > earliestSnapshot)
      invalid('An assertion capture cannot be later than its cited evidence snapshots.');
    if (
      assertion.observedAt &&
      (!inWindow(assertion.observedAt, context.scope.window) ||
        !inWindow(assertion.observedAt, subjectSource.captureWindow))
    )
      invalid('Observed assertions must fall within the selected and source capture windows.');
    if (
      assertion.observedAt &&
      ((assertion.effectiveFrom &&
        Date.parse(assertion.observedAt) < Date.parse(assertion.effectiveFrom)) ||
        (assertion.effectiveUntil &&
          Date.parse(assertion.observedAt) > Date.parse(assertion.effectiveUntil)))
    )
      invalid('An observed assertion must fall within its effective interval.');
  }
}

/**
 * Projects supplied, cited declarations. It does not discover sources, authenticate
 * imported assertions or execute instructions contained in documents/agent prompts.
 */
export function createClientSystemSnapshot(
  input: unknown,
  evidence: EvidenceStore,
): ClientSystemSnapshot {
  const context = parseInput(
    clientContextInputSchema,
    input,
    'INVALID_CLIENT_CONTEXT',
    'Client context',
  );
  if (Buffer.byteLength(stableJson(context as unknown as JsonValue), 'utf8') > 4_194_304)
    invalid('The structured client context exceeds its byte limit.');
  validateContext(context, evidence);
  const ids = [...new Set(context.sources.flatMap((source) => source.evidenceIds))].sort();
  const evidenceManifest = ids.map((id) => {
    const { sha256, byteLength, capturedAt, coverage } = evidence.get(id);
    return { id, sha256, byteLength, capturedAt, coverage };
  });
  const body = {
    format: 'investigator-client-context-v1' as const,
    context,
    evidenceManifest,
    scope: 'selected-sources-only' as const,
    authenticity: 'not-established' as const,
  };
  return { ...body, digest: jsonDigest(body as unknown as JsonValue) };
}

/** Checks consistency against actual evidence snapshots, not trusted authorship. */
export function verifyClientSystemSnapshot(
  input: unknown,
  evidence: EvidenceStore,
): ClientSystemSnapshot {
  const snapshot = parseInput(
    clientSystemSnapshotSchema,
    input,
    'INVALID_CLIENT_CONTEXT',
    'Client snapshot',
  );
  const expected = createClientSystemSnapshot(snapshot.context, evidence);
  if (stableJson(snapshot as unknown as JsonValue) !== stableJson(expected as unknown as JsonValue))
    invalid('The client snapshot does not match its supplied context and evidence.');
  return expected;
}

/** A supplied self-commitment is only an integrity check, never trusted authorship. */
export function checkClientSystemSnapshotDigest(input: unknown): ClientSystemSnapshot {
  const snapshot = parseInput(
    clientSystemSnapshotSchema,
    input,
    'INVALID_CLIENT_CONTEXT',
    'Client snapshot',
  );
  const { digest, ...body } = snapshot;
  if (jsonDigest(body as unknown as JsonValue) !== digest)
    invalid('The client snapshot digest does not match its contents.');
  validateReferences(snapshot.context);
  return snapshot;
}
