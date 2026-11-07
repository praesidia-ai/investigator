// Owner: WP-M. Live ModelClient over the ported Meta Responses provider: strict JSON output, one retry, cost.
import type { ModelClient, ModelJsonRequest, ModelJsonResult, ModelUsage } from '../contracts.js';
import { JuratorError } from '../util/errors.js';
import { addUsage, formatUsd, liveUsage, priceFor } from './cost.js';
import type { ModelCompletion, ModelProvider } from './meta/model-provider.js';
import { describeIssues, stripOptionalNulls, toStrictJsonSchema } from './strict.js';
import { BRAND } from '../brand.js';

/** Errors worth one more try: rate limits, server errors and dropped connections. */
const RETRYABLE = new Set(['MODEL_RATE_LIMITED', 'MODEL_SERVER_ERROR', 'MODEL_REQUEST_FAILED']);

export interface LiveClientOptions {
  readonly provider: ModelProvider;
  /** Stop before a call once this much has been spent by this client (config.budgetUsdPerRun). */
  readonly budgetUsd?: number;
  /** Injected for tests; defaults to setTimeout. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Per-call time limit in ms (AbortSignal); the provider has its own limit too. */
  readonly timeoutMs?: number;
}

/** The output cap a call without maxOutputTokens gets from the provider (meta-config maxOutputTokensPerCall). */
const DEFAULT_OUTPUT_CAP = 4096;

/**
 * R5-B: the most one attempt of `request` can cost, reserved before it starts so calls running at the same time can
 * never pass the run budget together. Input is counted at 3 characters per token (code tokenizes densely; English is
 * about 4), all of it fresh; output at its full cap (reasoning is billed as output and counts toward the cap).
 */
export function estimateCallUsd(modelId: string, request: Pick<ModelJsonRequest<unknown>, 'instructions' | 'input' | 'maxOutputTokens'>): number {
  const price = priceFor(modelId);
  const inputTokens = Math.ceil((request.instructions.length + request.input.length) / 3) + 500; // + schema and framing
  const outputTokens = request.maxOutputTokens ?? DEFAULT_OUTPUT_CAP;
  return Math.round(((inputTokens * price.input + outputTokens * price.output) / 1_000_000) * 1_000_000) / 1_000_000;
}

/** Thrown when the model's answer is cut off or refused. Carries what the call cost. */
export class ModelIncompleteError extends JuratorError {
  readonly usage: ModelUsage;
  constructor(message: string, usage: ModelUsage) {
    super('MODEL_INCOMPLETE', message);
    this.usage = usage;
  }
}

function schemaNameFor(name: string): string {
  const clean = name.replace(/[^a-zA-Z0-9_-]+/gu, '_').slice(0, 64);
  return clean || 'answer';
}

export class LiveModelClient implements ModelClient {
  readonly id: string;
  readonly mode = 'live' as const;
  readonly #provider: ModelProvider;
  readonly #budgetUsd: number | undefined;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #timeoutMs: number;
  #spentUsd = 0;
  /** Reserved for calls in flight (their estimated cost), released when each attempt ends. */
  #reservedUsd = 0;
  /** Set by the first budget stop: after it, no new call starts (calls already running finish). */
  #stopped = false;
  readonly #usages: ModelUsage[] = [];

  constructor(options: LiveClientOptions) {
    this.#provider = options.provider;
    this.id = options.provider.model;
    this.#budgetUsd = options.budgetUsd;
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#timeoutMs = options.timeoutMs ?? 180_000;
  }

  /** USD spent by this client so far (all calls, retries included). */
  get spentUsd(): number {
    return Math.round(this.#spentUsd * 1_000_000) / 1_000_000;
  }
  /** USD reserved for calls running now. */
  get reservedUsd(): number {
    return Math.round(this.#reservedUsd * 1_000_000) / 1_000_000;
  }
  /** Every call's usage, in order (for run summaries). */
  get usages(): readonly ModelUsage[] {
    return this.#usages;
  }

  #usageOf(completion: Pick<ModelCompletion, 'usage'>): ModelUsage {
    const usage = liveUsage(this.id, completion.usage);
    this.#spentUsd += usage.usd;
    this.#usages.push(usage);
    return usage;
  }

  /** Throws the budget stop when the budget left (minus what calls in flight reserved) cannot cover `estimate`. */
  #reserve(task: string, estimate: number): void {
    const budget = this.#budgetUsd;
    if (budget === undefined) return;
    const left = budget - this.#spentUsd - this.#reservedUsd;
    if (!this.#stopped && estimate <= left + 1e-9) {
      this.#reservedUsd += estimate;
      return;
    }
    this.#stopped = true;
    const more = Math.max(0.01, estimate - Math.max(0, budget - this.#spentUsd));
    throw new JuratorError(
      'MODEL_BUDGET_EXCEEDED',
      `This run spent ${formatUsd(this.spentUsd)} of its ${formatUsd(budget)} budget` +
        `${this.#reservedUsd > 0 ? ` (${formatUsd(this.reservedUsd)} more held by calls still running)` : ''}; ` +
        `"${task}" could cost up to ${formatUsd(estimate)}, so no new call was started ` +
        `(about ${formatUsd(more)} more is needed for it). Pass --budget <usd> for more (or raise budgetUsdPerRun in ${BRAND.folder}/config.json).`,
    );
  }

  #release(estimate: number): void {
    if (this.#budgetUsd === undefined) return;
    this.#reservedUsd = Math.max(0, this.#reservedUsd - estimate);
  }

  async json<T>(request: ModelJsonRequest<T>): Promise<ModelJsonResult<T>> {
    const estimate = estimateCallUsd(this.id, request);
    this.#reserve(request.task, estimate);
    let held = true;
    try {
      return await this.#json(request, () => {
        // A retry is a second attempt: it needs its own reservation.
        if (held) this.#release(estimate);
        held = false;
        this.#reserve(request.task, estimate);
        held = true;
      });
    } finally {
      if (held) this.#release(estimate);
    }
  }

  async #json<T>(request: ModelJsonRequest<T>, again: () => void): Promise<ModelJsonResult<T>> {
    const strict = toStrictJsonSchema(request.schema, request.schemaName);
    const outputFormat = { name: schemaNameFor(request.schemaName), schema: strict.schema };
    let total: ModelUsage | undefined;
    let lastProblem = '';
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      if (attempt > 1) again();
      let completion: ModelCompletion;
      try {
        completion = await this.#provider.complete({
          instructions: request.instructions,
          input: [{ type: 'message', role: 'user', content: request.input }],
          tools: [],
          signal: AbortSignal.timeout(this.#timeoutMs),
          outputFormat,
          ...(request.maxOutputTokens !== undefined ? { maxOutputTokens: request.maxOutputTokens } : {}),
        });
      } catch (error) {
        if (attempt === 1 && error instanceof JuratorError && RETRYABLE.has(error.code)) {
          lastProblem = error.message;
          await this.#sleep(error.code === 'MODEL_RATE_LIMITED' ? 2_000 : 750);
          continue;
        }
        throw error;
      }
      const usage = this.#usageOf(completion);
      total = total ? addUsage(total, usage) : usage;
      if (completion.finishReason === 'output_limit') {
        throw new ModelIncompleteError(
          `The model's answer for "${request.task}" was cut off at its output limit` +
            `${request.maxOutputTokens ? ` (${request.maxOutputTokens} tokens)` : ''}; nothing was saved.`,
          total,
        );
      }
      if (completion.finishReason === 'refused') {
        throw new ModelIncompleteError(`The model refused to answer "${request.task}"; nothing was saved.`, total);
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(completion.text);
      } catch {
        lastProblem = 'the answer was not valid JSON';
        if (attempt === 1) {
          await this.#sleep(250);
          continue;
        }
        break;
      }
      const checked = request.schema.safeParse(stripOptionalNulls(parsed, strict));
      if (checked.success) return { value: checked.data, usage: total };
      lastProblem = `the answer did not match ${request.schemaName}: ${describeIssues(checked.error)}`;
      if (attempt === 1) await this.#sleep(250);
    }
    throw new JuratorError(
      'MODEL_OUTPUT_INVALID',
      `The model's answer for "${request.task}" was unusable after 2 tries (${lastProblem}); nothing was saved.`,
    );
  }
}
