import { describe, expect, it } from 'vitest';
import { addUsage, formatUsd, priceFor, totalUsd, usdFor } from '../../src/model/cost.js';

describe('usd math', () => {
  it('prices Muse Wonder at $4/M in and $20/M out', () => {
    expect(usdFor('muse-wonder-1.0', { inputTokens: 1_000_000, outputTokens: 0 })).toBe(4);
    expect(usdFor('muse-wonder-1.0', { inputTokens: 0, outputTokens: 1_000_000 })).toBe(20);
    expect(usdFor('muse-wonder-1.0', { inputTokens: 1000, outputTokens: 100 })).toBe(0.006);
  });
  it('prices Muse Spark at $1.25/M in and $4.25/M out', () => {
    expect(usdFor('muse-spark-1.3', { inputTokens: 1_000_000, outputTokens: 1_000_000 })).toBe(5.5);
    expect(usdFor('muse-spark-1.3', { inputTokens: 2000, outputTokens: 400 })).toBe(0.0042);
  });
  it('prices cached input separately', () => {
    // 1M input of which 800k cached: 200k * $4/M + 800k * $0.20/M = 0.8 + 0.16
    expect(usdFor('muse-wonder-1.0', { inputTokens: 1_000_000, outputTokens: 0, cachedInputTokens: 800_000 })).toBe(
      0.96,
    );
    // Spark: 100k fresh * 1.25 + 900k cached * 0.15 = 0.125 + 0.135
    expect(usdFor('muse-spark-1.3', { inputTokens: 1_000_000, outputTokens: 0, cachedInputTokens: 900_000 })).toBe(
      0.26,
    );
    // Cached never exceeds input.
    expect(usdFor('muse-wonder-1.0', { inputTokens: 10, outputTokens: 0, cachedInputTokens: 99 })).toBe(0.000002);
  });
  it('prices unknown models like Wonder (never under-reports)', () => {
    expect(priceFor('muse-future-9').known).toBe(false);
    expect(usdFor('muse-future-9', { inputTokens: 1_000_000, outputTokens: 0 })).toBe(4);
  });
  it('adds and formats', () => {
    const a = { id: 'm', mode: 'live' as const, inputTokens: 1, outputTokens: 2, usd: 0.1 };
    const b = { id: 'm', mode: 'live' as const, inputTokens: 3, outputTokens: 4, usd: 0.2 };
    expect(addUsage(a, b)).toEqual({ id: 'm', mode: 'live', inputTokens: 4, outputTokens: 6, usd: 0.3 });
    expect(totalUsd([a, b, a])).toBe(0.4);
    expect(formatUsd(0)).toBe('$0');
    expect(formatUsd(0.00612)).toBe('$0.0061');
    expect(formatUsd(1.5)).toBe('$1.50');
  });
});
