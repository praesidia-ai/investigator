// Owner: HZ-1. The client that writes summaries: Muse Spark, with its own small budget that never passes what the run
// has left. Scripted runs read recorded answers (explain__<promise-id>.json); a missing one falls back to the template.
import type { Config, ModelClient } from '../contracts.js';
import { createModel, hasModelKey } from '../model/index.js';
import { SUMMARY_CAP_USD, SUMMARY_MODEL } from './summary.js';

const on = (v: string | undefined): boolean => v !== undefined && v !== '' && v !== '0' && v.toLowerCase() !== 'false';

export interface SummaryModelInput {
  readonly config: Config;
  readonly env: NodeJS.ProcessEnv;
  readonly argv: readonly string[];
  /** --scripted <dir> of the command (recorded answers, no network). */
  readonly scriptedDir?: string | undefined;
  /** What the run has left of its budget (default: the whole run budget). */
  readonly budgetLeftUsd?: number | undefined;
  /** Tests: the model factory. */
  readonly create?: ((o: { config: Config; env: NodeJS.ProcessEnv; scriptedDir?: string }) => ModelClient) | undefined;
}

export interface SummaryModel {
  readonly model: ModelClient | null;
  /** Why there is no model, for the label ("--no-ai", "no model key", "the run budget is used up"). */
  readonly offReason?: string;
}

/** True when the command asked for no AI summaries (--no-ai, --no-ai-summary, JURATOR_NO_AI_SUMMARY=1). */
export function summariesOff(argv: readonly string[], env: NodeJS.ProcessEnv): string | null {
  if (argv.includes('--no-ai')) return '--no-ai';
  if (argv.includes('--no-ai-summary')) return '--no-ai-summary';
  if (on(env.JURATOR_NO_AI_SUMMARY)) return 'JURATOR_NO_AI_SUMMARY';
  return null;
}

export function summaryModel(input: SummaryModelInput): SummaryModel {
  const off = summariesOff(input.argv, input.env);
  if (off) return { model: null, offReason: off };
  const create = input.create ?? createModel;
  const scripted = input.scriptedDir || input.env.JURATOR_SCRIPTED_DIR;
  if (scripted) return { model: create({ config: input.config, env: input.env, scriptedDir: scripted }) };
  if (!hasModelKey(input.env)) return { model: null, offReason: 'no model key' };
  const left = input.budgetLeftUsd ?? input.config.budgetUsdPerRun;
  const budget = Math.min(SUMMARY_CAP_USD, left);
  if (!(budget >= 0.01)) return { model: null, offReason: 'the run budget is used up' };
  const config: Config = { ...input.config, model: { id: SUMMARY_MODEL, reasoningEffort: 'low' }, budgetUsdPerRun: budget };
  // env MODEL_ID / MODEL_REASONING_EFFORT would override the config, so this client sets its own.
  return { model: create({ config, env: { ...input.env, MODEL_ID: SUMMARY_MODEL, MODEL_REASONING_EFFORT: 'low' } }) };
}
