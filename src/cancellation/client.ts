import { z } from 'zod';
import { createClientSystemSnapshot } from '../context/project.js';
import type { ClientContextInput } from '../context/schemas.js';
import { EvidenceStore } from '../core/evidence-store.js';
import { oneOfToAnyOf, sha256, type JsonObject } from '../core/json.js';
import { boundedJsonValueSchema } from '../core/bounded-json.js';
import { citationSchema, type EvidenceArtifact } from '../core/schemas.js';
import type { CancellationServiceSources } from './recipe.js';

export const CANCELLATION_POLICY = [
  '# Delegated work revocation policy',
  'An acknowledged authority revocation retires the selected work root.',
  'No new protected destination acceptance may occur for that root after the authority acknowledgment.',
  'Queue cancellation messages and worker status claims do not establish the downstream business effect.',
  'Independently authorized work under another active root must remain possible.',
  'A protected request accepted before revocation is completed work, not a rollback failure.',
  'Use the registered supervisor acceptance/revocation sequence to establish this finite boundary.',
  'A missing acknowledgment, incomplete capture or an unobserved destination leaves absence unestablished.',
  'This synthetic policy concerns only the authored loopback workflow, not global idleness or legal compliance.',
].join('\n');

export function cancellationArtifact(
  id: string,
  content: string,
  capturedAt: string,
  controlled = false,
): EvidenceArtifact {
  return {
    id,
    source: { kind: controlled ? 'controlled-check' : 'local-file', reference: id },
    mediaType: controlled ? 'application/json' : 'text/plain',
    content,
    capturedAt,
    sha256: sha256(content),
    byteLength: Buffer.byteLength(content),
    coverage: controlled ? 'complete' : 'partial',
    redacted: false,
  };
}

/** Actual selected application sources, not operator variant names or expected outcomes. */
export function createCancellationClient(
  sources: CancellationServiceSources,
  capturedAt = new Date().toISOString(),
) {
  const topology = {
    owner: 'workflow-owner',
    agent: 'support-agent',
    service: 'workflow-api',
    queue: 'delegated-jobs',
    worker: 'export-worker',
    destination: 'registered-export-destination',
    authority: 'work-authority',
  };
  const evidence = new EvidenceStore([
    cancellationArtifact('revocation-policy', CANCELLATION_POLICY, capturedAt),
    cancellationArtifact('service-source', sources['server.mjs'], capturedAt),
    cancellationArtifact('worker-source', sources['worker-authority.mjs'], capturedAt),
    {
      ...cancellationArtifact('workflow-topology', JSON.stringify(topology, null, 2), capturedAt),
      mediaType: 'application/json',
    },
  ]);
  const ref = (kind: ClientContextInput['entities'][number]['ref']['kind'], nativeId: string) => ({
    sourceId: 'selected-workflow',
    tenant: 'authored-company',
    kind,
    nativeId,
  });
  const cite = (pointer: string, value: string) => ({
    evidenceId: 'workflow-topology',
    locator: { kind: 'json-pointer' as const, pointer },
    quote: JSON.stringify(value),
  });
  const entities: ClientContextInput['entities'] = [
    {
      ref: ref('identity', topology.owner),
      displayName: 'Workflow owner',
      revision: 'workflow.v1',
      citations: [cite('/owner', topology.owner)],
    },
    {
      ref: ref('agent', topology.agent),
      displayName: 'Support agent',
      revision: 'workflow.v1',
      citations: [cite('/agent', topology.agent)],
    },
    {
      ref: ref('system', topology.service),
      displayName: 'Workflow API',
      revision: 'workflow.v1',
      citations: [cite('/service', topology.service)],
    },
    {
      ref: ref('queue', topology.queue),
      displayName: 'Delegated work queue',
      revision: 'workflow.v1',
      citations: [cite('/queue', topology.queue)],
    },
    {
      ref: ref('agent', topology.worker),
      displayName: 'Export worker',
      revision: 'workflow.v1',
      citations: [cite('/worker', topology.worker)],
    },
    {
      ref: ref('data-store', topology.destination),
      displayName: 'Independent destination',
      revision: 'workflow.v1',
      citations: [cite('/destination', topology.destination)],
    },
    {
      ref: ref('system', topology.authority),
      displayName: 'Work authority',
      revision: 'workflow.v1',
      citations: [cite('/authority', topology.authority)],
    },
  ];
  const assertions: ClientContextInput['assertions'] = [
    [1, 'CALLS', 2, '/service', topology.service],
    [2, 'QUEUES', 3, '/queue', topology.queue],
    [3, 'DELEGATES_TO', 4, '/worker', topology.worker],
    [4, 'WRITES', 5, '/destination', topology.destination],
    [0, 'REVOKES_THROUGH', 6, '/authority', topology.authority],
  ].map(([from, relation, to, pointer, value], index) => ({
    id: `workflow-edge-${index}`,
    subject: entities[from as number]!.ref,
    relation: relation as string,
    object: { kind: 'entity', ref: entities[to as number]!.ref },
    basis: 'configured',
    citations: [cite(pointer as string, value as string)],
    sourceRevision: 'workflow.v1',
    effectiveFrom: null,
    effectiveUntil: null,
    observedAt: null,
    capturedAt,
    verification: 'unverified',
    assessment: 'unresolved',
  }));
  const context = createClientSystemSnapshot(
    {
      schemaVersion: 1,
      id: 'delegated-work-context',
      scope: {
        tenantRef: 'authored-company',
        workflowRef: 'delegated-export',
        window: { from: capturedAt, to: capturedAt },
        excludedResources: ['Unregistered queues, destinations and production workloads.'],
      },
      sources: [
        {
          id: 'selected-workflow',
          tenant: 'authored-company',
          kind: 'local-bundle',
          entityKinds: ['identity', 'agent', 'system', 'queue', 'data-store'],
          permittedReads: ['list-entities', 'read-evidence', 'read-relationships'],
          evidenceIds: evidence.all().map((artifact) => artifact.id),
          coverage: 'partial',
          captureWindow: { from: capturedAt, to: capturedAt },
          pagination: 'not-applicable',
          frontier: [
            'Only the selected authored workflow is represented; other enterprise paths were not discovered.',
          ],
        },
      ],
      entities,
      assertions,
      unresolvedQuestions: [
        'Does revocation propagate to work already queued?',
        'Which event establishes protected destination acceptance?',
      ],
    },
    evidence,
  );
  return { context, evidence };
}

export const cancellationFindingSchema = z
  .object({
    verdict: z.enum(['supported', 'contradicted', 'insufficient_evidence']),
    statement: z.string().min(1).max(2048),
    workingHypothesis: z.string().min(1).max(1024),
    alternativeExplanation: z.string().min(1).max(1024),
    citations: z.array(citationSchema).max(24),
    missingEvidence: z.array(z.string().min(1).max(1024)).max(16),
    nextAction: z.enum(['check-current-root-authority.v1', 'collect-missing-capture', 'none']),
  })
  .strict();
export type CancellationFinding = z.infer<typeof cancellationFindingSchema>;

/** Normalize only these code-owned disjoint locator branches for Meta's strict subset. */
export function cancellationJsonSchema(schema: z.ZodType): JsonObject {
  return oneOfToAnyOf(
    boundedJsonValueSchema.parse(
      JSON.parse(JSON.stringify(z.toJSONSchema(schema, { target: 'draft-7' }))) as unknown,
    ),
  ) as JsonObject;
}
