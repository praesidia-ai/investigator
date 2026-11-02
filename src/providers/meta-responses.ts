import { z } from 'zod';
import { InvestigatorError } from '../core/errors.js';
import type { JsonObject, JsonValue } from '../core/json.js';
import type {
  ModelCompletion,
  ModelProvider,
  ModelRequest,
  ModelToolCall,
  ReasoningEffort,
} from './model-provider.js';
import { assertStrictMetaSchema } from './strict-schema.js';

/** Explicit configuration only: standalone runs never inspect Praesidia credentials. */
export interface MetaResponsesOptions {
  readonly apiKey: string;
  readonly model?: string;
  readonly baseUrl?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly allowLoopbackHttp?: boolean;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
  readonly maxOutputTokens?: number;
  readonly reasoningEffort?: ReasoningEffort;
}

const jsonSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.array(jsonSchema),
    z.record(z.string(), jsonSchema),
  ]),
);
const objectSchema = z.record(z.string(), jsonSchema);
const outputTokenLimitSchema = z.number().int().min(16).max(32_768);
const reasoningEffortSchema = z.enum(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const identifierSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[^\s\u0000-\u001f\u007f]+$/u);
const nameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)?$/u);
const callSchema = z
  .object({
    type: z.literal('function_call'),
    call_id: identifierSchema,
    name: nameSchema,
    arguments: z.string(),
    status: z.literal('completed').optional(),
  })
  .passthrough();
const callOutputSchema = z
  .object({
    type: z.literal('function_call_output'),
    call_id: identifierSchema,
    output: z.string(),
  })
  .passthrough();
const assistantSchema = z
  .object({
    type: z.literal('message'),
    role: z.literal('assistant'),
    status: z.literal('completed').optional(),
    phase: z.enum(['commentary', 'final_answer']).optional(),
    content: z
      .array(
        z.union([
          z.object({ type: z.literal('output_text'), text: z.string() }).passthrough(),
          z.object({ type: z.literal('refusal'), refusal: z.string() }).passthrough(),
        ]),
      )
      .max(256),
  })
  .passthrough();
const userSchema = z
  .object({
    type: z.literal('message'),
    role: z.literal('user'),
    content: z.array(z.object({ type: z.literal('input_text'), text: z.string() }).passthrough()),
  })
  .passthrough();
const reasoningSchema = z
  .object({
    type: z.literal('reasoning'),
    summary: z.array(jsonSchema),
    encrypted_content: z.string().min(1),
  })
  .passthrough();
const envelopeSchema = z
  .object({
    status: z.enum(['completed', 'incomplete']),
    output: z.array(jsonSchema).max(256),
    model: z.string().optional(),
    error: z.null().optional(),
    incomplete_details: z
      .object({ reason: z.literal('max_output_tokens') })
      .passthrough()
      .nullish(),
    usage: z
      .object({
        input_tokens: z.number().int().nonnegative().safe(),
        output_tokens: z.number().int().nonnegative().safe(),
      })
      .passthrough()
      .nullish(),
  })
  .passthrough();
const requestSchema = z.object({
  instructions: z.string(),
  input: z
    .array(
      z.discriminatedUnion('type', [
        z.object({ type: z.literal('message'), role: z.literal('user'), content: z.string() }),
        z.object({ type: z.literal('tool-result'), callId: identifierSchema, output: jsonSchema }),
      ]),
    )
    .max(256),
  tools: z
    .array(
      z.object({
        name: nameSchema,
        description: z.string(),
        parameters: z.object({ type: z.literal('object') }).catchall(jsonSchema),
      }),
    )
    .max(128),
  state: z.array(jsonSchema).max(2048).optional(),
  outputFormat: z
    .object({
      name: z
        .string()
        .min(1)
        .max(64)
        .regex(/^[a-zA-Z0-9_-]+$/u),
      schema: z.object({ type: z.literal('object') }).catchall(jsonSchema),
    })
    .strict()
    .optional(),
  maxOutputTokens: outputTokenLimitSchema.optional(),
  reasoningEffort: reasoningEffortSchema.optional(),
});

const trustedFailures = new WeakSet<InvestigatorError>();
function failure(code: string, message: string): InvestigatorError {
  // No upstream text, cause, request URL, headers or key ever enters a public error.
  const error = new InvestigatorError(code, message);
  trustedFailures.add(error);
  return error;
}
function invalidResponse(): InvestigatorError {
  return failure('MODEL_RESPONSE_INVALID', 'The model returned an invalid or incomplete response.');
}
function invalidRequest(): InvestigatorError {
  return failure('MODEL_REQUEST_INVALID', 'The model request or continuation is invalid.');
}
function cancelled(): InvestigatorError {
  return failure('MODEL_CANCELLED', 'The model request was cancelled.');
}
function asObject(value: JsonValue): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw invalidResponse();
  return value;
}
function parseArguments(value: string): JsonObject {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw invalidResponse();
  }
  const result = objectSchema.safeParse(parsed);
  if (!result.success) throw invalidResponse();
  return result.data;
}

/** Abort even injected transports/readers that fail to honor the supplied signal. */
async function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw cancelled();
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(cancelled());
    signal.addEventListener('abort', onAbort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
    // Covers an abort between the first check and listener registration.
    if (signal.aborted) onAbort();
  });
}

async function readJson(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<unknown> {
  const tooLarge = (): InvestigatorError =>
    failure('MODEL_RESPONSE_TOO_LARGE', 'The model response exceeded the size limit.');
  const cancelBody = (): void => {
    void response.body?.cancel().catch(() => undefined);
  };
  const length = response.headers.get('content-length');
  if (length !== null && /^\d+$/u.test(length) && Number(length) > maxBytes) {
    cancelBody();
    throw tooLarge();
  }
  if (
    !/^application\/(?:[a-z0-9.+-]+\+)?json(?:\s*;|$)/iu.test(
      response.headers.get('content-type') ?? '',
    ) ||
    !response.body
  ) {
    cancelBody();
    throw invalidResponse();
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const chunk = await abortable(reader.read(), signal);
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) throw tooLarge();
      chunks.push(chunk.value);
    }
    const joined = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
      joined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    try {
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(joined)) as unknown;
    } catch {
      throw invalidResponse();
    }
  } catch (error: unknown) {
    void reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

function endpoint(baseUrl: string, allowLoopbackHttp: boolean): string {
  const invalid = (): InvestigatorError =>
    failure('MODEL_CONFIG_INVALID', 'The model endpoint configuration is invalid.');
  if (!baseUrl || baseUrl !== baseUrl.trim() || /[\s\\?#]/u.test(baseUrl)) throw invalid();
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw invalid();
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  if (
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    (parsed.protocol !== 'https:' &&
      !(allowLoopbackHttp && loopback && parsed.protocol === 'http:'))
  )
    throw invalid();
  parsed.pathname = `${parsed.pathname.replace(/\/+$/u, '')}/responses`;
  return parsed.href;
}

interface PreparedRequest {
  readonly input: JsonValue[];
  readonly body: string;
  readonly historicalCallIds: ReadonlySet<string>;
  readonly toolNames: ReadonlySet<string>;
}

function prepare(
  request: ModelRequest,
  model: string,
  defaults: { maxOutputTokens: number; reasoningEffort: ReasoningEffort },
): PreparedRequest {
  const result = requestSchema.safeParse(request);
  if (!result.success) throw invalidRequest();
  const data = result.data;
  const toolNames = new Set(data.tools.map((tool) => tool.name));
  if (toolNames.size !== data.tools.length) throw invalidRequest();
  for (const tool of data.tools) assertStrictMetaSchema(tool.parameters, 'tool');
  if (data.outputFormat) assertStrictMetaSchema(data.outputFormat.schema, 'output');
  const input: JsonValue[] = [...(data.state ?? [])];
  for (const item of data.input) {
    input.push(
      item.type === 'message'
        ? { type: 'message', role: 'user', content: [{ type: 'input_text', text: item.content }] }
        : {
            type: 'function_call_output',
            call_id: item.callId,
            output: JSON.stringify(item.output),
          },
    );
  }
  const calls = new Set<string>();
  const results = new Set<string>();
  try {
    for (const raw of input) {
      const item = asObject(raw);
      switch (item['type']) {
        case 'function_call': {
          const call = callSchema.parse(item);
          parseArguments(call.arguments);
          if (calls.has(call.call_id)) throw invalidRequest();
          calls.add(call.call_id);
          break;
        }
        case 'function_call_output': {
          const output = callOutputSchema.parse(item);
          if (!calls.has(output.call_id) || results.has(output.call_id)) throw invalidRequest();
          results.add(output.call_id);
          break;
        }
        case 'message':
          if (item['role'] === 'assistant') assistantSchema.parse(item);
          else userSchema.parse(item);
          break;
        case 'reasoning':
          reasoningSchema.parse(item);
          break;
        default:
          throw invalidRequest();
      }
    }
    if (calls.size !== results.size) throw invalidRequest();
  } catch {
    throw invalidRequest();
  }
  const body = JSON.stringify({
    model,
    instructions: data.instructions,
    input,
    tools: data.tools.map((tool) => ({ type: 'function', ...tool, strict: true })),
    store: false,
    include: ['reasoning.encrypted_content'],
    stream: false,
    tool_choice: 'auto',
    parallel_tool_calls: false,
    max_output_tokens: data.maxOutputTokens ?? defaults.maxOutputTokens,
    reasoning: { effort: data.reasoningEffort ?? defaults.reasoningEffort },
    ...(data.outputFormat
      ? {
          text: {
            format: {
              type: 'json_schema',
              name: data.outputFormat.name,
              schema: data.outputFormat.schema,
              strict: true,
            },
          },
        }
      : {}),
  });
  if (Buffer.byteLength(body) > 4 * 1024 * 1024) throw invalidRequest();
  return { input, body, historicalCallIds: calls, toolNames };
}

function completion(raw: unknown, prepared: PreparedRequest, model: string): ModelCompletion {
  const parsed = envelopeSchema.safeParse(raw);
  if (!parsed.success || (parsed.data.model !== undefined && parsed.data.model !== model))
    throw invalidResponse();
  const response = parsed.data;
  const outputLimited = response.status === 'incomplete';
  if (outputLimited && !response.incomplete_details) throw invalidResponse();
  if (outputLimited) {
    return {
      text: '',
      toolCalls: [],
      state: prepared.input,
      finishReason: 'output_limit',
      ...(response.usage
        ? {
            usage: {
              inputTokens: response.usage.input_tokens,
              outputTokens: response.usage.output_tokens,
            },
          }
        : {}),
    };
  }
  const toolCalls: ModelToolCall[] = [];
  const callIds = new Set(prepared.historicalCallIds);
  const text: string[] = [];
  let refused = false;
  for (const rawItem of response.output) {
    const item = asObject(rawItem);
    switch (item['type']) {
      case 'function_call': {
        const parsedCall = callSchema.safeParse(item);
        if (!parsedCall.success) throw invalidResponse();
        const call = parsedCall.data;
        if (!prepared.toolNames.has(call.name) || callIds.has(call.call_id))
          throw invalidResponse();
        callIds.add(call.call_id);
        toolCalls.push({
          id: call.call_id,
          name: call.name,
          arguments: parseArguments(call.arguments),
        });
        break;
      }
      case 'reasoning':
        if (!reasoningSchema.safeParse(item).success) throw invalidResponse();
        break;
      case 'message': {
        const message = assistantSchema.safeParse(item);
        if (!message.success) throw invalidResponse();
        if (message.data.phase !== 'commentary') {
          for (const part of message.data.content) {
            if (part.type === 'refusal') refused = true;
            else text.push(part.text);
          }
        }
        break;
      }
      default:
        throw invalidResponse();
    }
  }
  const finalText = text.join('\n');
  if (!refused && !toolCalls.length && !finalText.trim()) throw invalidResponse();
  return {
    text: finalText,
    toolCalls: refused ? [] : toolCalls,
    finishReason: refused ? 'refused' : 'completed',
    // Keep complete original items, including encrypted state, annotations and phase.
    // This state is private provider continuation, never investigation evidence.
    state: [...prepared.input, ...response.output],
    ...(response.usage
      ? {
          usage: {
            inputTokens: response.usage.input_tokens,
            outputTokens: response.usage.output_tokens,
          },
        }
      : {}),
  };
}

/** Native-fetch, non-streaming Responses transport with stateless encrypted replay. */
export class MetaResponsesProvider implements ModelProvider {
  readonly id = 'meta-responses';
  readonly mode = 'live' as const;
  readonly model: string;
  readonly reasoningEffort: ReasoningEffort;
  readonly #apiKey: string;
  readonly #endpoint: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #timeoutMs: number;
  readonly #maxResponseBytes: number;
  readonly #maxOutputTokens: number;
  readonly #reasoningEffort: ReasoningEffort;

  constructor(options: MetaResponsesOptions) {
    const config = z
      .object({
        apiKey: z
          .string()
          .min(1)
          .max(4096)
          .regex(/^[^\s\u0000-\u001f\u007f]+$/u),
        model: z
          .string()
          .min(1)
          .max(200)
          .regex(/^[^\s\u0000-\u001f\u007f]+$/u)
          .default('muse-wonder-1.0'),
        baseUrl: z.string().default('https://api.meta.ai/v1'),
        allowLoopbackHttp: z.boolean().default(false),
        timeoutMs: z.number().int().min(1).max(300_000).default(60_000),
        maxResponseBytes: z
          .number()
          .int()
          .min(1)
          .max(8 * 1024 * 1024)
          .default(1024 * 1024),
        maxOutputTokens: outputTokenLimitSchema.default(4096),
        reasoningEffort: reasoningEffortSchema.default('medium'),
      })
      .safeParse(options);
    if (!config.success || (options.fetch !== undefined && typeof options.fetch !== 'function')) {
      throw failure('MODEL_CONFIG_INVALID', 'The model provider configuration is invalid.');
    }
    this.model = config.data.model;
    this.#apiKey = config.data.apiKey;
    this.#endpoint = endpoint(config.data.baseUrl, config.data.allowLoopbackHttp);
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#timeoutMs = config.data.timeoutMs;
    this.#maxResponseBytes = config.data.maxResponseBytes;
    this.#maxOutputTokens = config.data.maxOutputTokens;
    this.#reasoningEffort = config.data.reasoningEffort;
    this.reasoningEffort = config.data.reasoningEffort;
  }

  async complete(request: ModelRequest): Promise<ModelCompletion> {
    if (request.signal.aborted) throw cancelled();
    let prepared: PreparedRequest;
    try {
      prepared = prepare(request, this.model, {
        maxOutputTokens: this.#maxOutputTokens,
        reasoningEffort: this.#reasoningEffort,
      });
    } catch {
      throw invalidRequest();
    }
    const timeout = new AbortController();
    const signal = AbortSignal.any([request.signal, timeout.signal]);
    const timer = setTimeout(() => timeout.abort(), this.#timeoutMs);
    try {
      const response = await abortable(
        this.#fetch(this.#endpoint, {
          method: 'POST',
          redirect: 'error',
          signal,
          headers: {
            Authorization: `Bearer ${this.#apiKey}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: prepared.body,
        }),
        signal,
      );
      if (response.redirected || (response.status >= 300 && response.status < 400)) {
        void response.body?.cancel().catch(() => undefined);
        throw failure(
          'MODEL_REDIRECT_REJECTED',
          'The model endpoint attempted an unsupported redirect.',
        );
      }
      if (!response.ok) {
        void response.body?.cancel().catch(() => undefined);
        throw failure('MODEL_HTTP_ERROR', 'The model service rejected the request.');
      }
      return completion(
        await readJson(response, this.#maxResponseBytes, signal),
        prepared,
        this.model,
      );
    } catch (error: unknown) {
      if (request.signal.aborted) throw cancelled();
      if (timeout.signal.aborted)
        throw failure('MODEL_TIMEOUT', 'The model request exceeded its time limit.');
      if (error instanceof InvestigatorError && trustedFailures.has(error)) throw error;
      throw failure('MODEL_REQUEST_FAILED', 'The model request failed.');
    } finally {
      clearTimeout(timer);
    }
  }
}
