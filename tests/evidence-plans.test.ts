import { beforeAll, describe, expect, it, vi } from 'vitest';
import { readFile, rm, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadClientContext } from '../src/context/load.js';
import { runCli } from '../src/cli.js';
import { output } from './helpers.js';
import { assessEvidenceCapture } from '../src/evidence-plans/gap-analysis.js';
import { investigateEvidenceGap } from '../src/evidence-plans/investigate.js';
import {
  runEvidencePlanWorkflow,
  verifyEvidencePlanReport,
  writeEvidencePlanBundle,
  type EvidencePlanReport,
} from '../src/evidence-plans/workflow.js';
import { renderEvidencePlanHtml } from '../src/reports/evidence-plan-html.js';
import { ScriptedEvidenceProvider } from '../src/providers/scripted-evidence.js';
import type { ModelProvider } from '../src/providers/model-provider.js';
import {
  evidenceGapBusinessDigest,
  SYNTHETIC_CUSTOMER_CANARY,
} from '../src/targets/evidence-gap-service.js';

const example = fileURLToPath(new URL('../examples/client-evidence-gap/', import.meta.url));
let report: EvidencePlanReport;
beforeAll(async () => {
  report = await runEvidencePlanWorkflow();
});

describe('client-aware evidence planning', () => {
  it('makes a safe control assessable while exposing unsafe behavior without changing business outcomes', () => {
    expect(report.assessments.safeBefore.verdict).toBe('insufficient_evidence');
    expect(report.assessments.unsafeBefore.verdict).toBe('insufficient_evidence');
    expect(report.assessments.safeAfter.verdict).toBe('supported');
    expect(report.assessments.unsafeAfter.verdict).toBe('contradicted');
    expect(report.validation).toMatchObject({
      safeBehaviorPreserved: true,
      unsafeBehaviorPreserved: true,
      safeBecameAssessable: true,
      unsafeStillFails: true,
      excludedCanaryAbsent: true,
    });
    expect(report.validation.witnessChecks.length).toBe(20);
    expect(
      report.validation.witnessChecks.every(
        (check) => check.verdictWithoutField === 'insufficient_evidence',
      ),
    ).toBe(true);
    expect(JSON.stringify(report)).not.toContain(SYNTHETIC_CUSTOMER_CANARY);
    expect(report.application.before['server.mjs']).toBe(report.application.after['server.mjs']);
    expect(report.planning.provider.mode).toBe('scripted');
    expect(report.context.context.sources[0]?.coverage).toBe('partial');
  });

  it('does not mistake a scenario label for an observed negative attempt', () => {
    const capture = structuredClone(report.after.safe);
    const wrong = capture.scenarios.find((scenario) => scenario.id === 'wrong-request')!;
    wrong.approval!.requestDigest = wrong.attempt.requestDigest;
    capture.businessDigest = evidenceGapBusinessDigest(capture.scenarios);
    expect(assessEvidenceCapture(capture).verdict).toBe('insufficient_evidence');
    expect(
      assessEvidenceCapture(capture).gaps.some((gap) => gap.id === 'wrong-request:attempt'),
    ).toBe(true);
    const noApproval = structuredClone(report.after.safe);
    noApproval.scenarios.find((scenario) => scenario.id === 'no-approval')!.approval =
      structuredClone(report.after.safe.scenarios[0]!.approval);
    noApproval.businessDigest = evidenceGapBusinessDigest(noApproval.scenarios);
    expect(assessEvidenceCapture(noApproval).verdict).toBe('insufficient_evidence');
  });

  it('keeps a proven violation when irrelevant legacy records are added', () => {
    const capture = structuredClone(report.after.unsafe);
    const wrong = capture.scenarios.find((scenario) => scenario.id === 'wrong-request')!;
    wrong.telemetry.push({
      type: 'legacy-execution',
      executionId: 'unrelated',
      deploymentRevision: capture.sourceRevision,
      observedAt: wrong.telemetry[0]!.observedAt,
    });
    expect(assessEvidenceCapture(capture).verdict).toBe('contradicted');
  });

  it('rejects wrong tenant-like principal identity, revision, observation window and sink joins', () => {
    for (const mutate of [
      (copy: typeof report.after.safe) => {
        copy.scenarios[0]!.attempt.actorId = 'other-tenant:export';
        copy.businessDigest = evidenceGapBusinessDigest(copy.scenarios);
      },
      (copy: typeof report.after.safe) => {
        copy.scenarios[0]!.approval!.deploymentRevision = 'f'.repeat(64);
      },
      (copy: typeof report.after.safe) => {
        copy.scenarios[0]!.effects[0]!.observedAt = '2020-01-01T00:00:00.000Z';
      },
      (copy: typeof report.after.safe) => {
        copy.scenarios[0]!.effects[0]!.executionId = 'unrelated';
      },
    ]) {
      const copy = structuredClone(report.after.safe);
      mutate(copy);
      expect(assessEvidenceCapture(copy).verdict).toBe('insufficient_evidence');
    }
    const partial = {
      ...report.after.safe,
      capture: { ...report.after.safe.capture, sinkClosed: false },
    };
    expect(assessEvidenceCapture(partial).verdict).toBe('insufficient_evidence');
  });

  it('recomputes saved claims and exact producer changes instead of trusting report booleans', () => {
    expect(verifyEvidencePlanReport(JSON.parse(JSON.stringify(report)))).toEqual(report);
    const forged = structuredClone(report);
    forged.validation.unsafeStillFails = false;
    expect(() => verifyEvidencePlanReport(forged)).toThrow(/assertions/);
    const changed = structuredClone(report);
    changed.application.after['server.mjs'] += '\n// changed';
    expect(() => verifyEvidencePlanReport(changed)).toThrow(/unchanged application/);
    const unread = structuredClone(report);
    unread.planning.calls.forEach((call) => {
      call.tool = 'inspect_client_context';
    });
    expect(() => verifyEvidencePlanReport(unread)).toThrow(/exact producer read/);
    const oldCapture = structuredClone(report);
    oldCapture.after.safe.startedAt = '2020-01-01T00:00:00.000Z';
    expect(() => verifyEvidencePlanReport(oldCapture)).toThrow(/after-change capture/);
    const privacy = structuredClone(report);
    privacy.evidence[0]!.content += SYNTHETIC_CUSTOMER_CANARY;
    expect(() => verifyEvidencePlanReport(privacy)).toThrow();
  });

  it('binds preserved business work to the issued approval semantics', () => {
    const copy = structuredClone(report.before.safe.scenarios);
    copy[0]!.approval!.reviewerId = 'different-reviewer';
    expect(evidenceGapBusinessDigest(copy)).not.toBe(report.before.safe.businessDigest);
  });

  it('requires the exact cited producer location to have been read and bounds scope before a call', async () => {
    const bundle = await loadClientContext(example);
    let turn = 0;
    const provider: ModelProvider = {
      id: 'test',
      model: 'test',
      mode: 'scripted',
      complete: vi.fn(async () => {
        turn += 1;
        if (turn === 1)
          return {
            text: '',
            state: [],
            toolCalls: [
              {
                id: 'c',
                name: 'inspect_client_context',
                arguments: { entityIndex: 0, depth: 1, maxEntities: 4 },
              },
            ],
          };
        if (turn === 2)
          return {
            text: '',
            state: [],
            toolCalls: [
              {
                id: 'r',
                name: 'read_client_evidence',
                arguments: { evidenceId: 'producer', locator: { kind: 'lines', start: 1, end: 1 } },
              },
            ],
          };
        return { text: JSON.stringify(report.planning.request), state: [], toolCalls: [] };
      }),
    };
    const options = {
      snapshot: bundle.snapshot,
      evidence: bundle.evidence,
      gapIds: report.assessments.safeBefore.gaps.map((gap) => gap.id),
      producerEvidenceId: 'producer',
      provider,
    };
    await expect(investigateEvidenceGap(options)).rejects.toMatchObject({
      code: 'UNREAD_PRODUCER',
    });
    vi.mocked(provider.complete).mockClear();
    await expect(
      investigateEvidenceGap({
        ...options,
        gapIds: Array.from({ length: 17 }, (_item, index) => `gap:${index}`),
      }),
    ).rejects.toMatchObject({ code: 'INVALID_EVIDENCE_REQUEST' });
    await expect(
      investigateEvidenceGap({ ...options, producerEvidenceId: 'not-selected' }),
    ).rejects.toMatchObject({ code: 'SOURCE_ACCESS_DENIED' });
    expect(provider.complete).not.toHaveBeenCalled();
  });

  it('keeps raw fixture data out of all planning requests and never falls back on live failure', async () => {
    const bundle = await loadClientContext(example);
    const base = new ScriptedEvidenceProvider(report.planning.request);
    const requests: string[] = [];
    const provider: ModelProvider = {
      id: base.id,
      model: base.model,
      mode: base.mode,
      complete: async (request) => {
        requests.push(JSON.stringify(request));
        return base.complete(request);
      },
    };
    const options = {
      snapshot: bundle.snapshot,
      evidence: bundle.evidence,
      gapIds: report.assessments.safeBefore.gaps.map((gap) => gap.id),
      producerEvidenceId: 'producer',
      provider,
    };
    expect((await investigateEvidenceGap(options)).request).toEqual(report.planning.request);
    expect(requests.join('')).not.toContain(SYNTHETIC_CUSTOMER_CANARY);
    await expect(
      investigateEvidenceGap({
        ...options,
        provider: {
          id: 'live',
          model: 'live',
          mode: 'live',
          complete: async () => {
            throw new Error('upstream failure');
          },
        },
      }),
    ).rejects.toThrow('upstream failure');
    await expect(
      investigateEvidenceGap({
        ...options,
        maxDurationMs: 10,
        provider: {
          id: 'never',
          model: 'never',
          mode: 'live',
          complete: () => new Promise(() => {}),
        },
      }),
    ).rejects.toMatchObject({ code: 'RUN_ABORTED' });
  });

  it('writes inert inspectable reports exclusively and exposes standalone CLI entry points', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'investigator-evidence-test-'));
    try {
      const destination = join(directory, 'bundle');
      await writeEvidencePlanBundle(destination, report);
      await expect(writeEvidencePlanBundle(destination, report)).rejects.toMatchObject({
        code: 'OUTPUT_UNAVAILABLE',
      });
      const saved = JSON.parse(
        await readFile(join(destination, 'evidence-plan.json'), 'utf8'),
      ) as unknown;
      expect(verifyEvidencePlanReport(saved)).toEqual(report);
      const { stdout: out, stderr: error, io } = output();
      expect(await runCli(['understand', example, '--json'], {}, io)).toBe(0);
      expect(JSON.parse(out.pop()!)).toMatchObject({
        format: 'investigator-client-context-v1',
        scope: 'selected-sources-only',
      });
      expect(
        await runCli(
          ['verify-evidence', join(destination, 'evidence-plan.json'), '--json'],
          {},
          io,
        ),
      ).toBe(0);
      expect(JSON.parse(out.pop()!)).toMatchObject({
        authenticity: 'not-established',
        execution: 'not-reexecuted',
      });
      expect(await runCli(['evidence-demo', '--live'], {}, io)).toBe(2);
      expect(error.join('')).toContain('MODEL_KEY_REQUIRED');
      const injection = structuredClone(report);
      injection.planning.request.explanation = '<script>alert(1)</script>';
      const html = renderEvidencePlanHtml(injection);
      expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
      expect(html).not.toContain('<script>');
      expect(html).toContain("default-src 'none'");
      expect(html).not.toContain(SYNTHETIC_CUSTOMER_CANARY);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
