import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { initializeControlCase } from '../src/connectors/init-case.js';
import { investigate } from '../src/core/coordinator.js';
import { ScriptedReferenceProvider } from '../src/providers/scripted-reference.js';
import { runApprovalControlChecks } from '../src/reference/approval-control.js';
import { createCaseReport, verifyCaseReport } from '../src/reports/case-report.js';
import { referenceCase } from './helpers.js';

describe('operator selected extension boundary', () => {
  it('supports a new host-registered adapter identity without editing core schemas', async () => {
    const bundle = await referenceCase();
    delete bundle.controlCase.referenceTarget;
    bundle.controlCase.subject = {
      id: 'third-party-application',
      environment: 'repository',
      revision: 'a'.repeat(64),
    };
    bundle.controlCase.controlledTarget = {
      kind: 'third-party-approval',
      version: 1,
      configurationDigest: 'b'.repeat(64),
    };
    const run = await investigate({
      ...bundle,
      provider: new ScriptedReferenceProvider(),
      checkAdapter: {
        id: 'third-party-approval',
        version: 1,
        subjectRevision: 'a'.repeat(64),
        configurationDigest: 'b'.repeat(64),
        runChecks: async () => runApprovalControlChecks('request-bound'),
      },
    });
    const report = createCaseReport(bundle.controlCase, bundle.evidence, run);
    expect(verifyCaseReport(report).run.finding?.verdict).toBe('supported');
    expect(
      report.evidence.find((artifact) => artifact.id === 'control-check-results')?.source.reference,
    ).toContain('controlled-target:third-party-approval:v1:');
  });

  it('refuses a transport configuration not matching the frozen case', async () => {
    const bundle = await referenceCase();
    delete bundle.controlCase.referenceTarget;
    bundle.controlCase.subject = {
      id: 'third-party-application',
      environment: 'repository',
      revision: 'a'.repeat(64),
    };
    bundle.controlCase.controlledTarget = {
      kind: 'third-party-approval',
      version: 1,
      configurationDigest: 'b'.repeat(64),
    };
    let executed = false;
    const run = await investigate({
      ...bundle,
      provider: new ScriptedReferenceProvider(),
      checkAdapter: {
        id: 'third-party-approval',
        version: 1,
        subjectRevision: 'a'.repeat(64),
        configurationDigest: 'c'.repeat(64),
        async runChecks() {
          executed = true;
          return [];
        },
      },
    });
    expect(executed).toBe(false);
    expect(run.finding).toBeNull();
  });

  it('initializes a bound case with no credentials or target execution', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'investigator-init-'));
    try {
      const path = join(directory, 'target.json');
      await writeFile(
        path,
        JSON.stringify({
          kind: 'http-approval-target',
          schemaVersion: 1,
          fixtureProtocol: 'approval-target-v1',
          subjectRevision: 'a'.repeat(64),
          target: {
            baseUrl: 'https://target.example',
            credentialEnv: 'TARGET_SUBMIT',
            adminCredentialEnv: 'TARGET_ADMIN',
          },
          observer: { baseUrl: 'https://observer.example', credentialEnv: 'OBSERVER_ADMIN' },
        }),
      );
      const initialized = await initializeControlCase(join(directory, 'case'), path);
      expect(initialized).toMatchObject({
        assessmentMode: 'controlled-test',
        controlledTarget: { kind: 'http-approval-target', version: 1 },
        subject: { environment: 'repository', revision: 'a'.repeat(64) },
      });
      expect(initialized.controlledTarget?.configurationDigest).toMatch(/^[a-f0-9]{64}$/);
      expect(initialized.referenceTarget).toBeUndefined();
      expect(JSON.stringify(initialized)).not.toContain('https://target.example');
      await expect(initializeControlCase(join(directory, 'case'), path)).rejects.toThrow(
        'new available',
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
