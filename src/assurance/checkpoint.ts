import { z } from 'zod';
import { EvidenceStore } from '../core/evidence-store.js';
import { boundedJsonValueSchema } from '../core/bounded-json.js';
import { InvestigatorError } from '../core/errors.js';
import { jsonDigest, sha256, stableJson, type JsonValue } from '../core/json.js';
import { parseInput } from '../core/parse.js';
import { importMcpTools } from '../context/import-mcp.js';
import {
  evidencePlanReportSchema,
  verifyEvidencePlanReport,
  type EvidencePlanReport,
} from '../evidence-plans/report.js';
import { EXPORT_EVIDENCE_REQUIREMENTS_DIGEST } from '../evidence-plans/requirements.js';
import { compareAssurance } from './compare.js';
import {
  assuranceContractSchema,
  assuranceInventorySchema,
  assuranceScopeSchema,
  type AssuranceContract,
  type AssuranceInventory,
} from './schemas.js';

export const ASSURANCE_VERIFIER_VERSION = 'customer-export-evidence.v1';
const applicationSourcesSchema = z
  .object({
    'server.mjs': z.string().min(1).max(65_536),
    'instrumentation.mjs': z.string().min(1).max(65_536),
  })
  .strict();

export const fixtureAssuranceStateSchema = z
  .object({
    schemaVersion: z.literal(1),
    scope: assuranceScopeSchema,
    capturedAt: z.iso.datetime(),
    authorization: z.enum(['safe', 'unsafe']),
    application: applicationSourcesSchema,
    policyContent: z.string().min(1).max(65_536),
    agentConfigurationContent: z.string().min(1).max(65_536),
    toolsExport: boundedJsonValueSchema,
    observerVersion: z.string().min(1).max(256),
    operatorNotes: z.string().max(4096),
    coverage: z
      .object({
        status: z.enum(['complete', 'partial', 'unknown']),
        frontier: z.array(z.string().min(1).max(2048)).max(32),
      })
      .strict(),
  })
  .strict();
export type FixtureAssuranceState = z.infer<typeof fixtureAssuranceStateSchema>;

/** A declared tool definition for the owned HTTP fixture, not a running MCP server. */
function fixtureToolsExport() {
  return {
    tools: [
      {
        name: 'export_customer',
        description:
          'Export the exact independently approved request through the authored export service.',
        inputSchema: {
          type: 'object',
          properties: {
            workId: { type: 'string' },
            actorId: { type: 'string' },
            destination: { type: 'string' },
            payload: { type: 'object' },
            grantId: { type: ['string', 'null'] },
          },
          required: ['workId', 'actorId', 'destination', 'payload', 'grantId'],
          additionalProperties: false,
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: true,
        },
      },
    ],
  };
}

/** Capture the explicitly known inputs of this one finite authored workload. */
export function fixtureStateFromReport(input: unknown): FixtureAssuranceState {
  const report = verifyEvidencePlanReport(input);
  const evidence = new EvidenceStore(report.evidence);
  return parseInput(
    fixtureAssuranceStateSchema,
    {
      schemaVersion: 1,
      scope: {
        tenantRef: report.context.context.scope.tenantRef,
        workflowRef: `${report.context.context.scope.workflowRef}:controlled-export`,
      },
      capturedAt: report.after.safe.finishedAt,
      authorization: report.after.safe.authorization,
      application: report.application.after,
      policyContent: evidence.get('policy').content,
      agentConfigurationContent: evidence.get('architecture').content,
      toolsExport: fixtureToolsExport(),
      observerVersion: ASSURANCE_VERIFIER_VERSION,
      operatorNotes:
        'Unrelated release notes. This document is explicitly outside the frozen control dependency map.',
      coverage: { status: 'complete', frontier: [] },
    },
    'INVALID_ASSURANCE_STATE',
    'Controlled workload state',
  );
}

/** Fingerprints own the selected bytes, not self-reported modification timestamps. */
export function inventoryFromFixtureState(input: unknown): AssuranceInventory {
  const state = parseInput(
    fixtureAssuranceStateSchema,
    input,
    'INVALID_ASSURANCE_STATE',
    'Controlled workload state',
  );
  const toolsContent = stableJson(state.toolsExport);
  if (Buffer.byteLength(toolsContent, 'utf8') > 1_048_576)
    throw new InvestigatorError(
      'INVALID_ASSURANCE_STATE',
      'The selected tool export exceeds its size limit.',
    );
  const imported = importMcpTools({
    sourceId: 'controlled-export-tools',
    tenant: state.scope.tenantRef,
    serverId: 'authored-export-service',
    revision: 'declared-tools.v1',
    evidence: {
      id: 'tools',
      source: { kind: 'local-file', reference: 'selected-tools.json' },
      mediaType: 'application/json',
      content: toolsContent,
      capturedAt: state.capturedAt,
      sha256: sha256(toolsContent),
      byteLength: Buffer.byteLength(toolsContent),
      coverage: 'partial',
      redacted: false,
    },
    scope: {
      workflowRef: state.scope.workflowRef,
      window: { from: state.capturedAt, to: state.capturedAt },
    },
  });
  const policy = sha256(state.policyContent),
    agents = sha256(state.agentConfigurationContent);
  const application = jsonDigest(state.application),
    notes = sha256(state.operatorNotes);
  const dependencies = [
    { id: 'export-policy', kind: 'policy', fingerprint: policy, revision: policy },
    {
      id: 'agent-configuration',
      kind: 'agent-instructions',
      fingerprint: agents,
      revision: agents,
    },
    {
      id: 'application-source',
      kind: 'application',
      fingerprint: application,
      revision: application,
    },
    {
      id: 'authorization-binding',
      kind: 'runtime-config',
      fingerprint: jsonDigest({ authorization: state.authorization }),
      revision: state.authorization,
    },
    {
      id: 'independent-observer',
      kind: 'observer',
      fingerprint: jsonDigest({ version: state.observerVersion }),
      revision: state.observerVersion,
    },
    ...imported.dependencies,
    { id: 'operator-notes', kind: 'document', fingerprint: notes, revision: notes },
  ];
  const coverage = structuredClone(state.coverage);
  const raw = state.toolsExport;
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
    const listing =
      raw['result'] && typeof raw['result'] === 'object' && !Array.isArray(raw['result'])
        ? raw['result']
        : raw;
    if (
      listing &&
      typeof listing === 'object' &&
      !Array.isArray(listing) &&
      listing['nextCursor']
    ) {
      coverage.status = 'partial';
      coverage.frontier.push('The selected MCP tool listing has an unimported next page.');
    }
  }
  coverage.frontier = [...new Set(coverage.frontier)];
  return parseInput(
    assuranceInventorySchema,
    { schemaVersion: 1, scope: state.scope, capturedAt: state.capturedAt, dependencies, coverage },
    'INVALID_ASSURANCE_STATE',
    'Derived dependency inventory',
  );
}

function contractFromReport(
  report: EvidencePlanReport,
  inventory: AssuranceInventory,
): AssuranceContract {
  const common = inventory.dependencies
    .filter((dependency) => !['authorization-binding', 'operator-notes'].includes(dependency.id))
    .map((dependency) => dependency.id);
  return parseInput(
    assuranceContractSchema,
    {
      schemaVersion: 1,
      profileId: 'customer-export-evidence',
      requirementsDigest: EXPORT_EVIDENCE_REQUIREMENTS_DIGEST,
      verifierVersion: ASSURANCE_VERIFIER_VERSION,
      scope: inventory.scope,
      checks: report.assessments.safeAfter.checks.map((check) => ({
        id: check.id,
        historicalVerdict:
          check.status === 'PASS'
            ? 'supported'
            : check.status === 'FAIL'
              ? 'contradicted'
              : 'insufficient_evidence',
        dependencyIds: [
          ...common,
          ...(['permitted', 'wrong-request'].includes(check.id) ? ['authorization-binding'] : []),
        ],
        retestChecks: [check.id],
      })),
      exclusions: [
        {
          dependencyId: 'operator-notes',
          reason:
            'Authored release notes are not consumed by the frozen export service, approval checks or observer.',
        },
      ],
    },
    'INVALID_ASSURANCE_CHECKPOINT',
    'Frozen control dependency contract',
  );
}

export const assuranceCheckpointSchema = z
  .object({
    format: z.literal('investigator-assurance-checkpoint-v1'),
    evidencePlan: evidencePlanReportSchema,
    state: fixtureAssuranceStateSchema,
    inventory: assuranceInventorySchema,
    contract: assuranceContractSchema,
    authenticity: z.literal('not-established'),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type AssuranceCheckpoint = z.infer<typeof assuranceCheckpointSchema>;

export function createAssuranceCheckpoint(input: unknown): AssuranceCheckpoint {
  const evidencePlan = verifyEvidencePlanReport(input);
  const state = fixtureStateFromReport(evidencePlan);
  const inventory = inventoryFromFixtureState(state);
  const contract = contractFromReport(evidencePlan, inventory);
  // Validate all frozen map references even when no changes have occurred.
  compareAssurance({ baseline: inventory, candidate: inventory, contract });
  const body = {
    format: 'investigator-assurance-checkpoint-v1' as const,
    evidencePlan,
    state,
    inventory,
    contract,
    authenticity: 'not-established' as const,
  };
  return { ...body, digest: jsonDigest(body as unknown as JsonValue) };
}

export function verifyAssuranceCheckpoint(input: unknown): AssuranceCheckpoint {
  const checkpoint = parseInput(
    assuranceCheckpointSchema,
    input,
    'INVALID_ASSURANCE_CHECKPOINT',
    'Assurance checkpoint',
  );
  const expected = createAssuranceCheckpoint(checkpoint.evidencePlan);
  if (
    stableJson(checkpoint as unknown as JsonValue) !== stableJson(expected as unknown as JsonValue)
  )
    throw new InvestigatorError(
      'INVALID_ASSURANCE_CHECKPOINT',
      'The checkpoint does not match its recorded evidence, selected inputs and frozen dependency contract.',
    );
  return expected;
}
