import { describe, expect, it } from 'vitest';
import { evaluateCancellation, verifyCancellationTrials } from '../src/cancellation/evaluate.js';
import { jsonDigest, type JsonValue } from '../src/core/json.js';

describe('authored cancellation arrangement identity', () => {
  it('does not relabel complete observations as a missing-capture trial even with consistent scores', async () => {
    const trials = await evaluateCancellation({ maxCases: 3 });
    const gap = trials.cases[2]!;
    gap.report = structuredClone(trials.cases[0]!.report);
    gap.groundedConclusionCorrect = false;
    trials.totals.correct = 2;
    const { digest: _digest, ...body } = trials;
    trials.digest = jsonDigest(body as unknown as JsonValue);
    expect(() => verifyCancellationTrials(trials)).toThrow('arrangements');
  }, 30_000);
});
