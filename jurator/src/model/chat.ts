// Owner: DS-A (discuss). A tool-loop chat over the ported Meta Responses provider: function tools, several calls per
// model turn, tool results sent back, store:false (the provider replays its own encrypted state, nothing is kept
// upstream). Each call reserves its worst-case cost before it starts (like live.ts), so a session never passes its
// budget. The scripted chat replays recorded rounds (`<dir>/<turn>-<round>.json`) and never touches the network.
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import type { ModelUsage } from '../contracts.js';
import { JuratorError } from '../util/errors.js';
import { BUDGET_ERROR } from './budget.js';
import { formatUsd, priceFor, usdFor } from './cost.js';
import type { JsonValue } from './meta/json-types.js';
import { createMetaProvider } from './meta/meta-config.js';
import type { ModelInput, ModelProvider, ModelToolCall, ReasoningEffort, ToolDefinition } from './meta/model-provider.js';

export interface ChatRequest {
  readonly instructions: string;
  /** New items for this call: the user's message, or the results of the tools the last call asked for. */
  readonly input: readonly ModelInput[];
  readonly tools: readonly ToolDefinition[];
  /** The conversation so far (opaque provider items from the last completion). */
  readonly state: readonly JsonValue[];
  readonly signal: AbortSignal;
  readonly maxOutputTokens?: number;
  /** Where this call sits in the session (the scripted chat finds its answer by these). */
  readonly turn: number;
  readonly round: number;
}

export interface ChatCompletion {
  readonly text: string;
  readonly toolCalls: readonly ModelToolCall[];
  /** The conversation including this call's input and output; pass it back as `state` on the next call. */
  readonly state: readonly JsonValue[];
  readonly finishReason: 'completed' | 'output_limit' | 'refused';
  readonly usage: ModelUsage;
}

export interface ChatModel {
  readonly id: string;
  readonly mode: 'live' | 'scripted';
  complete(request: ChatRequest): Promise<ChatCompletion>;
}

/** A session's spending: shared by every chat model of the session (switching the model keeps the meter). */
export class ChatBudget {
  budgetUsd: number;
  #spentUsd = 0;
  #reservedUsd = 0;

  constructor(budgetUsd: number) {
    this.budgetUsd = budgetUsd;
  }
  get spentUsd(): number {
    return round6(this.#spentUsd);
  }
  get reservedUsd(): number {
    return round6(this.#reservedUsd);
  }
  /** Holds `estimate` for a call about to start; throws the budget stop (nothing is sent) when it does not fit. */
  reserve(estimate: number): void {
    const left = this.budgetUsd - this.#spentUsd - this.#reservedUsd;
    if (estimate <= left + 1e-9) {
      this.#reservedUsd += estimate;
      return;
    }
    const more = Math.max(0.01, estimate - Math.max(0, this.budgetUsd - this.#spentUsd));
    throw new JuratorError(
      BUDGET_ERROR,
      `This session spent ${formatUsd(this.spentUsd)} of its ${formatUsd(this.budgetUsd)} budget; the next model call could cost up to ` +
        `${formatUsd(estimate)}, so it was not sent (about ${formatUsd(more)} more is needed).`,
    );
  }
  release(estimate: number): void {
    this.#reservedUsd = Math.max(0, this.#reservedUsd - estimate);
  }
  record(usd: number): void {
    this.#spentUsd += usd;
  }
}

const round6 = (n: number): number => Math.round(n * 1_000_000) / 1_000_000;
const DEFAULT_OUTPUT_CAP = 4096;

/** Characters of the conversation as the model will read it. Encrypted reasoning is counted lightly (base64 of tokens). */
function conversationChars(state: readonly JsonValue[]): number {
  let n = 0;
  const walk = (v: JsonValue, key: string): void => {
    if (typeof v === 'string') n += key === 'encrypted_content' ? Math.ceil(v.length / 4) : v.length;
    else if (Array.isArray(v)) for (const x of v) walk(x, key);
    else if (v !== null && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, k);
  };
  for (const item of state) walk(item, '');
  return n;
}

/**
 * The most one call can cost, reserved before it starts: input at 3 characters per token (all of it fresh, tools and
 * framing included), output at its full cap (reasoning is billed as output).
 */
export function estimateChatUsd(modelId: string, request: Pick<ChatRequest, 'instructions' | 'input' | 'tools' | 'state' | 'maxOutputTokens'>): number {
  const price = priceFor(modelId);
  const chars =
    request.instructions.length + JSON.stringify(request.input).length + JSON.stringify(request.tools).length + conversationChars(request.state);
  const inputTokens = Math.ceil(chars / 3) + 500;
  const outputTokens = request.maxOutputTokens ?? DEFAULT_OUTPUT_CAP;
  return round6((inputTokens * price.input + outputTokens * price.output) / 1_000_000);
}

/** Errors worth one more try: rate limits, server errors and dropped connections. */
const RETRYABLE = new Set(['MODEL_RATE_LIMITED', 'MODEL_SERVER_ERROR', 'MODEL_REQUEST_FAILED']);

export interface LiveChatOptions {
  readonly provider: ModelProvider;
  readonly budget: ChatBudget;
  readonly sleep?: (ms: number) => Promise<void>;
}

export class LiveChat implements ChatModel {
  readonly id: string;
  readonly mode = 'live' as const;
  readonly #provider: ModelProvider;
  readonly #budget: ChatBudget;
  readonly #sleep: (ms: number) => Promise<void>;

  constructor(options: LiveChatOptions) {
    this.#provider = options.provider;
    this.id = options.provider.model;
    this.#budget = options.budget;
    this.#sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async complete(request: ChatRequest): Promise<ChatCompletion> {
    const estimate = estimateChatUsd(this.id, request);
    for (let attempt = 1; ; attempt += 1) {
      this.#budget.reserve(estimate);
      try {
        const done = await this.#provider.complete({
          instructions: request.instructions,
          input: request.input,
          tools: request.tools,
          state: request.state,
          signal: request.signal,
          parallelToolCalls: request.tools.length > 0,
          ...(request.maxOutputTokens !== undefined ? { maxOutputTokens: request.maxOutputTokens } : {}),
        });
        const tokens = done.usage ?? { inputTokens: 0, outputTokens: 0 };
        const usage: ModelUsage = {
          id: this.id,
          mode: 'live',
          inputTokens: tokens.inputTokens,
          outputTokens: tokens.outputTokens,
          usd: usdFor(this.id, tokens),
        };
        this.#budget.record(usage.usd);
        return { text: done.text, toolCalls: done.toolCalls, state: done.state, finishReason: done.finishReason ?? 'completed', usage };
      } catch (error) {
        const retry = attempt === 1 && !request.signal.aborted && error instanceof JuratorError && RETRYABLE.has(error.code);
        if (!retry) throw error;
        await this.#sleep(error.code === 'MODEL_RATE_LIMITED' ? 2_000 : 750);
      } finally {
        this.#budget.release(estimate);
      }
    }
  }
}

/* ------------------------------ scripted ------------------------------ */

const scriptedCall = z.object({
  id: z.string().min(1).max(64).optional(),
  name: z.string().min(1).max(64),
  arguments: z.record(z.string(), z.unknown()).optional(),
  args: z.record(z.string(), z.unknown()).optional(),
});
const scriptedRound = z.object({
  text: z.string().optional(),
  toolCalls: z.array(scriptedCall).max(64).optional(),
  usage: z.object({ inputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative() }).optional(),
  finishReason: z.enum(['completed', 'output_limit', 'refused']).optional(),
});
export type ScriptedRound = z.infer<typeof scriptedRound>;

/** The provider items a request's input becomes (the same shape the Meta provider sends). */
export function inputItems(input: readonly ModelInput[]): JsonValue[] {
  return input.map((item) =>
    item.type === 'message'
      ? { type: 'message', role: 'user', content: [{ type: 'input_text', text: item.content }] }
      : { type: 'function_call_output', call_id: item.callId, output: JSON.stringify(item.output) },
  );
}

/** One call as the scripted chat saw it (tests read these). */
export interface ScriptedRequestLog {
  readonly turn: number;
  readonly round: number;
  readonly instructions: string;
  readonly input: readonly ModelInput[];
  readonly tools: readonly string[];
  readonly state: readonly JsonValue[];
}

/** `<dir>/<turn>-<round>.json`: `{ text?, toolCalls?: [{ id?, name, arguments }], usage?: { inputTokens, outputTokens } }`. */
export class ScriptedChat implements ChatModel {
  readonly id: string;
  readonly mode = 'scripted' as const;
  readonly dir: string;
  readonly requests: ScriptedRequestLog[] = [];
  readonly #budget: ChatBudget;
  #calls = 0;

  /** `modelId` prices the recorded token counts, so the cost meter and the budget behave as they would live. */
  constructor(dir: string, modelId: string, budget: ChatBudget, cwd: string = process.cwd()) {
    this.dir = resolve(cwd, dir);
    this.id = modelId;
    this.#budget = budget;
  }

  pathFor(turn: number, round: number): string {
    return join(this.dir, `${turn}-${round}.json`);
  }

  async complete(request: ChatRequest): Promise<ChatCompletion> {
    if (request.signal.aborted) throw new JuratorError('MODEL_CANCELLED', 'The model request was cancelled.');
    const path = this.pathFor(request.turn, request.round);
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch {
      throw new JuratorError('SCRIPT_MISSING', `No recorded answer for turn ${request.turn}, call ${request.round} at ${path}.`);
    }
    let parsed: ScriptedRound;
    try {
      parsed = scriptedRound.parse(JSON.parse(text));
    } catch {
      throw new JuratorError('SCRIPT_MISSING', `The recorded answer at ${path} is not a valid round ({text, toolCalls, usage}).`);
    }
    const estimate = estimateChatUsd(this.id, request);
    this.#budget.reserve(estimate);
    try {
      this.requests.push({
        turn: request.turn,
        round: request.round,
        instructions: request.instructions,
        input: request.input,
        tools: request.tools.map((t) => t.name),
        state: request.state,
      });
      const toolCalls: ModelToolCall[] = (parsed.toolCalls ?? []).map((c) => {
        this.#calls += 1;
        return { id: c.id ?? `call_${this.#calls}`, name: c.name, arguments: c.arguments ?? c.args ?? {} };
      });
      const answer = parsed.text ?? '';
      const output: JsonValue[] = [
        ...toolCalls.map((c): JsonValue => ({ type: 'function_call', call_id: c.id, name: c.name, arguments: JSON.stringify(c.arguments) })),
        ...(answer ? [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: answer }] } as JsonValue] : []),
      ];
      const tokens = parsed.usage ?? { inputTokens: 0, outputTokens: 0 };
      const usage: ModelUsage = { id: this.id, mode: 'scripted', ...tokens, usd: usdFor(this.id, tokens) };
      this.#budget.record(usage.usd);
      return {
        text: answer,
        toolCalls,
        state: [...request.state, ...inputItems(request.input), ...output],
        finishReason: parsed.finishReason ?? 'completed',
        usage,
      };
    } finally {
      this.#budget.release(estimate);
    }
  }
}

export interface CreateChatOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly modelId: string;
  readonly budget: ChatBudget;
  readonly reasoningEffort?: ReasoningEffort;
  /** Recorded rounds: no network call is ever made, even with a key. */
  readonly scriptedDir?: string | undefined;
  readonly cwd?: string;
  /** Tests only. */
  readonly fetch?: typeof globalThis.fetch;
  readonly sleep?: (ms: number) => Promise<void>;
}

/** Scripted when `scriptedDir` is given, else live (throws MODEL_KEY_REQUIRED without a key). Nothing falls back. */
export function createChatModel(options: CreateChatOptions): ChatModel {
  if (options.scriptedDir) return new ScriptedChat(options.scriptedDir, options.modelId, options.budget, options.cwd);
  // The discuss model is chosen by --model and /model; MODEL_ID in the environment does not override it here.
  const env: NodeJS.ProcessEnv = { ...options.env };
  delete env.MODEL_ID;
  const provider = createMetaProvider(
    env,
    { model: options.modelId, ...(options.reasoningEffort ? { reasoningEffort: options.reasoningEffort } : {}) },
    { timeoutMs: 180_000, ...(options.fetch ? { fetch: options.fetch } : {}) },
  );
  return new LiveChat({ provider, budget: options.budget, ...(options.sleep ? { sleep: options.sleep } : {}) });
}
