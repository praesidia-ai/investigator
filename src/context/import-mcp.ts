import { z } from 'zod';
import { readLocator } from '../core/citations.js';
import { EvidenceStore } from '../core/evidence-store.js';
import { InvestigatorError } from '../core/errors.js';
import { jsonDigest, stableJson, type JsonValue } from '../core/json.js';
import { parseInput, parseJson } from '../core/parse.js';
import {
  evidenceArtifactSchema,
  jsonValueSchema,
  shortTextSchema,
  type Citation,
  type EvidenceArtifact,
} from '../core/schemas.js';
import { createClientSystemSnapshot } from './project.js';
import {
  contextWindowSchema,
  type ClientContextInput,
  type ClientSystemSnapshot,
  type SourceQualifiedRef,
} from './schemas.js';

const identifier = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/);
const objectSchema = z.record(z.string().max(256), jsonValueSchema);
const iconSchema = z
  .object({
    src: shortTextSchema,
    mimeType: z.string().min(1).max(128).optional(),
    sizes: z.array(z.string().min(1).max(32)).max(16).optional(),
    theme: z.enum(['light', 'dark']).optional(),
  })
  .strict();
const toolSchema = z
  .object({
    name: z.string().min(1).max(128),
    title: z.string().min(1).max(1024).optional(),
    description: z.string().max(8192).optional(),
    inputSchema: objectSchema,
    outputSchema: objectSchema.optional(),
    annotations: z
      .object({
        title: z.string().max(1024).optional(),
        readOnlyHint: z.boolean().optional(),
        destructiveHint: z.boolean().optional(),
        idempotentHint: z.boolean().optional(),
        openWorldHint: z.boolean().optional(),
      })
      .strict()
      .optional(),
    execution: z
      .object({ taskSupport: z.enum(['forbidden', 'optional', 'required']).optional() })
      .strict()
      .optional(),
    icons: z.array(iconSchema).max(8).optional(),
    _meta: objectSchema.optional(),
  })
  .strict();
const listingSchema = z
  .object({
    tools: z.array(toolSchema).max(128),
    nextCursor: shortTextSchema.optional(),
    _meta: objectSchema.optional(),
  })
  .strict();
const envelopeSchema = z
  .object({
    jsonrpc: z.literal('2.0'),
    id: z.union([z.string().min(1).max(256), z.number().int().safe()]),
    result: listingSchema,
  })
  .strict();
const optionsSchema = z
  .object({
    sourceId: identifier,
    tenant: z.string().min(1).max(512),
    serverId: z.string().min(1).max(512),
    revision: z.string().min(1).max(256),
    evidence: evidenceArtifactSchema,
    scope: z
      .object({ workflowRef: z.string().min(1).max(256), window: contextWindowSchema })
      .strict(),
  })
  .strict();

export interface ImportMcpToolsOptions {
  readonly sourceId: string;
  readonly tenant: string;
  /** Operator-selected identity of the producing server; never inferred from a display name. */
  readonly serverId: string;
  readonly revision: string;
  readonly evidence: EvidenceArtifact;
  readonly scope: {
    readonly workflowRef: string;
    readonly window: { readonly from: string; readonly to: string };
  };
}
export interface ImportedMcpTools {
  readonly snapshot: ClientSystemSnapshot;
  readonly dependencies: readonly {
    readonly id: string;
    readonly kind: 'tool-definition';
    readonly fingerprint: string;
    readonly revision: string;
  }[];
  readonly frontier: readonly string[];
}

/** Bound nested untrusted JSON before recursive schema validation or canonicalization. */
function checkJsonBounds(input: unknown): void {
  const queue = [{ value: input, depth: 0 }];
  let count = 0;
  while (queue.length) {
    const { value, depth } = queue.pop()!;
    count += 1;
    if (depth > 32 || count > 20_000)
      throw new InvestigatorError(
        'MCP_EXPORT_TOO_LARGE',
        'Choose a smaller or less deeply nested saved MCP listing.',
      );
    if (typeof value === 'number' && !Number.isFinite(value))
      throw new InvestigatorError(
        'INVALID_MCP_EXPORT',
        'Saved MCP listings require finite JSON values.',
      );
    if (value && typeof value === 'object')
      for (const child of Object.values(value)) {
        if (queue.length + count >= 20_000)
          throw new InvestigatorError(
            'MCP_EXPORT_TOO_LARGE',
            'Choose a smaller saved MCP listing.',
          );
        queue.push({ value: child, depth: depth + 1 });
      }
  }
}

/**
 * Project one saved MCP 2025-11-25 tools/list result. No server, tool, icon or
 * JSON Schema reference is fetched or executed. An advertised tool is neither
 * permission to invoke it nor evidence that any invocation actually occurred.
 */
export function importMcpTools(input: ImportMcpToolsOptions): ImportedMcpTools {
  const options = parseInput(optionsSchema, input, 'INVALID_MCP_IMPORT', 'MCP import selection');
  const evidence = new EvidenceStore([options.evidence]);
  if (options.evidence.mediaType !== 'application/json')
    throw new InvestigatorError('INVALID_MCP_EXPORT', 'Saved MCP listings require JSON evidence.');
  const raw = parseJson(options.evidence.content, 'INVALID_MCP_EXPORT');
  checkJsonBounds(raw);
  const wrapped =
    raw !== null && typeof raw === 'object' && !Array.isArray(raw) && Object.hasOwn(raw, 'jsonrpc');
  const listing = wrapped
    ? parseInput(envelopeSchema, raw, 'INVALID_MCP_EXPORT', 'MCP JSON-RPC result').result
    : parseInput(listingSchema, raw, 'INVALID_MCP_EXPORT', 'MCP tools listing');
  if (new Set(listing.tools.map((tool) => tool.name)).size !== listing.tools.length)
    throw new InvestigatorError(
      'DUPLICATE_MCP_TOOL',
      'Tool names must be unique within the selected MCP server listing.',
    );
  // JSON.parse plus the iterative bounds/finite-value check establishes JSON
  // data here. Hash the original values, not a schema library's parsed clone.
  const rawListing = (wrapped ? (raw as { result: unknown }).result : raw) as {
    tools: JsonValue[];
  };

  const prefix = wrapped ? '/result/tools' : '/tools';
  const citation = (pointer: string): Citation => {
    const locator = { kind: 'json-pointer', pointer } as const;
    const quote = readLocator(options.evidence, locator);
    if (Buffer.byteLength(quote, 'utf8') > 16_384)
      throw new InvestigatorError(
        'MCP_TOOL_TOO_LARGE',
        'Choose a bounded tool definition that fits an exact saved citation.',
      );
    return { evidenceId: options.evidence.id, locator, quote };
  };
  const ref = (kind: 'system' | 'tool', nativeId: string): SourceQualifiedRef => ({
    sourceId: options.sourceId,
    tenant: options.tenant,
    kind,
    nativeId,
  });
  const serverRef = ref('system', stableJson(['mcp-server', options.serverId]));
  const serverCitation = citation(listing.tools.length ? `${prefix}/0` : prefix);
  const frontier = [
    'Only an operator-selected saved MCP listing was imported; upstream inventory completeness is not established.',
    'Server identity and revision were assigned by the operator; this export does not authenticate the producing server.',
    'Advertised schemas, descriptions, icons and annotations are untrusted configuration data; runtime permissions, invocations and downstream effects are not established.',
    'JSON Schema semantics and references were not evaluated or resolved.',
    ...(listing.nextCursor
      ? ['The saved listing has a nextCursor; remaining pages and tools were not imported.']
      : []),
  ];
  const entities: ClientContextInput['entities'] = [
    {
      ref: serverRef,
      displayName: options.serverId,
      revision: options.revision,
      citations: [serverCitation],
    },
  ];
  const assertions: ClientContextInput['assertions'] = [];
  const dependencies: ImportedMcpTools['dependencies'][number][] = [];
  listing.tools.forEach((tool, index) => {
    const id = `mcp-tool:${jsonDigest([options.sourceId, options.tenant, options.serverId, tool.name])}`;
    const toolCitation = citation(`${prefix}/${index}`);
    const toolRef = ref('tool', stableJson([options.serverId, tool.name]));
    // The original saved tool object is the fingerprint owner. Envelope IDs, cursor,
    // operator revision and local recapture times cannot hide or create a tool change.
    dependencies.push({
      id,
      kind: 'tool-definition',
      fingerprint: jsonDigest(rawListing.tools[index]!),
      revision: options.revision,
    });
    entities.push({
      ref: toolRef,
      displayName: tool.title ?? tool.name,
      revision: options.revision,
      citations: [toolCitation],
    });
    assertions.push({
      id,
      subject: serverRef,
      relation: 'EXPOSES',
      object: { kind: 'entity', ref: toolRef },
      basis: 'configured',
      citations: [toolCitation],
      sourceRevision: options.revision,
      effectiveFrom: null,
      effectiveUntil: null,
      observedAt: null,
      capturedAt: options.evidence.capturedAt,
      verification: 'integrity-checked',
      assessment: 'unresolved',
    });
  });
  const context: ClientContextInput = {
    schemaVersion: 1,
    id: `mcp-import:${jsonDigest([options.sourceId, options.tenant, options.serverId])}`,
    scope: {
      tenantRef: options.tenant,
      workflowRef: options.scope.workflowRef,
      window: options.scope.window,
      excludedResources: [
        'Unlisted MCP servers, unimported pages, resources, prompts and runtime activity.',
      ],
    },
    sources: [
      {
        id: options.sourceId,
        tenant: options.tenant,
        kind: 'api-export',
        entityKinds: ['system', 'tool'],
        permittedReads: ['list-entities', 'read-evidence', 'read-relationships'],
        evidenceIds: [options.evidence.id],
        coverage: 'partial',
        captureWindow: options.scope.window,
        pagination: listing.nextCursor ? 'partial' : 'complete',
        frontier,
      },
    ],
    entities,
    assertions,
    unresolvedQuestions: [
      'Which principals may invoke each tool?',
      'Which operations and downstream effects were independently observed?',
      'Does the saved listing match the currently deployed MCP server?',
    ],
  };
  return { snapshot: createClientSystemSnapshot(context, evidence), dependencies, frontier };
}
