import { describe, expect, it } from 'vitest';
import { investigate } from '../src/core/coordinator.js';
import { EvidenceStore } from '../src/core/evidence-store.js';
import { ScriptedReferenceProvider } from '../src/providers/scripted-reference.js';
import type {
  ModelProvider,
  ModelCompletion,
  ModelRequest,
} from '../src/providers/model-provider.js';
import { jsonDigest } from '../src/core/json.js';
import { referenceCase } from './helpers.js';

function provider(complete: ModelProvider['complete']): ModelProvider {
  return { id: 'test-provider', model: 'test-model', mode: 'scripted', complete };
}
function final(text: unknown): ModelCompletion {
  return { text: JSON.stringify(text), toolCalls: [], state: [] };
}
function unresolved(): ModelCompletion {
  return final({
    verdict: 'insufficient_evidence',
    statement: 'Further evidence is required.',
    citations: [],
    missingEvidence: ['Observe all required controls.'],
  });
}

describe('bounded investigation and skeptical review', () => {
  it.each([
    ['request-unbound', 'contradicted', 'completed'],
    ['request-bound', 'supported', 'completed'],
    ['block-all', 'contradicted', 'completed'],
    ['false-refusal', 'contradicted', 'completed'],
    ['unavailable', 'insufficient_evidence', 'incomplete'],
  ] as const)(
    'assesses %s without equating run completion with control success',
    async (variant, verdict, status) => {
      const run = await investigate({
        ...(await referenceCase(variant)),
        provider: new ScriptedReferenceProvider(),
      });
      expect(run.status).toBe(status);
      expect(run.finding?.verdict).toBe(verdict);
      expect(run.provider.mode).toBe('scripted');
      expect(
        run.events.filter((event) => event.kind === 'assessment').map((event) => event.role),
      ).toEqual(['investigator', 'skeptic']);
      expect(run.usage.inputTokens).toBeNull();
      expect(run.limitations).toContain(
        'Scripted reference orchestration; no live model was called.',
      );
    },
  );

  it('cannot turn incomplete capture into a supported result', async () => {
    const bundle = await referenceCase('request-bound');
    const artifacts = bundle.evidence
      .all()
      .map((artifact) => ({ ...artifact, coverage: 'partial' as const }));
    const run = await investigate({
      ...bundle,
      evidence: new EvidenceStore(artifacts),
      provider: new ScriptedReferenceProvider(),
    });
    expect(run.status).toBe('incomplete');
    expect(run.finding?.missingEvidence).toContain(
      'Mandatory checks or declared evidence coverage are incomplete.',
    );
  });

  it('rejects a model-invented quote', async () => {
    const run = await investigate({
      ...(await referenceCase()),
      provider: provider(async () =>
        final({
          verdict: 'contradicted',
          statement: 'Gap',
          citations: [
            {
              evidenceId: 'policy',
              locator: { kind: 'lines', start: 1, end: 1 },
              quote: 'Invented evidence',
            },
          ],
          missingEvidence: [],
        }),
      ),
    });
    expect(run.status).toBe('failed');
    expect(run.finding).toBeNull();
    expect(run.error?.code).toBe('CITATION_MISMATCH');
  });

  it('demotes a supported assertion that never ran mandatory checks', async () => {
    const bundle = await referenceCase();
    const quote = bundle.evidence.get('policy').content.split('\n')[0]!;
    const run = await investigate({
      ...bundle,
      provider: provider(async () =>
        final({
          verdict: 'supported',
          statement: 'Claim supported',
          citations: [
            { evidenceId: 'policy', locator: { kind: 'lines', start: 1, end: 1 }, quote },
          ],
          missingEvidence: [],
        }),
      ),
    });
    expect(run.status).toBe('incomplete');
    expect(run.finding?.verdict).toBe('insufficient_evidence');
    expect(run.checks).toHaveLength(0);
  });

  it('does not accept a reference failure allegation supported only by a policy quotation', async () => {
    const bundle = await referenceCase();
    const quote = bundle.evidence.get('policy').content.split('\n')[0]!;
    const run = await investigate({
      ...bundle,
      provider: provider(async () =>
        final({
          verdict: 'contradicted',
          statement: 'Alleged failure without a check',
          citations: [
            { evidenceId: 'policy', locator: { kind: 'lines', start: 1, end: 1 }, quote },
          ],
          missingEvidence: [],
        }),
      ),
    });
    expect(run.status).toBe('incomplete');
    expect(run.finding?.verdict).toBe('insufficient_evidence');
    expect(run.checks).toHaveLength(0);
  });

  it('ends a loop at its model budget without a successful finding', async () => {
    let call = 0;
    const run = await investigate({
      ...(await referenceCase()),
      budget: { maxModelTurns: 2 },
      provider: provider(async () => ({
        text: '',
        state: [],
        toolCalls: [{ id: `call-${++call}`, name: 'get_control', arguments: {} }],
      })),
    });
    expect(run.status).toBe('incomplete');
    expect(run.finding).toBeNull();
    expect(run.error?.code).toBe('MODEL_BUDGET_EXHAUSTED');
    // The second turn is reserved for review, rather than spent in this loop.
    expect(run.events).toHaveLength(1);
  });

  it('rejects repeated call identifiers and enforces the tool budget before another effect', async () => {
    const repeating = provider(async () => ({
      text: '',
      state: [],
      toolCalls: [{ id: 'same-call', name: 'get_control', arguments: {} }],
    }));
    const duplicate = await investigate({ ...(await referenceCase()), provider: repeating });
    expect(duplicate.error?.code).toBe('INVALID_TOOL_CALL');
    const bounded = await investigate({
      ...(await referenceCase()),
      provider: repeating,
      budget: { maxToolCalls: 1 },
    });
    expect(bounded.error?.code).toBe('TOOL_BUDGET_EXHAUSTED');
    expect(bounded.status).toBe('incomplete');
  });

  it('stops a provider that ignores cancellation', async () => {
    const run = await investigate({
      ...(await referenceCase()),
      budget: { maxDurationMs: 10 },
      provider: provider(() => new Promise(() => {})),
    });
    expect(run.status).toBe('incomplete');
    expect(run.error?.code).toBe('RUN_ABORTED');
  });

  it('does not silently use the reference script after a provider failure', async () => {
    const run = await investigate({
      ...(await referenceCase()),
      provider: provider(async () => {
        throw new Error('provider secret payload');
      }),
    });
    expect(run.status).toBe('failed');
    expect(run.finding).toBeNull();
    expect(JSON.stringify(run)).not.toContain('provider secret payload');
    expect(run.checks).toHaveLength(0);
  });

  it('uses a strict final schema and a target-blind validated handoff for skeptical review', async () => {
    const requests: ModelRequest[] = [];
    const script = new ScriptedReferenceProvider();
    const run = await investigate({
      ...(await referenceCase()),
      provider: provider(async (input) => {
        requests.push(input);
        return script.complete(input);
      }),
    });
    expect(run.error).toBeNull();
    expect(requests.every((entry) => entry.outputFormat?.name === 'investigator_finding_v1')).toBe(
      true,
    );
    expect(
      requests.every(
        (entry) => entry.maxOutputTokens === 4096 && entry.reasoningEffort === 'medium',
      ),
    ).toBe(true);
    const schema = requests[0]!.outputFormat!.schema;
    expect(schema).toMatchObject({ type: 'object', additionalProperties: false });
    expect(JSON.stringify(schema)).not.toContain('oneOf');
    const skeptical = requests.find(
      (entry) => entry.instructions.includes('the skeptic') && !entry.state,
    )!;
    expect(skeptical.input[0]?.type).toBe('message');
    const initial = skeptical.input[0];
    if (initial?.type !== 'message') throw new Error('Expected a skeptical handoff.');
    const handoff = JSON.parse(initial.content) as {
      case: Record<string, unknown>;
      observations: { checks: unknown[]; evidence: Record<string, unknown>[] };
    };
    expect(handoff.case).toHaveProperty('hasTestTarget', true);
    expect(handoff.case).not.toHaveProperty('referenceTarget');
    expect(handoff.case).not.toHaveProperty('controlledTarget');
    expect(handoff.observations.checks).toHaveLength(3);
    expect(
      handoff.observations.evidence.every((entry) => !('source' in entry) && !('content' in entry)),
    ).toBe(true);
    expect(initial.content).not.toContain('request-unbound');
  });

  it('preserves completed usage as a lower bound after a later transport failure', async () => {
    let turns = 0;
    const run = await investigate({
      ...(await referenceCase()),
      provider: provider(async () => {
        if (++turns > 1) throw new Error('private-model-key-and-upstream-text');
        return {
          text: '',
          state: [],
          toolCalls: [{ id: 'known-call', name: 'get_control', arguments: {} }],
          usage: { inputTokens: 100, outputTokens: 24 },
        };
      }),
    });
    expect(run.status).toBe('failed');
    expect(run.usage).toEqual({
      inputTokens: null,
      outputTokens: null,
      knownInputTokens: 100,
      knownOutputTokens: 24,
      complete: false,
    });
    expect(run.events[0]).toMatchObject({
      inputDigest: jsonDigest({}),
      startedAt: expect.any(String),
      finishedAt: expect.any(String),
    });
    expect(run.events[0]).not.toHaveProperty('arguments');
    expect(JSON.stringify(run)).not.toContain('private-model-key-and-upstream-text');
  });

  it('enforces aggregate output allowance before another generation', async () => {
    const caps: number[] = [];
    const run = await investigate({
      ...(await referenceCase()),
      budget: { maxOutputTokens: 64, maxOutputTokensPerCall: 32 },
      provider: provider(async (input) => {
        caps.push(input.maxOutputTokens!);
        return {
          text: '',
          state: [],
          toolCalls: [{ id: 'cap-' + caps.length, name: 'get_control', arguments: {} }],
          usage: { inputTokens: 10, outputTokens: 32 },
        };
      }),
    });
    expect(caps).toEqual([32, 32]);
    expect(run.status).toBe('incomplete');
    expect(run.error?.code).toBe('OUTPUT_TOKEN_BUDGET_EXHAUSTED');
    expect(run.usage).toEqual({
      inputTokens: 20,
      outputTokens: 64,
      knownInputTokens: 20,
      knownOutputTokens: 64,
      complete: true,
    });
  });

  it('reserves unknown token usage rather than treating it as zero-cost generation', async () => {
    let calls = 0;
    const run = await investigate({
      ...(await referenceCase()),
      budget: { maxOutputTokens: 32, maxOutputTokensPerCall: 32 },
      provider: provider(async () => ({
        text: '',
        state: [],
        toolCalls: [{ id: 'unknown-' + ++calls, name: 'get_control', arguments: {} }],
      })),
    });
    expect(calls).toBe(1);
    expect(run.error?.code).toBe('OUTPUT_TOKEN_BUDGET_EXHAUSTED');
    expect(run.usage).toMatchObject({ outputTokens: null, knownOutputTokens: 0, complete: false });
  });

  it('keeps three model turns available for the skeptic after five investigator turns', async () => {
    const turns = { investigator: 0, skeptic: 0 };
    const run = await investigate({
      ...(await referenceCase()),
      provider: provider(async (input) => {
        const role = input.instructions.includes('the skeptic') ? 'skeptic' : 'investigator';
        turns[role] += 1;
        const finalTurn = role === 'investigator' ? 5 : 3;
        return turns[role] === finalTurn
          ? unresolved()
          : {
              text: '',
              state: [],
              toolCalls: [{ id: role + '-' + turns[role], name: 'get_control', arguments: {} }],
            };
      }),
    });
    expect(turns).toEqual({ investigator: 5, skeptic: 3 });
    expect(run.error).toBeNull();
    expect(
      run.events.filter((entry) => entry.kind === 'assessment').map((entry) => entry.role),
    ).toEqual(['investigator', 'skeptic']);
  });

  it('keeps two tool calls available for the skeptic after ten investigator tool calls', async () => {
    const turns = { investigator: 0, skeptic: 0 };
    const run = await investigate({
      ...(await referenceCase()),
      provider: provider(async (input) => {
        const role = input.instructions.includes('the skeptic') ? 'skeptic' : 'investigator';
        turns[role] += 1;
        return turns[role] > 1
          ? unresolved()
          : {
              text: '',
              state: [],
              toolCalls: Array.from({ length: role === 'investigator' ? 10 : 2 }, (_, index) => ({
                id: role + '-tool-' + index,
                name: 'get_control',
                arguments: {},
              })),
            };
      }),
    });
    expect(run.error).toBeNull();
    expect(
      run.events.filter((entry) => entry.kind === 'tool-result' && entry.role === 'investigator'),
    ).toHaveLength(10);
    expect(
      run.events.filter((entry) => entry.kind === 'tool-result' && entry.role === 'skeptic'),
    ).toHaveLength(2);
  });

  it.each(['output_limit', 'refused'] as const)(
    'keeps %s completion out of assessed findings while preserving usage',
    async (finishReason) => {
      const run = await investigate({
        ...(await referenceCase()),
        provider: provider(async () => ({
          text: 'untrusted partial text',
          toolCalls: [],
          state: [],
          finishReason,
          usage: { inputTokens: 12, outputTokens: 20 },
        })),
      });
      expect(run.status).toBe('incomplete');
      expect(run.finding).toBeNull();
      expect(run.usage).toMatchObject({
        knownInputTokens: 12,
        knownOutputTokens: 20,
        complete: true,
      });
      expect(JSON.stringify(run)).not.toContain('untrusted partial text');
    },
  );

  it('validates budgets before provider access', async () => {
    await expect(
      investigate({
        ...(await referenceCase()),
        provider: new ScriptedReferenceProvider(),
        budget: { maxModelTurns: 0 },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_BUDGET' });
  });
});
