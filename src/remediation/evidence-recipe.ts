import { join } from 'node:path';
import { z } from 'zod';
import { InvestigatorError } from '../core/errors.js';
import { jsonDigest, sha256 } from '../core/json.js';
import { parseInput } from '../core/parse.js';
import { EXPORT_EVIDENCE_REQUIREMENTS } from '../evidence-plans/requirements.js';
import { decodeUtf8, readBoundedFile } from '../io/read-file.js';

export const LEGACY_EVIDENCE_PRODUCER = `// This authored producer deliberately omits the approval/execution join.
// The evidence recipe changes only this producer, never authorization.
export function executionWitness(context) {
  return {
    type: 'legacy-execution',
    executionId: context.executionId,
    deploymentRevision: context.deploymentRevision,
    observedAt: context.observedAt,
  };
}
`;

export const BOUND_EVIDENCE_PRODUCER = `// This authored producer records only the declared approval/execution witnesses.
// Authorization and the business request are unchanged.
export function executionWitness(context) {
  return {
    type: 'execution',
    executionId: context.executionId,
    workId: context.workId,
    grantId: context.grantId,
    actorId: context.actorId,
    requestDigest: context.requestDigest,
    policyRevision: context.policyRevision,
    deploymentRevision: context.deploymentRevision,
    observedAt: context.observedAt,
  };
}
`;

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const evidenceRecipeProposalSchema = z
  .object({
    recipe: z.literal('observe-approval-execution.v1'),
    file: z.literal('instrumentation.mjs'),
    beforeDigest: digestSchema,
    afterDigest: digestSchema,
    diff: z.string().max(16_384),
    scope: z.literal('isolated-authored-example'),
    changesAuthorization: z.literal(false),
    collectedFields: z.array(z.string().min(1).max(100)).max(16),
    excludedFields: z.array(z.string().min(1).max(100)).max(16),
  })
  .strict();
export type EvidenceRecipeProposal = z.infer<typeof evidenceRecipeProposalSchema>;
export interface EvidenceGapSources {
  readonly 'server.mjs': string;
  readonly 'instrumentation.mjs': string;
}

const EXCLUDED_FIELDS = ['payload', 'destination', 'customerName', 'customerEmail'];

function evidenceDiff(before: string, after: string): string {
  const original = before.trimEnd().split('\n');
  const revised = after.trimEnd().split('\n');
  return `--- a/instrumentation.mjs\n+++ b/instrumentation.mjs\n@@ -1,${original.length} +1,${revised.length} @@\n${original.map((line) => `-${line}`).join('\n')}\n${revised.map((line) => `+${line}`).join('\n')}\n`;
}

export function createEvidenceRecipeProposal(): EvidenceRecipeProposal {
  return {
    recipe: 'observe-approval-execution.v1',
    file: 'instrumentation.mjs',
    beforeDigest: sha256(LEGACY_EVIDENCE_PRODUCER),
    afterDigest: sha256(BOUND_EVIDENCE_PRODUCER),
    diff: evidenceDiff(LEGACY_EVIDENCE_PRODUCER, BOUND_EVIDENCE_PRODUCER),
    scope: 'isolated-authored-example',
    changesAuthorization: false,
    collectedFields: [...EXPORT_EVIDENCE_REQUIREMENTS.collectionFields],
    excludedFields: [...EXCLUDED_FIELDS],
  };
}

/** Validate the exact supported source change. This does not reexecute the recorded workload. */
export function verifyEvidenceRecipe(input: {
  readonly beforeSources: EvidenceGapSources;
  readonly afterSources: EvidenceGapSources;
  readonly proposal: unknown;
}): EvidenceRecipeProposal {
  const proposal = parseInput(
    evidenceRecipeProposalSchema,
    input.proposal,
    'INVALID_EVIDENCE_RECIPE',
    'Evidence recipe',
  );
  const expected = createEvidenceRecipeProposal();
  if (
    input.beforeSources['instrumentation.mjs'] !== LEGACY_EVIDENCE_PRODUCER ||
    input.afterSources['instrumentation.mjs'] !== BOUND_EVIDENCE_PRODUCER ||
    input.beforeSources['server.mjs'] !== input.afterSources['server.mjs'] ||
    jsonDigest(proposal) !== jsonDigest(expected)
  )
    throw new InvestigatorError(
      'INVALID_EVIDENCE_RECIPE',
      'The change does not match the supported producer recipe and unchanged application source.',
    );
  return proposal;
}

/** Apply one fixed producer-only change. Caller owns the temporary authored-fixture copy. */
export async function applyEvidenceRecipe(
  directory: string,
  expectedBeforeDigest = sha256(LEGACY_EVIDENCE_PRODUCER),
): Promise<EvidenceRecipeProposal> {
  const path = join(directory, 'instrumentation.mjs');
  const source = decodeUtf8(await readBoundedFile(path, 65_536));
  const proposal = createEvidenceRecipeProposal();
  if (expectedBeforeDigest !== proposal.beforeDigest || source !== LEGACY_EVIDENCE_PRODUCER)
    throw new InvestigatorError(
      'EVIDENCE_PREIMAGE_MISMATCH',
      'The selected evidence producer does not match the supported source preimage.',
    );
  // O_NOFOLLOW and a fresh preimage read prevent following a selected symlink. This is an owned
  // local fixture, not a general patch service for hostile concurrent repository writers.
  const { constants } = await import('node:fs');
  const { open } = await import('node:fs/promises');
  const handle = await open(path, constants.O_RDWR | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || (await handle.readFile('utf8')) !== LEGACY_EVIDENCE_PRODUCER)
      throw new InvestigatorError(
        'EVIDENCE_PREIMAGE_MISMATCH',
        'The selected evidence producer changed before the recipe was applied.',
      );
    await handle.truncate(0);
    await handle.write(BOUND_EVIDENCE_PRODUCER, 0, 'utf8');
  } finally {
    await handle.close();
  }
  return proposal;
}
