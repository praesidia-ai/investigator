import { afterEach, describe, expect, it, vi } from 'vitest';
import { evaluateInvestigator } from '../src/evaluation/evaluate.js';
import type {
  ModelCompletion,
  ModelProvider,
  ModelRequest,
} from '../src/providers/model-provider.js';
import { ScriptedReferenceProvider } from '../src/providers/scripted-reference.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

function insufficient(): ModelCompletion {
  return {
    text: JSON.stringify({
      verdict: 'insufficient_evidence',
      statement: 'The declared checks need review.',
      citations: [],
      missingEvidence: ['Review the actual observations.'],
    }),
    toolCalls: [],
    state: [],
  };
}

describe('blind authored investigator evaluation', () => {
  it('runs twelve independent deterministic regressions without calling a model service', async () => {
    const fetch = vi.fn(() => {
      throw new Error('No network should be used by the default evaluation.');
    });
    vi.stubGlobal('fetch', fetch);
    const report = await evaluateInvestigator();
    expect(fetch).not.toHaveBeenCalled();
    expect(report.mode).toBe('deterministic-regression-not-model-quality');
    expect(report.cancelled).toBe(false);
    expect(report.cases.map((result) => result.id)).toEqual(
      Array.from({ length: 12 }, (_, index) => `case-${String(index + 1).padStart(2, '0')}`),
    );
    expect(report.totals).toMatchObject({
      cases: 12,
      passed: 12,
      failed: 0,
      abstentionCases: 4,
      correctAbstentions: 4,
      unnecessaryAbstentions: 0,
      citationsResolved: 12,
      citationCasesChecked: 12,
      usageComplete: false,
      inputTokens: null,
      outputTokens: null,
      monetaryCost: null,
    });
    expect(
      report.cases.every(
        (result) => result.metrics.requiredChecksMatch && result.metrics.permittedUtilityMatch,
      ),
    ).toBe(true);
    expect(report.cases[2]!.actual.permittedUtility).toBe('broken');
    expect(report.cases[4]!.actual.permittedUtility).toBe('unavailable');
    expect(report.cases[6]!.actual.verdict).toBe('supported');
    expect(report.cases[9]!.actual.verdict).toBe('contradicted');
    expect(report.limitations.join(' ')).toContain('do not measure model quality');
    expect(report.totals.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('does not claim injection robustness when the scripted provider never reads the appended instructions', async () => {
    const report = await evaluateInvestigator();
    expect(report.cases[7]!.metrics.adversarialEvidenceRead).toBe(false);
    expect(report.cases[11]!.metrics.adversarialEvidenceRead).toBe(false);
    expect(report.limitations.join(' ')).toContain('unless adversarialEvidenceRead is true');
  });

  it('keeps expected labels, fixture names and target variants out of every provider request', async () => {
    const requests: ModelRequest[] = [];
    const providerFactory = (): ModelProvider => ({
      id: 'blindness-test',
      model: 'local-test',
      mode: 'scripted',
      async complete(request) {
        requests.push(request);
        const role = request.instructions.includes('the skeptic') ? 'skeptic' : 'investigator';
        if (!request.state)
          return {
            text: '',
            state: [{ phase: 1 }],
            toolCalls: [{ id: `${role}-check`, name: 'run_control_checks', arguments: {} }],
          };
        const state = request.state[0];
        if (
          state !== null &&
          typeof state === 'object' &&
          !Array.isArray(state) &&
          state['phase'] === 1
        ) {
          return {
            text: '',
            state: [{ phase: 2 }],
            toolCalls: [{ id: `${role}-list`, name: 'list_evidence', arguments: {} }],
          };
        }
        return insufficient();
      },
    });
    const report = await evaluateInvestigator({ providerFactory, maxCases: 2 });
    expect(report.mode).toBe('deterministic-regression-not-model-quality');
    const context = JSON.stringify(requests);
    for (const answer of [
      'request-unbound',
      'request-bound',
      'block-all',
      'false-refusal',
      '"referenceTarget"',
      '"variant"',
      '"expected"',
    ]) {
      expect(context).not.toContain(answer);
    }
    expect(context).toContain('frozen-control-observations');
    expect(context).not.toContain(report.cases[0]!.scenario);
    expect(report.cases.map((result) => result.expected.verdict)).toEqual([
      'contradicted',
      'supported',
    ]);
  });

  it('creates a separate explicit provider for each selected case and preserves known live usage', async () => {
    const factory = vi.fn((): ModelProvider => {
      const delegate = new ScriptedReferenceProvider();
      return {
        id: 'mock-live-protocol',
        model: 'test-model',
        mode: 'live',
        async complete(request) {
          return {
            ...(await delegate.complete(request)),
            usage: { inputTokens: 10, outputTokens: 5 },
          };
        },
      };
    });
    const report = await evaluateInvestigator({ providerFactory: factory, maxCases: 2 });
    expect(factory).toHaveBeenCalledTimes(2);
    expect(report.mode).toBe('live-authored-fixture-evaluation');
    expect(report.totals).toMatchObject({
      cases: 2,
      passed: 2,
      usageComplete: true,
      knownInputTokens: 120,
      knownOutputTokens: 60,
      inputTokens: 120,
      outputTokens: 60,
      monetaryCost: null,
    });
    expect(report.limitations.join(' ')).toContain(
      'not representative market or production accuracy',
    );
  });

  it('records failed provider runs instead of substituting scripted results', async () => {
    const providerFactory = (): ModelProvider => ({
      id: 'failing-live-test',
      model: 'test-model',
      mode: 'live',
      complete: async () => {
        throw new Error('private provider failure payload');
      },
    });
    const report = await evaluateInvestigator({ providerFactory, maxCases: 1 });
    expect(report.totals).toMatchObject({ cases: 1, passed: 0, failed: 1, usageComplete: false });
    expect(report.cases[0]!.actual).toMatchObject({
      status: 'failed',
      verdict: null,
      permittedUtility: 'not-measured',
    });
    expect(report.cases[0]!.metrics.requiredChecksMatch).toBe(false);
    expect(JSON.stringify(report)).not.toContain('private provider failure payload');
  });

  it('classifies mixed provider modes explicitly instead of reporting a homogeneous live evaluation', async () => {
    let count = 0;
    const report = await evaluateInvestigator({
      maxCases: 2,
      providerFactory: () => {
        const delegate = new ScriptedReferenceProvider();
        return {
          id: 'mixed-protocol-test',
          model: 'test-model',
          mode: count++ === 0 ? 'live' : 'scripted',
          complete: (request) => delegate.complete(request),
        };
      },
    });
    expect(report.mode).toBe('mixed-provider-fixture-evaluation');
    expect(report.cases.map((result) => result.provider?.mode)).toEqual(['live', 'scripted']);
    expect(report.limitations.join(' ')).toContain('Provider modes were mixed');
  });

  it('does not expose mutable golden labels between separate evaluation runs', async () => {
    const first = await evaluateInvestigator({ maxCases: 1 });
    const mutable = first.cases[0]!.expected as unknown as {
      verdict: string;
      checkStatuses: string[];
    };
    mutable.verdict = 'supported';
    mutable.checkStatuses[1] = 'PASS';
    const second = await evaluateInvestigator({ maxCases: 1 });
    expect(second.cases[0]!.expected.verdict).toBe('contradicted');
    expect(second.cases[0]!.expected.checkStatuses).toEqual(['PASS', 'FAIL', 'PASS']);
    expect(second.totals.passed).toBe(1);
  });

  it.each([0, 13, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects invalid maximum %s before creating providers',
    async (maxCases) => {
      const factory = vi.fn(() => new ScriptedReferenceProvider());
      await expect(
        evaluateInvestigator({ maxCases, providerFactory: factory }),
      ).rejects.toMatchObject({ code: 'EVALUATION_OPTIONS_INVALID' });
      expect(factory).not.toHaveBeenCalled();
    },
  );

  it('does not start a pre-cancelled evaluation', async () => {
    const controller = new AbortController();
    controller.abort();
    const factory = vi.fn(() => new ScriptedReferenceProvider());
    const report = await evaluateInvestigator({
      signal: controller.signal,
      providerFactory: factory,
    });
    expect(report.cancelled).toBe(true);
    expect(report.cases).toEqual([]);
    expect(report.totals.cases).toBe(0);
    expect(factory).not.toHaveBeenCalled();
  });

  it('cancels a running provider and excludes unstarted cases from evaluated totals', async () => {
    const controller = new AbortController();
    const factory = vi.fn((): ModelProvider => ({
      id: 'noncooperative-test',
      model: 'test-model',
      mode: 'scripted',
      complete() {
        controller.abort();
        return new Promise<ModelCompletion>(() => {});
      },
    }));
    const report = await evaluateInvestigator({
      signal: controller.signal,
      providerFactory: factory,
    });
    expect(report.cancelled).toBe(true);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(report.totals).toMatchObject({ cases: 1, passed: 0, failed: 1 });
    expect(report.cases[0]!.error?.code).toBe('RUN_ABORTED');
    expect(report.limitations.join(' ')).toContain('unstarted cases are not counted');
  });
});
