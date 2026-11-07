// Owner: WP-M. Model prices and the USD math for ModelUsage.usd.
import type { ModelUsage } from '../contracts.js';

export interface ModelPrice {
  /** USD per million fresh input tokens. */
  readonly input: number;
  /** USD per million cached input tokens. */
  readonly cachedInput: number;
  /** USD per million output tokens (reasoning tokens are billed as output). */
  readonly output: number;
}

export const PRICES: Readonly<Record<string, ModelPrice>> = {
  'muse-wonder-1.0': { input: 4, cachedInput: 0.2, output: 20 },
  'muse-spark-1.3': { input: 1.25, cachedInput: 0.15, output: 4.25 },
};

/** Unknown models are priced like Muse Wonder (the dearer one), so cost is never under-reported. */
export function priceFor(modelId: string): ModelPrice & { readonly known: boolean } {
  const price = PRICES[modelId];
  return price ? { ...price, known: true } : { ...(PRICES['muse-wonder-1.0'] as ModelPrice), known: false };
}

export interface TokenCounts {
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Part of inputTokens served from cache. */
  readonly cachedInputTokens?: number;
}

/** USD for one call, rounded to a millionth of a dollar. */
export function usdFor(modelId: string, tokens: TokenCounts): number {
  const price = priceFor(modelId);
  const cached = Math.min(Math.max(tokens.cachedInputTokens ?? 0, 0), tokens.inputTokens);
  const fresh = tokens.inputTokens - cached;
  const usd = (fresh * price.input + cached * price.cachedInput + tokens.outputTokens * price.output) / 1_000_000;
  return Math.round(usd * 1_000_000) / 1_000_000;
}

/** The usage record of one live call; a missing token count (provider gave none) counts as zero. */
export function liveUsage(modelId: string, usage: TokenCounts | undefined): ModelUsage {
  const tokens = usage ?? { inputTokens: 0, outputTokens: 0 };
  return { id: modelId, mode: 'live', inputTokens: tokens.inputTokens, outputTokens: tokens.outputTokens, usd: usdFor(modelId, tokens) };
}

/** Adds usages of the same client (e.g. a retry). Mode and id come from the first one. */
export function addUsage(a: ModelUsage, b: ModelUsage): ModelUsage {
  return {
    id: a.id,
    mode: a.mode,
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    usd: Math.round((a.usd + b.usd) * 1_000_000) / 1_000_000,
  };
}

/** Total USD of many usages (for CheckRun.costUsd and command footers). */
export function totalUsd(usages: readonly ModelUsage[]): number {
  return Math.round(usages.reduce((sum, u) => sum + u.usd, 0) * 1_000_000) / 1_000_000;
}

/** "$0.0123" style, for the user. */
export function formatUsd(usd: number): string {
  if (usd === 0) return '$0';
  if (usd < 0.0001) return '<$0.0001';
  return `$${usd.toFixed(usd < 1 ? 4 : 2)}`;
}
