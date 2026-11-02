import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runExternalApprovalChecks } from '../src/reference/approval-control.js';
import { ScriptedReferenceProvider } from '../src/providers/scripted-reference.js';
import {
  copyExportService,
  exportServiceRevision,
  LocalExportServiceAdapter,
} from '../src/targets/local-export-service.js';
import {
  runRepairWorkflow,
  verifyRepairResult,
  writeRepairBundle,
} from '../src/remediation/repair-workflow.js';

async function withTarget(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'investigator-target-test-'));
  try {
    await copyExportService(directory);
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe('independent HTTP target and observed effects', () => {
  it('classifies an unavailable application response as an execution error', async () => {
    const checks = await runExternalApprovalChecks(
      {
        reset: async () => {},
        effects: () => [],
        submit: async () => ({
          status: 'unavailable',
          reason: 'Unavailable',
          claimedEffectCount: 0,
        }),
      },
      AbortSignal.timeout(1000),
    );
    expect(checks.map((check) => check.status)).toEqual(['ERROR', 'ERROR', 'ERROR']);
  });
  it('reproduces the actual request-binding bypass in a separate process', async () => {
    await withTarget(async (directory) => {
      const adapter = new LocalExportServiceAdapter(
        directory,
        await exportServiceRevision(directory),
      );
      const checks = await adapter.runChecks(AbortSignal.timeout(10_000));
      expect(checks.map((check) => check.status)).toEqual(['PASS', 'FAIL', 'PASS']);
      expect(JSON.stringify(checks)).not.toMatch(/FIXTURE_ADMIN_TOKEN|Bearer /);
      const observation = checks[1]!.observations[0] as {
        status: string;
        effectObservation: { additionalEffects: unknown[] };
      };
      expect(observation.status).toBe('FAIL');
      expect(observation.effectObservation.additionalEffects).toHaveLength(1);
    });
  });

  it('rejects changed source before starting a target', async () => {
    await withTarget(async (directory) => {
      const adapter = new LocalExportServiceAdapter(
        directory,
        await exportServiceRevision(directory),
      );
      await writeFile(join(directory, 'authorization.mjs'), 'throw new Error("changed");');
      await expect(adapter.runChecks(AbortSignal.timeout(1000))).rejects.toMatchObject({
        code: 'CHECK_TARGET_CHANGED',
      });
    });
  });

  it('does not equate a refusal response with prevented effects', async () => {
    await withTarget(async (directory) => {
      const path = join(directory, 'server.mjs');
      const source = await readFile(path, 'utf8');
      await writeFile(path, source.replace("status: 'executed',", "status: 'denied',"));
      const adapter = new LocalExportServiceAdapter(
        directory,
        await exportServiceRevision(directory),
      );
      const checks = await adapter.runChecks(AbortSignal.timeout(10_000));
      expect(checks[1]!.status).toBe('FAIL');
      expect(checks[2]!.status).toBe('FAIL');
    });
  });

  it('treats unavailable target execution as ERROR, never prevention', async () => {
    await withTarget(async (directory) => {
      const path = join(directory, 'server.mjs');
      const source = await readFile(path, 'utf8');
      await writeFile(
        path,
        source.replace("if (req.url !== '/export')", "if (true || req.url !== '/export')"),
      );
      const adapter = new LocalExportServiceAdapter(
        directory,
        await exportServiceRevision(directory),
      );
      expect(
        (await adapter.runChecks(AbortSignal.timeout(10_000))).map((check) => check.status),
      ).toEqual(['ERROR', 'ERROR', 'ERROR']);
    });
  });
});

describe('bounded repair with unchanged retest', () => {
  it('preserves a failed retest without claiming the repair succeeded', async () => {
    let runs = 0;
    const result = await runRepairWorkflow({
      providerFactory: () =>
        ++runs === 1
          ? new ScriptedReferenceProvider()
          : {
              id: 'offline',
              model: 'offline',
              mode: 'scripted',
              async complete() {
                throw new Error('unavailable');
              },
            },
    });
    expect(result.after.run.status).toBe('failed');
    expect(result.verification).toMatchObject({
      unchangedExpectations: false,
      closedGap: false,
      permittedWorkPreserved: false,
    });
    expect(verifyRepairResult(result).verification.closedGap).toBe(false);
  });
  it('changes real code, closes the bypass and preserves permitted work', async () => {
    const result = await runRepairWorkflow();
    expect(result.before.run.finding?.verdict).toBe('contradicted');
    expect(result.after.run.finding?.verdict).toBe('supported');
    expect(result.before.controlCase.subject.revision).not.toBe(
      result.after.controlCase.subject.revision,
    );
    expect(result.change.beforeDigest).not.toBe(result.change.afterDigest);
    expect(result.change.diff).toContain('+  return grant.requestDigest === requestDigest;');
    expect(result.verification).toMatchObject({
      unchangedExpectations: true,
      closedGap: true,
      permittedWorkPreserved: true,
      scope: 'isolated-authored-example',
    });
    expect(result.before.run.provider.mode).toBe('scripted');
    expect(verifyRepairResult(result)).toEqual(result);
    const forged = { ...result, change: { ...result.change, afterDigest: '0'.repeat(64) } };
    expect(() => verifyRepairResult(forged)).toThrow('recorded source revisions');
    const altered = {
      ...result,
      application: {
        ...result.application,
        after: {
          ...result.application.after,
          'authorization.mjs':
            result.application.after['authorization.mjs'] + '\n// unrecorded change',
        },
      },
    };
    expect(() => verifyRepairResult(altered)).toThrow('recorded source revisions');
    const directory = await mkdtemp(join(tmpdir(), 'investigator-repair-test-'));
    try {
      const output = join(directory, 'result');
      await writeRepairBundle(output, result);
      expect(await readFile(join(output, 'repair.diff'), 'utf8')).toBe(result.change.diff);
      expect(await readFile(join(output, 'after.html'), 'utf8')).toContain(
        'Supported in declared scope',
      );
      await expect(writeRepairBundle(output, result)).rejects.toMatchObject({
        code: 'OUTPUT_EXISTS',
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('does not apply a recipe without an established supported defect', async () => {
    await expect(
      runRepairWorkflow({
        providerFactory: () => ({
          id: 'failure',
          model: 'failure',
          mode: 'scripted',
          async complete() {
            throw new Error('unavailable');
          },
        }),
      }),
    ).rejects.toMatchObject({ code: 'REPAIR_PREREQUISITE_FAILED' });
  });
});
