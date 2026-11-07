import { beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createCancellationClient,
  cancellationArtifact,
  cancellationFindingSchema,
  cancellationJsonSchema,
} from '../src/cancellation/client.js';
import { CANCELLATION_TOOLS } from '../src/cancellation/tools.js';
import {
  investigateCancellation,
  verifyCancellationInvestigation,
} from '../src/cancellation/investigate.js';
import {
  evaluateCancellation,
  verifyCancellationTrials,
  writeCancellationTrials,
} from '../src/cancellation/evaluate.js';
import { runCancellationWorkflow, writeCancellationBundle } from '../src/cancellation/workflow.js';
import {
  createCancellationCase,
  verifyCancellationCase,
  type CancellationCase,
} from '../src/cancellation/report.js';
import { assessCancellationExperiments } from '../src/cancellation/assessment.js';
import * as cancellationRuntime from '../src/cancellation/target.js';
import * as cancellationRecipe from '../src/cancellation/recipe.js';
import type { Citation } from '../src/core/schemas.js';
import type { CancellationCapture, CancellationExperimentId } from '../src/cancellation/schemas.js';
import {
  CANCELLATION_CONTENT_CANARY,
  cancellationServiceRevision,
  cancellationServiceSources,
  prepareCancellationService,
  runCancellationExperiment,
} from '../src/cancellation/target.js';
import { ScriptedCancellationProvider } from '../src/providers/scripted-cancellation.js';
import { assertStrictMetaSchema } from '../src/providers/strict-schema.js';
import type { ModelProvider } from '../src/providers/model-provider.js';
import { renderCancellationHtml } from '../src/reports/cancellation-html.js';
import { runCli } from '../src/cli.js';
import { output } from './helpers.js';
import { jsonDigest, type JsonValue } from '../src/core/json.js';

let report: CancellationCase;
beforeAll(async () => {
  report = await runCancellationWorkflow();
}, 30_000);

/** A protocol reference that intentionally leaves host completion work after a grounded finding. */
function partialReferenceProvider(selected: CancellationExperimentId): ModelProvider {
  const setup = new ScriptedCancellationProvider();
  const captures: CancellationCapture[] = [],
    citations: Citation[] = [];
  let turn = 0;
  return {
    id: 'partial-protocol-reference',
    model: 'partial-scripted-reference',
    mode: 'scripted',
    complete: async (request) => {
      for (const item of request.input) {
        if (
          item.type !== 'tool-result' ||
          !item.output ||
          typeof item.output !== 'object' ||
          Array.isArray(item.output)
        )
          continue;
        if ('capture' in item.output)
          captures.push(item.output.capture as unknown as CancellationCapture);
        if ('quote' in item.output) citations.push(item.output as unknown as Citation);
      }
      turn += 1;
      if (turn === 1) return setup.complete(request);
      if (turn === 2)
        return {
          text: '',
          state: [],
          toolCalls: [
            { id: 'selected-probe', name: 'run_experiment', arguments: { experimentId: selected } },
          ],
          usage: { inputTokens: 0, outputTokens: 0 },
        };
      const assessment = assessCancellationExperiments(captures);
      if (turn === 3)
        return {
          text: '',
          state: [],
          usage: { inputTokens: 0, outputTokens: 0 },
          toolCalls: assessment.checks[0]!.witnessPointers.map((pointer, index) => ({
            id: `selected-witness-${index}`,
            name: 'read_evidence',
            arguments: {
              evidenceId: `revocation-probe:${selected}`,
              locator: { kind: 'json-pointer', pointer },
            },
          })),
        };
      return {
        state: [],
        toolCalls: [],
        usage: { inputTokens: 0, outputTokens: 0 },
        text: JSON.stringify({
          verdict: assessment.verdict,
          statement: 'The selected experiment establishes this scoped finding.',
          workingHypothesis: 'Queued work may retain retired authority.',
          alternativeExplanation:
            'Capture or the remaining required experiments may be incomplete.',
          citations,
          missingEvidence:
            assessment.verdict === 'insufficient_evidence'
              ? ['The remaining mandatory experiments have not been selected.']
              : [],
          nextAction:
            assessment.verdict === 'contradicted'
              ? 'check-current-root-authority.v1'
              : 'collect-missing-capture',
        }),
      };
    },
  };
}

describe('model-selected cancellation investigations', () => {
  it('reproduces the late effect, patches only the worker and preserves independent/pre-cut work', () => {
    expect(report.before.status).toBe('completed');
    expect(report.before.finding?.verdict).toBe('contradicted');
    expect(report.repair.status).toBe('applied');
    expect(report.after?.status).toBe('completed');
    expect(report.after?.finding?.verdict).toBe('supported');
    expect(report.verification).toMatchObject({
      unchangedWorkload: true,
      independentWorkBefore: true,
      independentWorkAfter: true,
      preCutWorkPreserved: true,
      closedGap: true,
      contentCanaryAbsent: true,
    });
    expect(report.beforeSources['server.mjs']).toBe(report.afterSources?.['server.mjs']);
    expect(report.before.events.some((event) => event.tool === 'run_experiment')).toBe(true);
    expect(report.before.finding?.statement).toContain('authored loopback workflow');
    expect(report.before.provider.mode).toBe('scripted');
    expect(JSON.stringify(report)).not.toContain(CANCELLATION_CONTENT_CANARY);
    expect(verifyCancellationCase(JSON.parse(JSON.stringify(report)))).toEqual(report);
  });

  it('conforms the actual new tools/final schema to the strict Meta protocol offline', () => {
    for (const tool of CANCELLATION_TOOLS)
      expect(() => assertStrictMetaSchema(tool.parameters)).not.toThrow();
    expect(() =>
      assertStrictMetaSchema(cancellationJsonSchema(cancellationFindingSchema)),
    ).not.toThrow();
  });

  it('scores concealed authored arrangements honestly and preserves uncertainty/positive controls', async () => {
    const trials = await evaluateCancellation({ maxCases: 4 });
    expect(trials.mode).toBe('scripted-engineering-regression');
    expect(trials.totals).toMatchObject({ executed: 4, correct: 4, unsupportedConclusions: 0 });
    expect(trials.cases.map((trial) => trial.report.before.finding?.verdict)).toEqual([
      'contradicted',
      'supported',
      'insufficient_evidence',
      'contradicted',
    ]);
    expect(trials.cases[2]?.report.change).toBeNull();
    expect(trials.cases[2]?.report.repair.status).toBe('pending-evidence');
    expect(trials.cases[3]?.report.change).toBeNull();
    expect(trials.cases[3]?.report.repair.status).toBe('not-supported');
    const directory = await mkdtemp(join(tmpdir(), 'investigator-cancel-trials-'));
    try {
      await writeCancellationTrials(join(directory, 'trials'), trials);
      expect(
        verifyCancellationTrials(
          JSON.parse(await readFile(join(directory, 'trials/trials.json'), 'utf8')),
        ),
      ).toEqual(trials);
      await expect(
        writeCancellationTrials(join(directory, 'trials'), trials),
      ).rejects.toMatchObject({ code: 'OUTPUT_UNAVAILABLE' });
      const corrupt = structuredClone(trials);
      corrupt.totals.correct = 0;
      expect(() => verifyCancellationTrials(corrupt)).toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);

  it('does not send unselected evidence or operator labels to the provider and preserves caller snapshots', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'investigator-cancel-scope-'));
    try {
      await prepareCancellationService(directory, 'cached-worker');
      const client = createCancellationClient(await cancellationServiceSources(directory));
      const secret = 'synthetic-private-artifact-never-selected';
      client.evidence.add(cancellationArtifact('private-data', secret, new Date().toISOString()));
      const initialCount = client.evidence.all().length;
      for (let repeat = 0; repeat < 2; repeat += 1) {
        const base = new ScriptedCancellationProvider();
        const sent: string[] = [];
        let first = true;
        const provider: ModelProvider = {
          id: 'inspected-reference',
          model: base.model,
          mode: 'scripted',
          complete: async (request) => {
            sent.push(JSON.stringify(request));
            const completion = await base.complete(request);
            if (first) {
              first = false;
              return {
                ...completion,
                toolCalls: [
                  ...completion.toolCalls,
                  {
                    id: 'denied-read',
                    name: 'read_evidence',
                    arguments: {
                      evidenceId: 'private-data',
                      locator: { kind: 'lines', start: 1, end: 1 },
                    },
                  },
                ],
              };
            }
            return completion;
          },
        };
        const run = await investigateCancellation({
          ...client,
          subjectRevision: await cancellationServiceRevision(directory),
          provider,
          runExperiment: (experimentId, signal) =>
            runCancellationExperiment({ directory, experimentId, signal }),
        });
        expect(run.status).toBe('completed');
        expect(run.events.some((event) => event.error?.code === 'SOURCE_ACCESS_DENIED')).toBe(true);
        expect(run.evidence.some((artifact) => artifact.id === 'private-data')).toBe(false);
        expect(sent.join('')).not.toContain(secret);
        expect(sent.join('')).not.toMatch(
          /cached-worker|current-worker|capture-gap|block-all|operatorMode|expectedVerdict/,
        );
        expect(client.evidence.all()).toHaveLength(initialCount);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);

  it('abstains on ungrounded guesses and bounds a nonsettling experiment callback', async () => {
    const client = createCancellationClient(report.beforeSources);
    const guessed = { ...report.after!.proposedFinding!, citations: [] };
    const guesser: ModelProvider = {
      id: 'guess',
      model: 'mock',
      mode: 'scripted',
      complete: async () => ({ text: JSON.stringify(guessed), state: [], toolCalls: [] }),
    };
    const guessedRun = await investigateCancellation({
      ...client,
      subjectRevision: report.before.subjectRevision,
      provider: guesser,
      runExperiment: async () => {
        throw new Error('Unexpected execution');
      },
    });
    expect(guessedRun.finding).toBeNull();
    expect(guessedRun.status).toBe('incomplete');
    const never: ModelProvider = {
      id: 'never',
      model: 'mock',
      mode: 'scripted',
      complete: async () => ({
        text: '',
        state: [],
        toolCalls: [
          {
            id: 'probe',
            name: 'run_experiment',
            arguments: { experimentId: 'queued-after-revoke' },
          },
        ],
      }),
    };
    const started = Date.now();
    const run = await investigateCancellation({
      ...client,
      subjectRevision: report.before.subjectRevision,
      provider: never,
      maxDurationMs: 10,
      runExperiment: () => new Promise(() => {}),
    });
    expect(run.status).toBe('incomplete');
    expect(run.error?.code).toBe('RUN_ABORTED');
    expect(Date.now() - started).toBeLessThan(3000);
    expect(client.evidence.all()).toHaveLength(4);
  });

  it('requires the entire observed proof set and consistent source/status/repair records', () => {
    const metadataOnly = structuredClone(report.before);
    metadataOnly.proposedFinding!.citations = metadataOnly.proposedFinding!.citations.filter(
      (citation) =>
        !citation.evidenceId.startsWith('revocation-probe:') ||
        (citation.locator.kind === 'json-pointer' && citation.locator.pointer === '/cut'),
    );
    const { digest: _old, ...body } = metadataOnly;
    metadataOnly.digest = jsonDigest(body as unknown as JsonValue);
    expect(() => verifyCancellationInvestigation(metadataOnly)).toThrow();
    const status = structuredClone(report.before);
    status.status = 'failed';
    const { digest: _statusDigest, ...statusBody } = status;
    status.digest = jsonDigest(statusBody as unknown as JsonValue);
    expect(() => verifyCancellationInvestigation(status)).toThrow();
    const revision = structuredClone(report);
    revision.beforeSources['server.mjs'] += '\n// changed';
    expect(() => verifyCancellationCase(revision)).toThrow();
    const closed = structuredClone(report);
    closed.verification.closedGap = false;
    expect(() => verifyCancellationCase(closed)).toThrow();
  });

  it('does not claim a closed gap when the after model fails grounding despite passing captured effects', async () => {
    let phase = 0;
    const incomplete = await runCancellationWorkflow({
      providerFactory: () => {
        phase += 1;
        const base = new ScriptedCancellationProvider();
        const rejectFinal = phase === 2;
        return {
          id: 'grounding-regression',
          model: base.model,
          mode: 'scripted',
          complete: async (request) => {
            const completion = await base.complete(request);
            return rejectFinal && !completion.toolCalls.length
              ? {
                  ...completion,
                  text: JSON.stringify({ ...JSON.parse(completion.text), citations: [] }),
                }
              : completion;
          },
        };
      },
    });
    expect(incomplete.repair.status).toBe('applied');
    expect(incomplete.after?.status).toBe('incomplete');
    expect(incomplete.after?.finding).toBeNull();
    expect(incomplete.verification.afterVerdict).toBe('supported');
    expect(incomplete.verification.unchangedWorkload).toBe(true);
    expect(incomplete.verification.closedGap).toBe(false);
    expect(verifyCancellationCase(incomplete)).toEqual(incomplete);
  }, 30_000);

  it('retains an eligible before case when cancellation prevents repair execution', async () => {
    const control = new AbortController();
    const actual = cancellationRuntime.runCancellationExperiment;
    const spy = vi
      .spyOn(cancellationRuntime, 'runCancellationExperiment')
      .mockImplementation(async (options) => {
        const capture = await actual(options);
        if (options.experimentId === 'accepted-before-revoke') control.abort();
        return capture;
      });
    try {
      const cancelled = await runCancellationWorkflow({
        signal: control.signal,
        providerFactory: () => partialReferenceProvider('queued-after-revoke'),
      });
      expect(cancelled.before.status).toBe('completed');
      expect(cancelled.before.finding?.verdict).toBe('contradicted');
      expect(cancelled.baseline).toHaveLength(4);
      expect(cancelled.execution.cancelled).toBe(true);
      expect(cancelled.repair.status).toBe('cancelled');
      expect(cancelled.change).toBeNull();
      expect(cancelled.verification.closedGap).toBe(false);
      expect(verifyCancellationCase(cancelled)).toEqual(cancelled);
    } finally {
      spy.mockRestore();
    }
  }, 30_000);

  it('retains before evidence and bounded public errors when host completion or source repair fails', async () => {
    const actual = cancellationRuntime.runCancellationExperiment;
    const completion = vi
      .spyOn(cancellationRuntime, 'runCancellationExperiment')
      .mockImplementation(async (options) => {
        if (options.experimentId === 'retry-after-revoke')
          throw new Error('private-completion-secret');
        return actual(options);
      });
    try {
      const partial = await runCancellationWorkflow({
        providerFactory: () => partialReferenceProvider('queued-after-revoke'),
      });
      expect(partial.before.finding?.verdict).toBe('contradicted');
      expect(partial.baseline).toHaveLength(1);
      expect(partial.execution.baselineErrors).toMatchObject([
        { experimentId: 'retry-after-revoke', code: 'UNEXPECTED_ERROR' },
      ]);
      expect(partial.repair.status).toBe('pending-evidence');
      expect(partial.change).toBeNull();
      expect(JSON.stringify(partial)).not.toContain('private-completion-secret');
      expect(verifyCancellationCase(partial)).toEqual(partial);
    } finally {
      completion.mockRestore();
    }
    const repair = vi
      .spyOn(cancellationRecipe, 'applyCancellationRecipe')
      .mockRejectedValue(new Error('private-repair-secret'));
    try {
      const failed = await runCancellationWorkflow();
      expect(failed.before.finding?.verdict).toBe('contradicted');
      expect(failed.baseline).toHaveLength(4);
      expect(failed.execution.repairError?.code).toBe('UNEXPECTED_ERROR');
      expect(failed.repair.status).toBe('execution-failed');
      expect(failed.change).toBeNull();
      expect(failed.after).toBeNull();
      expect(failed.verification.closedGap).toBe(false);
      expect(JSON.stringify(failed)).not.toContain('private-repair-secret');
      expect(verifyCancellationCase(failed)).toEqual(failed);
    } finally {
      repair.mockRestore();
    }
  }, 30_000);

  it('binds host completion chronology and exact repair outcome metadata', async () => {
    let phase = 0;
    const completed = await runCancellationWorkflow({
      providerFactory: () =>
        ++phase === 1
          ? partialReferenceProvider('queued-after-revoke')
          : partialReferenceProvider('accepted-before-revoke'),
    });
    expect(completed.before.captures).toHaveLength(1);
    expect(completed.baseline).toHaveLength(4);
    expect(completed.after?.captures).toHaveLength(1);
    expect(completed.retest).toHaveLength(4);
    const moveToPast = (capture: CancellationCapture) => {
      capture.startedAt = '2020-01-01T00:00:00.000Z';
      capture.finishedAt = '2020-01-01T00:00:01.000Z';
      if (capture.cut) capture.cut.observedAt = '2020-01-01T00:00:00.500Z';
      capture.effects.forEach((effect) => {
        effect.observedAt = '2020-01-01T00:00:00.500Z';
      });
    };
    const baseline = structuredClone(completed);
    moveToPast(baseline.baseline.find((capture) => capture.experimentId === 'independent-root')!);
    const { digest: _baselineDigest, ...baselineBody } = baseline;
    baseline.digest = jsonDigest(baselineBody as unknown as JsonValue);
    expect(() => verifyCancellationCase(baseline)).toThrow(/host-completion capture/);
    const retest = structuredClone(completed);
    moveToPast(retest.retest.find((capture) => capture.experimentId === 'queued-after-revoke')!);
    const { digest: _retestDigest, ...retestBody } = retest;
    retest.digest = jsonDigest(retestBody as unknown as JsonValue);
    expect(() => verifyCancellationCase(retest)).toThrow(/host-completion capture/);
    const unrequested = createCancellationCase({
      before: report.before,
      baseline: report.baseline,
      beforeSources: report.beforeSources,
      change: null,
      after: null,
      retest: [],
      afterSources: null,
      repairRequested: false,
    });
    expect(unrequested.repair.status).toBe('not-requested');
    const forged = structuredClone(unrequested);
    forged.repair.reason = 'Invented repair outcome';
    const { digest: _forgedDigest, ...forgedBody } = forged;
    forged.digest = jsonDigest(forgedBody as unknown as JsonValue);
    expect(() => verifyCancellationCase(forged)).toThrow(/repair status/);
  }, 30_000);

  it('saves exclusive inspectable artifacts and exposes the standalone commands', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'investigator-cancel-cli-'));
    try {
      const destination = join(directory, 'case');
      await writeCancellationBundle(destination, report);
      await expect(writeCancellationBundle(destination, report)).rejects.toMatchObject({
        code: 'OUTPUT_UNAVAILABLE',
      });
      const { stdout, stderr, io } = output();
      expect(
        await runCli(['verify-cancellation', join(destination, 'case.json'), '--json'], {}, io),
      ).toBe(0);
      expect(JSON.parse(stdout.pop()!)).toMatchObject({
        authenticity: 'not-established',
        execution: 'not-reexecuted',
      });
      expect(await runCli(['cancellation-demo', '--live'], {}, io)).toBe(2);
      expect(stderr.join('')).toContain('MODEL_KEY_REQUIRED');
      const html = renderCancellationHtml(report);
      expect(html).toContain("default-src 'none'");
      expect(html).not.toContain('<script>');
      expect(html).not.toContain(CANCELLATION_CONTENT_CANARY);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe('show command', () => {
  it('presents a saved scripted case without upgrading its mode', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cancel-show-'));
    try {
      await writeCancellationBundle(join(dir, 'case'), report);
      const out: string[] = [];
      const io = { stdout: (t: string) => void out.push(t), stderr: () => undefined };
      expect(await runCli(['show', join(dir, 'case')], { FORCE_COLOR: '0' }, io)).toBe(0);
      const text = out.join('');
      expect(text).toContain(`mode: ${report.before.provider.mode}`);
      expect(text).toContain('records consistent');
      expect(text).toContain('Verdict BEFORE');
      expect(text.split('\n').length).toBeLessThanOrEqual(75);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
