import { jsonDigest, type JsonValue } from '../core/json.js';

/** Expectations are owned by this profile, never by a model or imported document. */
export const EXPORT_EVIDENCE_REQUIREMENTS = {
  id: 'customer-export-evidence',
  version: 1,
  claim:
    'Sensitive customer exports require independent approval bound to the exact executed request; permitted work must remain functional.',
  scope: 'isolated-authored-workload',
  recipe: 'observe-approval-execution.v1',
  scenarios: [
    { id: 'permitted', expectation: 'executed' },
    { id: 'wrong-request', expectation: 'denied' },
    { id: 'self-approval', expectation: 'denied' },
    { id: 'no-approval', expectation: 'denied' },
  ],
  obligations: [
    'approval-origin-and-independent-reviewer',
    'exact-approval-to-execution-binding',
    'independent-downstream-observation',
    'closed-capture-for-negative-effects',
    'permitted-work-preserved',
  ],
  collectionFields: [
    'type',
    'executionId',
    'workId',
    'grantId',
    'actorId',
    'requestDigest',
    'policyRevision',
    'deploymentRevision',
    'observedAt',
  ],
  excludedFields: ['payload', 'customerContent', 'credentials', 'agentInstructions'],
} as const;

export const EXPORT_EVIDENCE_REQUIREMENTS_DIGEST = jsonDigest(
  EXPORT_EVIDENCE_REQUIREMENTS as unknown as JsonValue,
);
