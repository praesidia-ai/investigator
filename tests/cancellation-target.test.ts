import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  assessCancellationExperiments,
  independentWorkObserved,
} from '../src/cancellation/assessment.js';
import {
  CACHED_WORKER_SOURCE,
  CURRENT_WORKER_SOURCE,
  applyCancellationRecipe,
  verifyCancellationRecipe,
} from '../src/cancellation/recipe.js';
import { CANCELLATION_EXPERIMENT_IDS } from '../src/cancellation/schemas.js';
import {
  CANCELLATION_CONTENT_CANARY,
  cancellationServiceSources,
  prepareCancellationService,
  runCancellationExperiment,
  type CancellationFixtureMode,
} from '../src/cancellation/target.js';

async function isolated<T>(
  mode: CancellationFixtureMode,
  action: (directory: string) => Promise<T>,
): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), 'investigator-cancel-target-'));
  try {
    await prepareCancellationService(directory, mode);
    return await action(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe('independent cancellation effects', () => {
  it('observes late acceptances despite cancelled worker status, patches the real worker and preserves legitimate work', async () => {
    await isolated('cached-worker', async (directory) => {
      const sourcesBefore = await cancellationServiceSources(directory);
      const before = [];
      for (const experimentId of CANCELLATION_EXPERIMENT_IDS)
        before.push(await runCancellationExperiment({ directory, experimentId }));
      expect(assessCancellationExperiments(before).verdict).toBe('contradicted');
      const queued = before.find((capture) => capture.experimentId === 'queued-after-revoke')!;
      expect(
        queued.workerClaims.some(
          (claim) => claim.rootId === 'root:retired' && claim.state === 'cancelled',
        ),
      ).toBe(true);
      expect(queued.effects).toHaveLength(1);
      expect(queued.effects[0]!.acceptSequence).toBeGreaterThan(queued.cut!.ackSequence);
      expect(queued.attempts[0]!.enqueueSequence).toBeLessThan(queued.cut!.ackSequence);
      expect(queued.attempts[0]!.dispatchSequence).toBeGreaterThan(queued.cut!.ackSequence);
      const independentBefore = before.find(
        (capture) => capture.experimentId === 'independent-root',
      )!;
      expect(independentWorkObserved(independentBefore)).toBe(true);
      const priorBefore = before.find(
        (capture) => capture.experimentId === 'accepted-before-revoke',
      )!;
      expect(priorBefore.effects[0]!.acceptSequence).toBeLessThan(priorBefore.cut!.ackSequence);
      const proposal = await applyCancellationRecipe(directory);
      const sourcesAfter = await cancellationServiceSources(directory);
      expect(
        verifyCancellationRecipe({
          beforeSources: sourcesBefore,
          afterSources: sourcesAfter,
          proposal,
        }),
      ).toEqual(proposal);
      expect(sourcesBefore['server.mjs']).toBe(sourcesAfter['server.mjs']);
      expect(sourcesBefore['worker-authority.mjs']).toBe(CACHED_WORKER_SOURCE);
      expect(sourcesAfter['worker-authority.mjs']).toBe(CURRENT_WORKER_SOURCE);
      const after = [];
      for (const experimentId of CANCELLATION_EXPERIMENT_IDS)
        after.push(await runCancellationExperiment({ directory, experimentId }));
      expect(assessCancellationExperiments(after).verdict).toBe('supported');
      const independentAfter = after.find(
        (capture) => capture.experimentId === 'independent-root',
      )!;
      expect(independentWorkObserved(independentAfter)).toBe(true);
      expect(
        independentAfter.effects
          .filter((effect) => effect.rootId === 'root:independent')
          .map((effect) => effect.requestDigest),
      ).toEqual(
        independentBefore.effects
          .filter((effect) => effect.rootId === 'root:independent')
          .map((effect) => effect.requestDigest),
      );
      const priorAfter = after.find(
        (capture) => capture.experimentId === 'accepted-before-revoke',
      )!;
      expect(priorAfter.effects.map((effect) => effect.requestDigest)).toEqual(
        priorBefore.effects.map((effect) => effect.requestDigest),
      );
      expect(after[0]!.subjectRevision).not.toBe(before[0]!.subjectRevision);
      expect(
        JSON.stringify({ before, after, sourcesBefore, sourcesAfter, proposal }),
      ).not.toContain(CANCELLATION_CONTENT_CANARY);
      expect(JSON.stringify(before)).not.toMatch(/cached-worker|capture-gap|block-all/);
    });
  });

  it('keeps missing revocation capture unresolved instead of treating status messages as authority', async () => {
    await isolated('capture-gap', async (directory) => {
      const captures = [];
      for (const experimentId of CANCELLATION_EXPERIMENT_IDS)
        captures.push(await runCancellationExperiment({ directory, experimentId }));
      expect(
        captures.every(
          (capture) =>
            capture.cut === null &&
            capture.observation.status === 'partial' &&
            capture.observation.windowClosed,
        ),
      ).toBe(true);
      expect(captures[0]!.effects).toHaveLength(1);
      expect(assessCancellationExperiments(captures).verdict).toBe('insufficient_evidence');
      expect(
        independentWorkObserved(
          captures.find((capture) => capture.experimentId === 'independent-root'),
        ),
      ).toBe(false);
    });
  });

  it('rejects a denial-all implementation through the independent and pre-cut positive controls', async () => {
    await isolated('block-all', async (directory) => {
      const captures = [];
      for (const experimentId of CANCELLATION_EXPERIMENT_IDS)
        captures.push(await runCancellationExperiment({ directory, experimentId }));
      const assessment = assessCancellationExperiments(captures);
      expect(assessment.verdict).toBe('contradicted');
      expect(
        assessment.checks.find((check) => check.experimentId === 'independent-root')?.status,
      ).toBe('FAIL');
      expect(
        assessment.checks.find((check) => check.experimentId === 'accepted-before-revoke')?.status,
      ).toBe('FAIL');
      expect(captures.every((capture) => capture.effects.length === 0)).toBe(true);
    });
  });

  it('refuses unsupported source changes, changed preimages and final symlinks', async () => {
    await isolated('current-worker', async (directory) => {
      await expect(applyCancellationRecipe(directory)).rejects.toMatchObject({
        code: 'CANCELLATION_PREIMAGE_MISMATCH',
      });
      await writeFile(
        join(directory, 'server.mjs'),
        `${(await cancellationServiceSources(directory))['server.mjs']}\n// changed\n`,
      );
      await expect(
        runCancellationExperiment({ directory, experimentId: 'queued-after-revoke' }),
      ).rejects.toMatchObject({ code: 'CANCELLATION_TARGET_CHANGED' });
    });
    await isolated('cached-worker', async (directory) => {
      await expect(applyCancellationRecipe(directory, 'f'.repeat(64))).rejects.toMatchObject({
        code: 'CANCELLATION_PREIMAGE_MISMATCH',
      });
      const original = await readFile(join(directory, 'worker-authority.mjs'), 'utf8');
      await writeFile(join(directory, 'original.mjs'), original);
      await rm(join(directory, 'worker-authority.mjs'));
      await symlink(join(directory, 'original.mjs'), join(directory, 'worker-authority.mjs'));
      await expect(applyCancellationRecipe(directory)).rejects.toMatchObject({
        code: 'CANCELLATION_PREIMAGE_MISMATCH',
      });
      expect(await readFile(join(directory, 'original.mjs'), 'utf8')).toBe(original);
    });
  });

  it('does not start a cancelled experiment', async () => {
    await isolated('cached-worker', async (directory) => {
      await expect(
        runCancellationExperiment({
          directory,
          experimentId: 'queued-after-revoke',
          signal: AbortSignal.abort(),
        }),
      ).rejects.toThrow();
    });
  });
});
