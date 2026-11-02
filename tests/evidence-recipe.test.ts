import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  applyEvidenceRecipe,
  BOUND_EVIDENCE_PRODUCER,
  createEvidenceRecipeProposal,
  LEGACY_EVIDENCE_PRODUCER,
  verifyEvidenceRecipe,
} from '../src/remediation/evidence-recipe.js';
import {
  copyEvidenceGapService,
  evidenceGapBusinessDigest,
  evidenceGapServiceSources,
  runEvidenceGapService,
  SYNTHETIC_CUSTOMER_CANARY,
} from '../src/targets/evidence-gap-service.js';

describe('authored evidence producer recipe and independent destination capture', () => {
  it('changes observability while preserving safe/unsafe business behavior and withholding payloads', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'investigator-evidence-recipe-'));
    try {
      await copyEvidenceGapService(directory);
      const beforeSources = await evidenceGapServiceSources(directory);
      const safeBefore = await runEvidenceGapService({ directory, authorization: 'safe' });
      const unsafeBefore = await runEvidenceGapService({ directory, authorization: 'unsafe' });
      const proposal = await applyEvidenceRecipe(directory);
      const afterSources = await evidenceGapServiceSources(directory);
      const safeAfter = await runEvidenceGapService({ directory, authorization: 'safe' });
      const unsafeAfter = await runEvidenceGapService({ directory, authorization: 'unsafe' });
      expect(verifyEvidenceRecipe({ beforeSources, afterSources, proposal })).toEqual(proposal);
      expect(beforeSources['server.mjs']).toBe(afterSources['server.mjs']);
      expect(safeBefore.instrumentation).toBe('legacy');
      expect(safeAfter.instrumentation).toBe('bound');
      expect(safeBefore.scenarios.map((scenario) => scenario.effects.length)).toEqual([1, 0, 0, 0]);
      expect(safeAfter.scenarios.map((scenario) => scenario.effects.length)).toEqual([1, 0, 0, 0]);
      expect(unsafeBefore.scenarios.map((scenario) => scenario.effects.length)).toEqual([
        1, 1, 0, 0,
      ]);
      expect(unsafeAfter.scenarios.map((scenario) => scenario.effects.length)).toEqual([
        1, 1, 0, 0,
      ]);
      expect(safeBefore.businessDigest).toBe(safeAfter.businessDigest);
      expect(unsafeBefore.businessDigest).toBe(unsafeAfter.businessDigest);
      expect(safeAfter.businessDigest).not.toBe(unsafeAfter.businessDigest);
      expect(evidenceGapBusinessDigest(safeAfter.scenarios)).toBe(safeAfter.businessDigest);
      const permitted = safeAfter.scenarios[0]!;
      const execution = permitted.telemetry.find((event) => event.type === 'execution');
      expect(execution?.type).toBe('execution');
      if (execution?.type !== 'execution') throw new Error('Execution witness missing');
      expect(execution.requestDigest).toBe(permitted.approval?.requestDigest);
      expect(execution.requestDigest).toBe(permitted.effects[0]?.requestDigest);
      expect(execution.requestDigest).toBe(permitted.attempt.requestDigest);
      expect(execution.executionId).toBe(permitted.effects[0]?.executionId);
      expect(execution.grantId).toBe(permitted.approval?.grantId);
      const wrongRequest = unsafeAfter.scenarios[1]!;
      const unsafeExecution = wrongRequest.telemetry.find((event) => event.type === 'execution');
      if (unsafeExecution?.type !== 'execution') throw new Error('Unsafe effect witness missing');
      expect(unsafeExecution.requestDigest).not.toBe(wrongRequest.approval?.requestDigest);
      expect(unsafeExecution.requestDigest).toBe(wrongRequest.attempt.requestDigest);
      expect(unsafeExecution.requestDigest).toBe(wrongRequest.effects[0]?.requestDigest);
      for (const run of [safeBefore, unsafeBefore, safeAfter, unsafeAfter]) {
        expect(run.capture).toEqual({
          status: 'complete',
          scope: 'isolated-authored-workload',
          sinkClosed: true,
        });
        expect(JSON.stringify(run)).not.toContain(SYNTHETIC_CUSTOMER_CANARY);
        expect(JSON.stringify(run)).not.toContain('customerContent');
        expect(run.finishedAt >= run.startedAt).toBe(true);
        for (const scenario of run.scenarios) {
          expect(scenario.attempt.workId).toBe(scenario.workId);
          expect(scenario.attempt.grantId).toBe(scenario.approval?.grantId ?? null);
          if (scenario.id === 'wrong-request')
            expect(scenario.attempt.requestDigest).not.toBe(scenario.approval?.requestDigest);
          if (scenario.id === 'self-approval')
            expect(scenario.attempt.actorId).toBe(scenario.approval?.reviewerId);
          expect(scenario.telemetry.some((event) => event.type === 'decision')).toBe(true);
          expect(scenario.responseStatus).toBe(scenario.effects.length ? 'executed' : 'denied');
        }
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects an unexpected producer preimage and an already-applied recipe', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'investigator-evidence-preimage-'));
    try {
      await copyEvidenceGapService(directory);
      await expect(applyEvidenceRecipe(directory, '0'.repeat(64))).rejects.toMatchObject({
        code: 'EVIDENCE_PREIMAGE_MISMATCH',
      });
      expect(await readFile(join(directory, 'instrumentation.mjs'), 'utf8')).toBe(
        LEGACY_EVIDENCE_PRODUCER,
      );
      await applyEvidenceRecipe(directory);
      await expect(applyEvidenceRecipe(directory)).rejects.toMatchObject({
        code: 'EVIDENCE_PREIMAGE_MISMATCH',
      });
      expect(await readFile(join(directory, 'instrumentation.mjs'), 'utf8')).toBe(
        BOUND_EVIDENCE_PRODUCER,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('does not execute another source tree or a modified business implementation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'investigator-evidence-source-'));
    try {
      await copyEvidenceGapService(directory);
      const sources = await evidenceGapServiceSources(directory);
      await writeFile(
        join(directory, 'server.mjs'),
        `${sources['server.mjs']}\n// unrelated source change\n`,
      );
      await expect(
        runEvidenceGapService({ directory, authorization: 'safe' }),
      ).rejects.toMatchObject({ code: 'EVIDENCE_TARGET_CHANGED' });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects a selected symlink without touching its target', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'investigator-evidence-link-'));
    try {
      const target = join(directory, 'private.mjs');
      await writeFile(target, LEGACY_EVIDENCE_PRODUCER);
      await symlink(target, join(directory, 'instrumentation.mjs'));
      await expect(applyEvidenceRecipe(directory)).rejects.toMatchObject({
        code: 'SOURCE_UNAVAILABLE',
      });
      expect(await readFile(target, 'utf8')).toBe(LEGACY_EVIDENCE_PRODUCER);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects forged recipe assertions and an authorization change in the source manifest', () => {
    const beforeSources = {
      'server.mjs': 'unchanged source',
      'instrumentation.mjs': LEGACY_EVIDENCE_PRODUCER,
    };
    const afterSources = {
      'server.mjs': 'unchanged source',
      'instrumentation.mjs': BOUND_EVIDENCE_PRODUCER,
    };
    const proposal = createEvidenceRecipeProposal();
    expect(() =>
      verifyEvidenceRecipe({
        beforeSources,
        afterSources,
        proposal: { ...proposal, collectedFields: [] },
      }),
    ).toThrow();
    expect(() =>
      verifyEvidenceRecipe({
        beforeSources,
        afterSources: { ...afterSources, 'server.mjs': 'authorization changed' },
        proposal,
      }),
    ).toThrow();
  });
});
