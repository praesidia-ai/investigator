// Owner: WP-M. Public entry of the model layer.
import type { Config, ModelClient, ModelJsonRequest, ModelJsonResult } from '../contracts.js';
import { JuratorError } from '../util/errors.js';
import { LiveModelClient } from './live.js';
import { createMetaProvider, readMetaEnvironment } from './meta/meta-config.js';
import { ScriptedModelClient } from './scripted.js';

export { addUsage, formatUsd, priceFor, PRICES, totalUsd, usdFor } from './cost.js';
export { estimateCallUsd, LiveModelClient, ModelIncompleteError } from './live.js';
export { ScriptedModelClient, scriptedFileName } from './scripted.js';
export { describeIssues, toStrictJsonSchema } from './strict.js';
export { BUDGET_ERROR, budgetNeeded, budgetRetryLines, budgetStopLines, isBudgetStop, parseBudget, storeWithBudget, withBudget } from './budget.js';
export type { BudgetStop } from './budget.js';

export interface CreateModelOptions {
  readonly config: Config;
  readonly env: NodeJS.ProcessEnv;
  /** Directory of scripted answers (<task>.json files). When set, no network call is ever made. */
  readonly scriptedDir?: string | undefined;
  /** Base for a relative scriptedDir (defaults to process.cwd()). */
  readonly cwd?: string | undefined;
  /** Tests only: a fake transport. */
  readonly fetch?: typeof globalThis.fetch | undefined;
  /** Tests only: replaces the retry backoff wait. */
  readonly sleep?: ((ms: number) => Promise<void>) | undefined;
}

const KEY_REQUIRED = 'Set META_API_KEY to use AI steps, or pass --scripted <dir>, or use --no-ai.';

/** True when META_API_KEY or MODEL_API_KEY is set (never returns or prints the key). */
export function hasModelKey(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.META_API_KEY || env.MODEL_API_KEY);
}

/** The model id a live client would use: env MODEL_ID, else config.model.id. */
export function resolveModelId(config: Config, env: NodeJS.ProcessEnv): string {
  return readMetaEnvironment(env, { model: config.model.id }).model;
}

function scriptedDirOf(options: CreateModelOptions): string | undefined {
  return options.scriptedDir || options.env.JURATOR_SCRIPTED_DIR || undefined;
}

function live(options: CreateModelOptions): LiveModelClient {
  const provider = createMetaProvider(
    options.env,
    {
      model: options.config.model.id,
      ...(options.config.model.reasoningEffort ? { reasoningEffort: options.config.model.reasoningEffort } : {}),
    },
    { timeoutMs: 180_000, ...(options.fetch ? { fetch: options.fetch } : {}) },
  );
  return new LiveModelClient({
    provider,
    budgetUsd: options.config.budgetUsdPerRun,
    ...(options.sleep ? { sleep: options.sleep } : {}),
  });
}

/**
 * Scripted client when scriptedDir (or env JURATOR_SCRIPTED_DIR) is given: it never touches the network, even with a
 * key. Otherwise the live Meta client when META_API_KEY (or MODEL_API_KEY) is set. Otherwise throws
 * MODEL_KEY_REQUIRED. Nothing falls back silently.
 */
export function createModel(options: CreateModelOptions): ModelClient {
  const dir = scriptedDirOf(options);
  if (dir) return tapped(new ScriptedModelClient(dir, options.cwd ?? process.cwd()));
  if (!hasModelKey(options.env)) throw new JuratorError('MODEL_KEY_REQUIRED', KEY_REQUIRED);
  return tapped(live(options));
}

/* DS-C: `jurator discuss` runs commands in-process and meters what their model calls cost. Additive: with no tap
   registered, createModel returns the client untouched. */
type UsageTap = (usd: number, task: string) => void;
const usageTaps = new Set<UsageTap>();

/** Reports the USD of every model call made by clients created while the tap is registered. Returns its removal. */
export function tapModelUsage(fn: UsageTap): () => void {
  usageTaps.add(fn);
  return () => {
    usageTaps.delete(fn);
  };
}

function tapped<C extends ModelClient>(client: C): C {
  if (usageTaps.size === 0) return client;
  const taps = [...usageTaps];
  const inner = client.json.bind(client);
  const report = (usd: number, task: string): void => {
    for (const t of taps) t(usd, task);
  };
  (client as { json: ModelClient['json'] }).json = async <T>(request: ModelJsonRequest<T>): Promise<ModelJsonResult<T>> => {
    try {
      const result = await inner(request);
      report(result.usage?.usd ?? 0, request.task);
      return result;
    } catch (error) {
      const usd = (error as { usage?: { usd?: number } }).usage?.usd;
      if (typeof usd === 'number' && usd > 0) report(usd, request.task);
      throw error;
    }
  };
  return client;
}

/** Same as createModel but returns null instead of throwing when no key and no scriptedDir (for --no-ai paths). */
export function tryCreateModel(options: CreateModelOptions): ModelClient | null {
  if (!scriptedDirOf(options) && !hasModelKey(options.env)) return null;
  return createModel(options);
}
export { filesForModel, isSecretFile, maskFileForModel, maskSecrets, MASK } from './secrets.js';
export type { MaskResult } from './secrets.js';
