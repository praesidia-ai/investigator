import { z } from 'zod';
import type { AssuranceDependency } from '../assurance/schemas.js';
import { boundedJsonValueSchema } from '../core/bounded-json.js';
import { InvestigatorError } from '../core/errors.js';
import { jsonDigest, sha256, stableJson, type JsonValue } from '../core/json.js';
import { parseInput, parseJson } from '../core/parse.js';
import type { Citation, EvidenceArtifact } from '../core/schemas.js';
import { decodeUtf8, readBoundedFile } from '../io/read-file.js';
import type {
  CollectedOperation,
  CollectionResult,
  Collector,
  FrontierEntry,
} from './collector.js';
import {
  contextWindowSchema,
  type ClientEntity,
  type ContextAssertion,
  type SourceCapability,
  type SourceQualifiedRef,
} from './schemas.js';

/**
 * The OpenTelemetry GenAI semantic conventions are status Development and live in their own
 * repository. This label pins the vocabulary this importer was written against
 * (gen_ai.operation.name, gen_ai.tool.name); no upstream commit is recorded, so it pins
 * importer behavior, not a verified upstream revision.
 */
export const OTEL_GENAI_PINNED_SCHEMA = 'otel-genai-conventions:development:2026-11-05';

const identifier = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/);
const KNOWN_ATTRIBUTES = new Set([
  'gen_ai.operation.name',
  'gen_ai.tool.name',
  'service.name',
  'service.version',
]);

const attributeSchema = z
  .object({ key: z.string().min(1).max(256), value: boundedJsonValueSchema })
  .passthrough();
type Attr = z.infer<typeof attributeSchema>;
const spanSchema = z
  .object({
    traceId: z.string().min(1).max(64),
    spanId: z.string().min(1).max(64),
    parentSpanId: z.string().max(64).optional(),
    name: z.string().max(2048).optional(),
    startTimeUnixNano: z.union([z.string().regex(/^\d{1,20}$/), z.number().int().nonnegative()]),
    attributes: z.array(attributeSchema).max(128).optional(),
    status: z
      .object({ code: z.union([z.number().int(), z.string().max(64)]).optional() })
      .passthrough()
      .optional(),
  })
  .passthrough();
const traceSchema = z
  .object({
    resourceSpans: z
      .array(
        z
          .object({
            resource: z
              .object({ attributes: z.array(attributeSchema).max(128).optional() })
              .passthrough()
              .optional(),
            scopeSpans: z
              .array(z.object({ spans: z.array(spanSchema).max(2048).optional() }).passthrough())
              .max(64),
          })
          .passthrough(),
      )
      .max(64),
  })
  .passthrough();

export interface ImportOtelOptions {
  readonly sourceId: string;
  readonly tenant: string;
  /** Vocabulary version the exporter used, declared by the operator. */
  readonly schemaVersion: string;
  /** Explicit operator consent to a version other than the pinned one; must equal schemaVersion. */
  readonly acceptSchemaVersion?: string;
  readonly window: { readonly from: string; readonly to: string };
  readonly coverage: {
    /** Spans reported dropped. Unknown is not zero: pass null. */
    readonly droppedSpans: number | null;
    /** Operator states the capture was closed over the window. */
    readonly captureClosed: boolean;
    readonly retention?: string;
  };
  readonly content: string;
  readonly capturedAt: string;
}

const attr = (list: Attr[] | undefined, key: string): string | null => {
  const v = list?.find((a) => a.key === key)?.value as { stringValue?: unknown } | undefined;
  if (typeof v?.stringValue !== 'string' || !v.stringValue) return null;
  if (v.stringValue.length > 512)
    throw new InvestigatorError(
      'INVALID_TRACE_IMPORT',
      `Attribute ${key} is too long to identify an entity.`,
    );
  return v.stringValue;
};

const SENSITIVE_KEY =
  /authorization|cookie|token|secret|passw|credential|api[-_.]?key|private[-_.]?key|^gen_ai\.(tool\.call\.(arguments|result)|input\.|output\.|system_instructions|prompt|completion)/i;
const SECRET_PATTERNS: RegExp[] = [
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g,
  /\bsk-[A-Za-z0-9_-]{8,}/g,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g,
  /\b(?:api[-_]?key|secret|token|password)\s*[=:]\s*["']?[^\s"',;&]{6,}/gi,
];
const REDACTED = '[redacted]';

/** Mask secrets in untrusted trace data. Keys stay visible; whole values go for sensitive keys. */
function sanitize(value: JsonValue, state: { changed: boolean }): JsonValue {
  if (typeof value === 'string') {
    let out = value;
    for (const re of SECRET_PATTERNS) out = out.replace(re, REDACTED);
    if (out !== value) state.changed = true;
    return out;
  }
  if (Array.isArray(value)) return value.map((v) => sanitize(v, state));
  if (value && typeof value === 'object') {
    const obj = value as { [k: string]: JsonValue };
    const sensitive = typeof obj.key === 'string' && SENSITIVE_KEY.test(obj.key);
    return Object.fromEntries(
      Object.entries(obj).map(([k, v]) => {
        if (sensitive && k === 'value') {
          if (JSON.stringify(v) !== JSON.stringify({ stringValue: REDACTED })) state.changed = true;
          return [k, { stringValue: REDACTED }];
        }
        return [k, sanitize(v, state)];
      }),
    );
  }
  return value;
}

/**
 * Project one OTLP/JSON trace export into observed operations and dependencies. A span with
 * status OK says the instrumented call returned; it is never a destination receipt, so every
 * operation carries effectEvidence:'none'. Absent spans/parents are frontier, not absence of effect.
 */
export function importOtelTraces(options: ImportOtelOptions): CollectionResult {
  const version = options.schemaVersion;
  if (version !== OTEL_GENAI_PINNED_SCHEMA && options.acceptSchemaVersion !== version)
    throw new InvestigatorError(
      'UNKNOWN_TRACE_SCHEMA',
      `Trace schema ${JSON.stringify(version.slice(0, 120))} is not the pinned ${OTEL_GENAI_PINNED_SCHEMA}; pass it explicitly as accepted to import it.`,
    );
  const window = parseInput(
    contextWindowSchema,
    options.window,
    'INVALID_TRACE_IMPORT',
    'Trace window',
  );
  parseInput(identifier, options.sourceId, 'INVALID_TRACE_IMPORT', 'Source id');
  if (Buffer.byteLength(options.content, 'utf8') > 1_048_576)
    throw new InvestigatorError('TRACE_EXPORT_TOO_LARGE', 'Choose a smaller trace export.');
  const rawParsed = parseJson(options.content, 'INVALID_TRACE_IMPORT');
  parseInput(boundedJsonValueSchema, rawParsed, 'TRACE_EXPORT_TOO_LARGE', 'Trace export');
  const state = { changed: false };
  const raw = sanitize(rawParsed as JsonValue, state);
  const content = state.changed ? JSON.stringify(raw) : options.content;
  const bytes = Buffer.from(content, 'utf8');
  const trace = parseInput(traceSchema, raw, 'INVALID_TRACE_IMPORT', 'OTLP trace export');
  const rawRs = (
    raw as { resourceSpans: { resource?: JsonValue; scopeSpans: { spans?: JsonValue[] }[] }[] }
  ).resourceSpans;
  const evidence: EvidenceArtifact = {
    id: `otel-trace.${options.sourceId}`.slice(0, 160),
    source: { kind: 'local-file', reference: 'otel-trace.json' },
    mediaType: 'application/json',
    content,
    sha256: sha256(bytes),
    byteLength: bytes.byteLength,
    capturedAt: options.capturedAt,
    coverage:
      options.coverage.captureClosed && options.coverage.droppedSpans === 0
        ? 'complete'
        : 'partial',
    redacted: state.changed,
  };
  const ref = (kind: SourceQualifiedRef['kind'], nativeId: string): SourceQualifiedRef => ({
    sourceId: options.sourceId,
    tenant: options.tenant,
    kind,
    nativeId,
  });
  const entities = new Map<string, ClientEntity>();
  const assertions = new Map<string, ContextAssertion>();
  const operations: CollectedOperation[] = [];
  const dependencies = new Map<string, AssuranceDependency>();
  const seen = new Set<string>();
  const parents: string[] = [];
  let uninterpreted = 0;
  let unnamed = 0;
  const conflicts = new Set<string>();

  const cite = (pointer: string, value: JsonValue): Citation => {
    const quote = stableJson(value);
    if (Buffer.byteLength(quote) > 16_384)
      throw new InvestigatorError('TRACE_SPAN_TOO_LARGE', 'A span is too large to cite exactly.');
    return { evidenceId: evidence.id, locator: { kind: 'json-pointer', pointer }, quote };
  };
  const addEntity = (r: SourceQualifiedRef, name: string, revision: string, citation: Citation) => {
    const key = stableJson([r.kind, r.nativeId]);
    if (!entities.has(key))
      entities.set(key, { ref: r, displayName: name, revision, citations: [citation] });
  };

  trace.resourceSpans.forEach((rs, i) => {
    const named = attr(rs.resource?.attributes, 'service.name');
    if (!named) unnamed += 1;
    const service = named ?? 'unknown-service';
    const revision = attr(rs.resource?.attributes, 'service.version') ?? 'unversioned';
    const serviceRef = ref('system', stableJson(['otel-service', service]));
    const base = `/resourceSpans/${i}`;
    const resource = rawRs[i]!.resource ?? null;
    // Resource citation needs an existing pointer; fall back to the resourceSpans entry's resource only when present.
    const resourceCitation =
      rawRs[i]!.resource === undefined
        ? cite(base, rawRs[i]!.scopeSpans as unknown as JsonValue)
        : cite(`${base}/resource`, resource);
    addEntity(serviceRef, service, revision, resourceCitation);
    // A changed deployment revision or resource attribute set is visible to assurance comparison.
    const depId = `otel-deploy:${jsonDigest([options.sourceId, options.tenant, service])}`;
    const dep = {
      id: depId,
      kind: 'application' as const,
      fingerprint: jsonDigest(resource),
      revision,
    };
    const prior = dependencies.get(depId);
    if (prior && (prior.fingerprint !== dep.fingerprint || prior.revision !== dep.revision))
      conflicts.add(service);
    if (!prior) dependencies.set(depId, dep);
    rs.scopeSpans.forEach((scope, j) => {
      (scope.spans ?? []).forEach((span, k) => {
        const pointer = `${base}/scopeSpans/${j}/spans/${k}`;
        const rawSpan = rawRs[i]!.scopeSpans[j]!.spans![k]!;
        const operation = attr(span.attributes, 'gen_ai.operation.name');
        const tool = attr(span.attributes, 'gen_ai.tool.name');
        if (!operation && !tool) {
          uninterpreted += 1;
          return;
        }
        const spanKey = `${span.traceId}/${span.spanId}`;
        if (seen.has(spanKey))
          throw new InvestigatorError('INVALID_TRACE_IMPORT', 'Span identifiers must be unique.');
        seen.add(spanKey);
        if (span.parentSpanId) parents.push(`${span.traceId}/${span.parentSpanId}`);
        const when = new Date(Number(BigInt(span.startTimeUnixNano) / 1_000_000n));
        if (Number.isNaN(when.getTime()))
          throw new InvestigatorError('INVALID_TRACE_IMPORT', 'A span start time is out of range.');
        const subject = tool ? ref('tool', stableJson([service, tool])) : serviceRef;
        const citation = cite(pointer, rawSpan);
        if (tool) {
          addEntity(subject, tool, revision, citation);
          const id = `otel-rel:${jsonDigest([options.sourceId, options.tenant, service, tool])}`;
          if (!assertions.has(id))
            assertions.set(id, {
              id,
              subject: serviceRef,
              relation: 'CALLS',
              object: { kind: 'entity', ref: subject },
              basis: 'observed',
              citations: [citation],
              sourceRevision: revision,
              effectiveFrom: null,
              effectiveUntil: null,
              observedAt: when.toISOString(),
              capturedAt: options.capturedAt,
              verification: 'integrity-checked',
              assessment: 'unresolved',
            });
        }
        const code = span.status?.code;
        const retained = Object.fromEntries(
          (span.attributes ?? [])
            .filter((a) => !KNOWN_ATTRIBUTES.has(a.key))
            .map((a) => [a.key, a.value]),
        );
        operations.push({
          id: `otel-op:${jsonDigest([options.sourceId, span.traceId, span.spanId])}`,
          subject,
          name: `${operation ?? 'unknown'}${tool ? `:${tool}` : ''}`,
          status:
            code === 1 || code === 'STATUS_CODE_OK'
              ? 'ok'
              : code === 2 || code === 'STATUS_CODE_ERROR'
                ? 'error'
                : 'unknown',
          observedAt: when.toISOString(),
          basis: 'observed',
          effectEvidence: 'none',
          ...(Object.keys(retained).length ? { retainedAttributes: retained } : {}),
          citations: [citation],
        });
      });
    });
  });

  const frontier: FrontierEntry[] = [];
  const add = (kind: FrontierEntry['kind'], detail: string) =>
    frontier.push({ kind, sourceId: options.sourceId, detail });
  add(
    'caveat',
    `Pinned to ${version}; GenAI conventions are Development status. A successful tool span is not a destination receipt.`,
  );
  const missingParents = parents.filter((p) => !seen.has(p)).length;
  if (missingParents)
    add(
      'missing-trace',
      `${missingParents} span(s) name a parent that is not in the export; those traces are incomplete.`,
    );
  const { droppedSpans, captureClosed } = options.coverage;
  if (droppedSpans === null)
    add('dropped-data', 'Dropped-span count is unknown; absence of a span proves nothing.');
  else if (droppedSpans > 0)
    add('dropped-data', `${droppedSpans} span(s) were dropped before export.`);
  if (!captureClosed)
    add(
      'missing-trace',
      'Capture was not declared closed over the window; later or in-flight spans are missing.',
    );
  // Non-GenAI spans (HTTP, DB) are normal beside GenAI spans under the pinned vocabulary: a caveat.
  // Blocking when nothing was interpreted or the vocabulary is not the pinned one: the importer may be blind.
  if (uninterpreted) {
    const msg = `${uninterpreted} span(s) without GenAI operation/tool attributes were not interpreted.`;
    add(
      operations.length === 0 || version !== OTEL_GENAI_PINNED_SCHEMA ? 'dropped-data' : 'caveat',
      msg,
    );
  }
  if (unnamed)
    add(
      'unlisted',
      `${unnamed} resource(s) have no service.name; they are pooled as unknown-service and cannot be told apart.`,
    );
  for (const service of conflicts)
    add(
      'unlisted',
      `Service ${service} appears with conflicting revision or resource attributes; only the first was recorded.`,
    );
  if (state.changed)
    add(
      'caveat',
      'Secret-like values were redacted from the saved evidence; attribute keys are kept.',
    );
  if (options.coverage.retention)
    add('caveat', `Retention: ${options.coverage.retention.slice(0, 500)}`);
  const kinds = [...new Set([...entities.values()].map((e) => e.ref.kind))];
  const source: SourceCapability = {
    id: options.sourceId,
    tenant: options.tenant,
    kind: 'api-export',
    entityKinds: kinds.length ? kinds : ['system'],
    permittedReads: ['read-evidence', 'read-relationships'],
    evidenceIds: [evidence.id],
    coverage: frontier.every((f) => f.kind === 'caveat') ? 'complete' : 'partial',
    captureWindow: window,
    pagination: 'not-applicable',
    frontier: frontier.map((f) => f.detail.slice(0, 2048)).slice(0, 64),
  };
  return {
    format: 'investigator-collection-v1',
    collectorId: 'otel-trace',
    sources: [source],
    entities: [...entities.values()],
    assertions: [...assertions.values()],
    operations,
    dependencies: [...dependencies.values()],
    evidence: [evidence],
    frontier,
  };
}

/** Saved OTLP/JSON file collector. No exporter, endpoint or network. */
export function otelTraceCollector(
  options: Omit<ImportOtelOptions, 'content' | 'capturedAt'> & { file: string; now?: () => Date },
): Collector {
  return {
    id: 'otel-trace',
    async collect() {
      const content = decodeUtf8(await readBoundedFile(options.file, 1_048_576));
      return importOtelTraces({
        ...options,
        content,
        capturedAt: (options.now?.() ?? new Date()).toISOString(),
      });
    },
  };
}
