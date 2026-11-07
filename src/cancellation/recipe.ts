import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { InvestigatorError } from '../core/errors.js';
import { jsonDigest, sha256 } from '../core/json.js';
import { parseInput } from '../core/parse.js';
import { digestSchema as digest } from '../core/schemas.js';

export const CACHED_WORKER_SOURCE = `export function mayDispatch(job, currentRootActive) {
  return job.authorizedAtEnqueue;
}
`;
export const CURRENT_WORKER_SOURCE = `export function mayDispatch(job, currentRootActive) {
  return job.authorizedAtEnqueue && currentRootActive;
}
`;
export const BLOCKED_WORKER_SOURCE = `export function mayDispatch(job, currentRootActive) {
  return false;
}
`;

export interface CancellationServiceSources {
  readonly 'server.mjs': string;
  readonly 'worker-authority.mjs': string;
}
export const cancellationRecipeSchema = z
  .object({
    recipe: z.literal('check-current-root-authority.v1'),
    file: z.literal('worker-authority.mjs'),
    beforeDigest: digest,
    afterDigest: digest,
    diff: z.string().min(1).max(8192),
    scope: z.literal('isolated-authored-example'),
  })
  .strict();
export type CancellationRecipe = z.infer<typeof cancellationRecipeSchema>;

function sourceDiff(): string {
  const before = CACHED_WORKER_SOURCE.trimEnd().split('\n');
  const after = CURRENT_WORKER_SOURCE.trimEnd().split('\n');
  return `--- a/worker-authority.mjs\n+++ b/worker-authority.mjs\n@@ -1,${before.length} +1,${after.length} @@\n${before.map((line) => `-${line}`).join('\n')}\n${after.map((line) => `+${line}`).join('\n')}\n`;
}
export function createCancellationRecipe(): CancellationRecipe {
  return {
    recipe: 'check-current-root-authority.v1',
    file: 'worker-authority.mjs',
    beforeDigest: sha256(CACHED_WORKER_SOURCE),
    afterDigest: sha256(CURRENT_WORKER_SOURCE),
    diff: sourceDiff(),
    scope: 'isolated-authored-example',
  };
}

/** Exact source recipe for one sequential authored workflow, not distributed fencing. */
export function verifyCancellationRecipe(input: {
  readonly beforeSources: CancellationServiceSources;
  readonly afterSources: CancellationServiceSources;
  readonly proposal: unknown;
}): CancellationRecipe {
  const proposal = parseInput(
    cancellationRecipeSchema,
    input.proposal,
    'INVALID_CANCELLATION_RECIPE',
    'Cancellation repair',
  );
  if (
    input.beforeSources['worker-authority.mjs'] !== CACHED_WORKER_SOURCE ||
    input.afterSources['worker-authority.mjs'] !== CURRENT_WORKER_SOURCE ||
    input.beforeSources['server.mjs'] !== input.afterSources['server.mjs'] ||
    jsonDigest(proposal) !== jsonDigest(createCancellationRecipe())
  )
    throw new InvestigatorError(
      'INVALID_CANCELLATION_RECIPE',
      'The supplied repair does not match the exact worker change and unchanged service.',
    );
  return proposal;
}

export async function applyCancellationRecipe(
  directory: string,
  expectedBeforeDigest = sha256(CACHED_WORKER_SOURCE),
): Promise<CancellationRecipe> {
  const proposal = createCancellationRecipe();
  if (expectedBeforeDigest !== proposal.beforeDigest)
    throw new InvestigatorError(
      'CANCELLATION_PREIMAGE_MISMATCH',
      'The selected worker revision does not match the supported repair.',
    );
  const handle = await open(
    join(directory, proposal.file),
    constants.O_RDWR | constants.O_NOFOLLOW,
  ).catch(() => {
    throw new InvestigatorError(
      'CANCELLATION_PREIMAGE_MISMATCH',
      'The selected worker source cannot be opened safely.',
    );
  });
  try {
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      stat.size > 65_536 ||
      (await handle.readFile('utf8')) !== CACHED_WORKER_SOURCE
    )
      throw new InvestigatorError(
        'CANCELLATION_PREIMAGE_MISMATCH',
        'The selected worker source does not match the supported repair preimage.',
      );
    await handle.truncate(0);
    await handle.write(CURRENT_WORKER_SOURCE, 0, 'utf8');
  } finally {
    await handle.close();
  }
  return proposal;
}
