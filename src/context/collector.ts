import { z } from 'zod';
import type { AssuranceDependency, AssuranceInventory } from '../assurance/schemas.js';
import { assuranceDependencySchema } from '../assurance/schemas.js';
import { boundedJsonValueSchema as boundedJson } from '../core/bounded-json.js';
import { validateCitations } from '../core/citations.js';
import { InvestigatorError } from '../core/errors.js';
import { EvidenceStore } from '../core/evidence-store.js';
import { jsonDigest, sha256, stableJson, type JsonValue } from '../core/json.js';
import { parseInput, parseJson } from '../core/parse.js';
import {
  citationSchema,
  evidenceArtifactSchema,
  jsonValueSchema,
  type EvidenceArtifact,
} from '../core/schemas.js';
import { decodeUtf8, readBoundedFile } from '../io/read-file.js';
import { loadClientContext } from './load.js';
import { loadMcpExport } from './load-mcp.js';
import { entityKey } from './project.js';
import {
  clientEntityKindSchema,
  clientEntitySchema,
  contextAssertionSchema,
  contextWindowSchema,
  sourceCapabilitySchema,
  sourceQualifiedRefSchema,
  type ClientEntity,
  type ContextAssertion,
  type SourceCapability,
  type SourceQualifiedRef,
} from './schemas.js';

const identifier = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/);
const text = z.string().min(1).max(2048);

/** Relationship provenance, reused from the context contract. */
export type RelationshipBasis = ContextAssertion['basis'];

/**
 * Why part of the world was not explored. Only `caveat` is non-blocking: a standing limit that
 * does not by itself say something is missing.
 */
export const frontierKindSchema = z.enum([
  'missing-page',
  'missing-trace',
  'dropped-data',
  'unlisted',
  'collector-failed',
  'caveat',
]);
export const frontierEntrySchema = z
  .object({ kind: frontierKindSchema, sourceId: identifier, detail: text })
  .strict();
export type FrontierEntry = z.infer<typeof frontierEntrySchema>;

/** An operation a collector saw happen. A collector can never claim a destination effect. */
export const collectedOperationSchema = z
  .object({
    id: identifier,
    subject: sourceQualifiedRefSchema,
    name: text,
    status: z.enum(['ok', 'error', 'unknown']),
    observedAt: z.iso.datetime(),
    basis: z.literal('observed'),
    effectEvidence: z.literal('none'),
    /** Attributes outside the pinned vocabulary, kept verbatim. */
    retainedAttributes: z.record(z.string().max(256), jsonValueSchema).optional(),
    citations: z.array(citationSchema).min(1).max(16),
  })
  .strict();
export type CollectedOperation = z.infer<typeof collectedOperationSchema>;

/** What a read-only collector returns. Inventory and observations only; no execution authority. */
export const collectionResultSchema = z
  .object({
    format: z.literal('investigator-collection-v1'),
    collectorId: identifier,
    sources: z.array(sourceCapabilitySchema).min(1).max(32),
    entities: z.array(clientEntitySchema).max(512),
    assertions: z.array(contextAssertionSchema).max(2048),
    operations: z.array(collectedOperationSchema).max(2048),
    dependencies: z.array(assuranceDependencySchema).max(256),
    evidence: z.array(evidenceArtifactSchema).max(64),
    frontier: z.array(frontierEntrySchema).max(128),
  })
  .strict();
export type CollectionResult = z.infer<typeof collectionResultSchema>;

export interface Collector {
  readonly id: string;
  /** Must only read operator-selected local data. */
  collect(): Promise<CollectionResult>;
}

export interface MergedCollection {
  readonly format: 'investigator-collection-merged-v1';
  readonly collectors: readonly string[];
  readonly sources: readonly SourceCapability[];
  readonly entities: readonly ClientEntity[];
  readonly assertions: readonly ContextAssertion[];
  readonly operations: readonly CollectedOperation[];
  readonly dependencies: readonly AssuranceDependency[];
  readonly evidence: readonly EvidenceArtifact[];
  readonly frontier: readonly FrontierEntry[];
  readonly coverage: 'complete' | 'partial' | 'unknown';
  readonly authority: 'inventory-only';
}

function bad(message: string, code = 'INVALID_COLLECTION'): never {
  throw new InvestigatorError(code, message);
}

/** Validate one result: refs belong to a declared source, citations resolve in its own evidence. */
export function validateCollection(input: unknown): CollectionResult {
  const result = parseInput(collectionResultSchema, input, 'INVALID_COLLECTION', 'Collection');
  const sources = new Map(result.sources.map((s) => [s.id, s]));
  if (sources.size !== result.sources.length) bad('Source IDs must be unique.');
  const store = new EvidenceStore(result.evidence);
  const fits = (ref: SourceQualifiedRef) => {
    const source = sources.get(ref.sourceId);
    return source?.tenant === ref.tenant && source.entityKinds.includes(ref.kind);
  };
  const keys = result.entities.map((e) => entityKey(e.ref));
  if (new Set(keys).size !== keys.length) bad('Qualified entity IDs must be unique.');
  if (
    !result.entities.every((e) => fits(e.ref)) ||
    !result.operations.every((o) => fits(o.subject))
  )
    bad('Every reference must match a declared source, tenant and entity kind.');
  const known = new Set(keys);
  for (const a of result.assertions) {
    const refs = [a.subject, ...(a.object.kind === 'entity' ? [a.object.ref] : [])];
    if (!refs.every((r) => fits(r) && known.has(entityKey(r))))
      bad(
        'Every assertion must name entities of this collection within a declared source and tenant.',
      );
  }
  for (const item of [...result.entities, ...result.assertions, ...result.operations])
    validateCitations(item.citations, store);
  for (const source of result.sources)
    if (source.evidenceIds.some((id) => !result.evidence.some((e) => e.id === id)))
      bad('A source names evidence the collection does not carry.');
  if (!result.frontier.every((f) => sources.has(f.sourceId)))
    bad('Frontier names an unknown source.');
  return result;
}

const unique = (values: readonly string[], label: string) => {
  if (new Set(values).size !== values.length)
    bad(`${label} must be unique across collectors.`, 'COLLECTION_CONFLICT');
};

/**
 * Run collectors one after another and merge. A failing or incomplete collector never vanishes:
 * it becomes frontier. Same-named entities in different tenants/sources stay distinct (tuple key).
 */
export async function runCollectors(collectors: readonly Collector[]): Promise<MergedCollection> {
  const good: CollectionResult[] = [];
  const frontier: FrontierEntry[] = [];
  for (const collector of collectors) {
    try {
      good.push(validateCollection(await collector.collect()));
    } catch (error) {
      const code = error instanceof InvestigatorError ? error.code : 'UNEXPECTED_ERROR';
      frontier.push({
        kind: 'collector-failed',
        sourceId: collector.id.replace(/[^a-zA-Z0-9._:-]/g, '_').slice(0, 160) || 'collector',
        detail: `Collector ${collector.id.slice(0, 120)} failed (${code}); nothing from it was merged.`,
      });
    }
  }
  const sources = good.flatMap((r) => r.sources);
  const entities = good.flatMap((r) => r.entities);
  const assertions = good.flatMap((r) => r.assertions);
  const operations = good.flatMap((r) => r.operations);
  const dependencies = good.flatMap((r) => r.dependencies);
  unique(
    sources.map((s) => s.id),
    'Source IDs',
  );
  unique(
    entities.map((e) => entityKey(e.ref)),
    'Qualified entity IDs',
  );
  unique(
    assertions.map((a) => a.id),
    'Assertion IDs',
  );
  unique(
    operations.map((o) => o.id),
    'Operation IDs',
  );
  unique(
    dependencies.map((d) => d.id),
    'Dependency IDs',
  );
  unique(
    good.flatMap((r) => r.evidence.map((e) => e.id)),
    'Evidence IDs',
  );
  frontier.push(...good.flatMap((r) => r.frontier));
  for (const source of sources) {
    const explained = frontier.some((f) => f.sourceId === source.id && f.kind !== 'caveat');
    if (!explained && (source.pagination === 'partial' || source.pagination === 'unknown'))
      frontier.push({
        kind: 'missing-page',
        sourceId: source.id,
        detail: `Source ${source.id} reports ${source.pagination} pagination without naming what is missing.`,
      });
  }
  const blocked = frontier.some((f) => f.kind !== 'caveat');
  const states = sources.map((s) => s.coverage);
  const coverage =
    !sources.length ||
    states.includes('unknown') ||
    frontier.some((f) => f.kind === 'collector-failed')
      ? 'unknown'
      : blocked || states.includes('partial')
        ? 'partial'
        : 'complete';
  return {
    format: 'investigator-collection-merged-v1',
    collectors: collectors.map((c) => c.id),
    sources,
    entities,
    assertions,
    operations,
    dependencies,
    evidence: good.flatMap((r) => r.evidence),
    frontier,
    coverage,
    authority: 'inventory-only',
  };
}

/**
 * Project a merge to an assurance inventory. 'complete' requires the operator to say so AND no
 * blocking frontier or partial/unknown source; otherwise compareAssurance blocks automatic reuse.
 */
export function toAssuranceInventory(
  merged: MergedCollection,
  options: {
    scope: { tenantRef: string; workflowRef: string };
    capturedAt: string;
    operatorDeclaresComplete: boolean;
  },
): AssuranceInventory {
  const blocking = merged.frontier
    .filter((f) => f.kind !== 'caveat')
    .map((f) => `${f.kind}: ${f.detail}`.slice(0, 2048));
  const unique = [...new Set(blocking)];
  const clean = merged.coverage === 'complete' && !unique.length;
  const frontier =
    unique.length > 64
      ? [...unique.slice(0, 63), `${unique.length - 63} more frontier entries omitted.`]
      : unique;
  return {
    schemaVersion: 1,
    scope: options.scope,
    capturedAt: options.capturedAt,
    dependencies: [...merged.dependencies],
    coverage: {
      status:
        merged.coverage === 'unknown'
          ? 'unknown'
          : clean && options.operatorDeclaresComplete
            ? 'complete'
            : 'partial',
      frontier,
    },
  };
}

/* ------------------------------ collectors ------------------------------ */

function caveats(source: SourceCapability): FrontierEntry[] {
  const missing = source.pagination === 'partial';
  return source.frontier.map((detail) => ({
    kind:
      missing && /nextCursor|page/i.test(detail) ? ('missing-page' as const) : ('caveat' as const),
    sourceId: source.id,
    detail,
  }));
}

/** Saved MCP tools/list export (mcp-source.json + tools.json). Advertised tools are inventory only. */
export function mcpExportCollector(directory: string): Collector {
  return {
    id: 'mcp-export',
    async collect() {
      const imported = await loadMcpExport(directory);
      const context = imported.snapshot.context;
      return {
        format: 'investigator-collection-v1',
        collectorId: 'mcp-export',
        sources: context.sources,
        entities: context.entities,
        assertions: context.assertions,
        operations: [],
        dependencies: imported.dependencies.map((d) => ({
          id: d.id.slice(0, 160),
          kind: d.kind,
          fingerprint: d.fingerprint,
          revision: d.revision,
        })),
        evidence: imported.evidence,
        frontier: context.sources.flatMap(caveats),
      };
    },
  };
}

/** Local document case bundle (case.json + context.json). Each document is a fingerprinted dependency. */
export function localDocumentsCollector(directory: string): Collector {
  return {
    id: 'local-documents',
    async collect() {
      const loaded = await loadClientContext(directory);
      const context = loaded.snapshot.context;
      const evidence = loaded.evidence.all();
      return {
        format: 'investigator-collection-v1',
        collectorId: 'local-documents',
        sources: context.sources,
        entities: context.entities,
        assertions: context.assertions,
        operations: [],
        dependencies: evidence.map((e) => ({
          id: `document:${e.id}`.slice(0, 160),
          kind: 'document' as const,
          fingerprint: e.sha256,
          revision: e.sha256.slice(0, 16),
        })),
        evidence,
        frontier: [
          ...context.sources.flatMap(caveats),
          ...context.unresolvedQuestions.map((detail) => ({
            kind: 'unlisted' as const,
            sourceId: context.sources[0]!.id,
            detail,
          })),
        ],
      };
    },
  };
}

const apiExportSchema = z
  .object({
    schemaVersion: z.literal(1),
    entities: z
      .array(
        z
          .object({
            kind: clientEntityKindSchema,
            nativeId: text,
            name: text,
            revision: z.string().min(1).max(256),
            // An API listing can only declare or configure; observed/derived never come from it.
            relationships: z
              .array(
                z
                  .object({
                    relation: identifier,
                    toKind: clientEntityKindSchema,
                    toNativeId: text,
                    basis: z.enum(['declared', 'configured']),
                  })
                  .strict(),
              )
              .max(32)
              .optional(),
          })
          .passthrough(),
      )
      .max(256),
    nextCursor: z.string().min(1).max(2048).optional(),
  })
  .passthrough();

const DEP_KIND: Record<string, AssuranceDependency['kind']> = {
  tool: 'tool-definition',
  agent: 'agent-instructions',
  identity: 'permissions',
  document: 'document',
  'data-store': 'runtime-config',
  queue: 'runtime-config',
};

export interface ApiExportOptions {
  readonly file: string;
  readonly sourceId: string;
  readonly tenant: string;
  readonly window: { readonly from: string; readonly to: string };
  readonly now?: () => Date;
}

/** One operator-saved JSON listing from a custom API. Never calls the API. */
export function apiExportCollector(options: ApiExportOptions): Collector {
  return {
    id: 'api-export',
    async collect() {
      const opts = parseInput(
        z.object({ sourceId: identifier, tenant: text, window: contextWindowSchema }).passthrough(),
        options,
        'INVALID_API_EXPORT',
        'API export selection',
      );
      const bytes = await readBoundedFile(options.file, 1_048_576);
      const content = decodeUtf8(bytes);
      const raw = parseJson(content, 'INVALID_API_EXPORT');
      const evidence: EvidenceArtifact = {
        id: `api-export.${opts.sourceId}`.slice(0, 160),
        source: { kind: 'local-file', reference: 'api-export.json' },
        mediaType: 'application/json',
        content,
        sha256: sha256(bytes),
        byteLength: bytes.byteLength,
        capturedAt: (options.now?.() ?? new Date()).toISOString(),
        coverage: 'partial',
        redacted: false,
      };
      new EvidenceStore([evidence]); // digest check
      // Bounded plain-JSON gate before schema walking.
      parseInput(boundedJson, raw, 'INVALID_API_EXPORT', 'API export');
      const listing = parseInput(apiExportSchema, raw, 'INVALID_API_EXPORT', 'API export');
      const rawEntities = (raw as { entities: JsonValue[] }).entities;
      const ref = (kind: SourceQualifiedRef['kind'], nativeId: string): SourceQualifiedRef => ({
        sourceId: opts.sourceId,
        tenant: opts.tenant,
        kind,
        nativeId,
      });
      const cite = (i: number) => {
        const quote = stableJson(rawEntities[i]!);
        if (Buffer.byteLength(quote) > 16_384)
          bad('An API entity is too large to cite exactly.', 'INVALID_API_EXPORT');
        return {
          evidenceId: evidence.id,
          locator: { kind: 'json-pointer' as const, pointer: `/entities/${i}` },
          quote,
        };
      };
      const kinds = [...new Set(listing.entities.map((e) => e.kind))];
      if (!kinds.length) bad('An API export needs at least one entity.', 'INVALID_API_EXPORT');
      const partial = listing.nextCursor !== undefined;
      const frontierText = [
        'API listing establishes inventory only: not execution authority, permissions or actual invocation.',
        ...(partial
          ? ['The saved listing has a nextCursor; remaining pages were not imported.']
          : []),
      ];
      const source: SourceCapability = {
        id: opts.sourceId,
        tenant: opts.tenant,
        kind: 'api-export',
        entityKinds: kinds,
        permittedReads: ['list-entities', 'read-evidence', 'read-relationships'],
        evidenceIds: [evidence.id],
        coverage: 'partial',
        captureWindow: opts.window,
        pagination: partial ? 'partial' : 'complete',
        frontier: frontierText,
      };
      const entities: ClientEntity[] = [];
      const assertions: ContextAssertion[] = [];
      const dependencies: AssuranceDependency[] = [];
      listing.entities.forEach((e, i) => {
        entities.push({
          ref: ref(e.kind, e.nativeId),
          displayName: e.name,
          revision: e.revision,
          citations: [cite(i)],
        });
        dependencies.push({
          id: `api:${jsonDigest([opts.sourceId, opts.tenant, e.kind, e.nativeId])}`,
          kind: DEP_KIND[e.kind] ?? 'application',
          fingerprint: jsonDigest(rawEntities[i]!),
          revision: e.revision,
        });
        (e.relationships ?? []).forEach((r, j) => {
          assertions.push({
            id: `api-rel:${jsonDigest([opts.sourceId, opts.tenant, e.kind, e.nativeId, j])}`,
            subject: ref(e.kind, e.nativeId),
            relation: r.relation,
            object: { kind: 'entity', ref: ref(r.toKind, r.toNativeId) },
            basis: r.basis,
            citations: [cite(i)],
            sourceRevision: e.revision,
            effectiveFrom: null,
            effectiveUntil: null,
            observedAt: null,
            capturedAt: evidence.capturedAt,
            verification: 'integrity-checked',
            assessment: 'unresolved',
          });
        });
      });
      return {
        format: 'investigator-collection-v1',
        collectorId: 'api-export',
        sources: [source],
        entities,
        assertions,
        operations: [],
        dependencies,
        evidence: [evidence],
        frontier: caveats(source),
      };
    },
  };
}
