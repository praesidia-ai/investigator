// Ported from praesidia-ai/investigator@d49aaea (Apache-2.0) plus the uncommitted parallel_tool_calls patch.
// Jurator changes: JuratorError; decodeUtf8 inlined; readMetaEnvironment takes defaults from .jurator/config.json
// (env MODEL_ID / MODEL_REASONING_EFFORT still win); plain-words error messages.
import { z } from 'zod';
import { JuratorError } from '../../util/errors.js';
import type { ReasoningEffort } from './model-provider.js';
import { MetaResponsesProvider } from './meta-responses.js';

function decodeUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new JuratorError('INVALID_ENCODING', 'The model catalog was not valid UTF-8 text.');
  }
}

export const RECOMMENDED_META_MODEL = 'muse-wonder-1.0';
export const COMPARISON_META_MODEL = 'muse-spark-1.3';
const settingsSchema = z.object({
  model: z
    .string()
    .min(1)
    .max(200)
    .regex(/^[^\s\u0000-\u001f\u007f]+$/u),
  baseUrl: z.string().min(1),
  reasoningEffort: z.enum(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']),
});
const keySchema = z
  .string()
  .min(1)
  .max(4096)
  .regex(/^[^\s\u0000-\u001f\u007f]+$/u);

export interface MetaEnvironment {
  readonly model: string;
  readonly baseUrl: string;
  readonly reasoningEffort: ReasoningEffort;
  readonly apiKey?: string;
}

export interface MetaDefaults {
  readonly model?: string;
  readonly reasoningEffort?: ReasoningEffort;
}

/** Only explicit environment names are consulted. This object must never be logged. */
export function readMetaEnvironment(env: NodeJS.ProcessEnv, defaults: MetaDefaults = {}): MetaEnvironment {
  const alias = env.META_API_KEY || undefined;
  const official = env.MODEL_API_KEY || undefined;
  if (alias && official && alias !== official)
    throw new JuratorError(
      'MODEL_KEY_CONFLICT',
      'META_API_KEY and MODEL_API_KEY must not specify different credentials.',
    );
  const apiKey = alias ?? official;
  const settings = settingsSchema.safeParse({
    model: env.MODEL_ID || defaults.model || RECOMMENDED_META_MODEL,
    baseUrl: env.MODEL_BASE_URL || 'https://api.meta.ai/v1',
    reasoningEffort: env.MODEL_REASONING_EFFORT || defaults.reasoningEffort || 'medium',
  });
  if (!settings.success || (apiKey !== undefined && !keySchema.safeParse(apiKey).success))
    throw new JuratorError(
      'MODEL_CONFIG_INVALID',
      'The model environment configuration is invalid.',
    );
  const base = settings.data.baseUrl;
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    throw new JuratorError(
      'MODEL_CONFIG_INVALID',
      'The model endpoint must be an HTTPS base URL.',
    );
  }
  if (
    base !== base.trim() ||
    /[\s\\?#]/u.test(base) ||
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new JuratorError(
      'MODEL_CONFIG_INVALID',
      'The model endpoint must be an HTTPS base URL without credentials, query or fragment.',
    );
  return { ...settings.data, ...(apiKey ? { apiKey } : {}) };
}

export function createMetaProvider(
  env: NodeJS.ProcessEnv,
  defaults: MetaDefaults = {},
  extra: { readonly fetch?: typeof globalThis.fetch; readonly timeoutMs?: number } = {},
): MetaResponsesProvider {
  const config = readMetaEnvironment(env, defaults);
  if (!config.apiKey)
    throw new JuratorError(
      'MODEL_KEY_REQUIRED',
      'Set META_API_KEY to use AI steps, or pass --scripted <dir>, or use --no-ai.',
    );
  return new MetaResponsesProvider({ ...config, apiKey: config.apiKey, ...extra });
}

export interface MetaDiagnostic {
  readonly format: 'jurator-meta-diagnostic-v1';
  readonly selectedModel: string;
  readonly recommendedModel: typeof RECOMMENDED_META_MODEL;
  readonly comparisonModel: typeof COMPARISON_META_MODEL;
  readonly reasoningEffort: ReasoningEffort;
  readonly keyConfigured: boolean;
  readonly customEndpoint: boolean;
  readonly accountAccess: 'not-checked' | 'selected-model-available' | 'selected-model-unavailable';
  readonly generationVerification: 'not-performed';
  readonly modelApi: 'responses';
  readonly structuredOutput: 'text.format-json_schema-strict';
  readonly maxOutputTokensPerCall: 4096;
  readonly maxOutputTokensPerInvestigation: 32768;
}

async function catalogJson(response: Response): Promise<unknown> {
  if (!response.ok || !response.body)
    throw new JuratorError(
      'MODEL_CATALOG_UNAVAILABLE',
      'Meta model access could not be checked; verify credentials, endpoint and account access.',
    );
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 262_144)
        throw new JuratorError(
          'MODEL_CATALOG_INVALID',
          'The model catalog exceeds the supported limit.',
        );
      chunks.push(part.value);
    }
    try {
      return JSON.parse(decodeUtf8(Buffer.concat(chunks))) as unknown;
    } catch {
      throw new JuratorError('MODEL_CATALOG_INVALID', 'The model catalog was not valid JSON.');
    }
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** --live checks the authenticated catalog only; it does not generate or spend output tokens. */
export async function diagnoseMeta(
  env: NodeJS.ProcessEnv,
  options: {
    readonly live?: boolean;
    readonly signal?: AbortSignal;
    readonly fetch?: typeof globalThis.fetch;
    readonly timeoutMs?: number;
  } = {},
): Promise<MetaDiagnostic> {
  const config = readMetaEnvironment(env);
  let accountAccess: MetaDiagnostic['accountAccess'] = 'not-checked';
  if (options.live) {
    if (!config.apiKey)
      throw new JuratorError(
        'MODEL_KEY_REQUIRED',
        'Set META_API_KEY or MODEL_API_KEY before checking live model access.',
      );
    const timeoutMs = options.timeoutMs ?? 15_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000)
      throw new JuratorError('MODEL_CONFIG_INVALID', 'The model access timeout is invalid.');
    const signal = AbortSignal.any([
      AbortSignal.timeout(timeoutMs),
      ...(options.signal ? [options.signal] : []),
    ]);
    const url = new URL(config.baseUrl);
    url.pathname = `${url.pathname.replace(/\/+$/u, '')}/models`;
    let onAbort: (() => void) | undefined;
    try {
      const aborted = new Promise<never>((_resolve, reject) => {
        onAbort = () =>
          reject(
            new JuratorError(
              'MODEL_CATALOG_ABORTED',
              'The model access check was cancelled or timed out.',
            ),
          );
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) onAbort();
      });
      const document = await Promise.race([
        (async () =>
          catalogJson(
            await (options.fetch ?? globalThis.fetch)(url, {
              method: 'GET',
              headers: { Authorization: `Bearer ${config.apiKey}`, Accept: 'application/json' },
              redirect: 'error',
              signal,
            }),
          ))(),
        aborted,
      ]);
      const catalog = z
        .object({
          object: z.literal('list'),
          data: z.array(z.object({ id: z.string().min(1).max(200) }).passthrough()).max(2048),
        })
        .passthrough()
        .safeParse(document);
      if (!catalog.success)
        throw new JuratorError(
          'MODEL_CATALOG_INVALID',
          'The model catalog has an unsupported shape.',
        );
      accountAccess = catalog.data.data.some((model) => model.id === config.model)
        ? 'selected-model-available'
        : 'selected-model-unavailable';
    } catch (error) {
      if (error instanceof JuratorError) throw error;
      throw new JuratorError(
        'MODEL_CATALOG_UNAVAILABLE',
        'Meta model access could not be checked; no response content or credentials were retained.',
      );
    } finally {
      if (onAbort) signal.removeEventListener('abort', onAbort);
    }
  }
  return {
    format: 'jurator-meta-diagnostic-v1',
    selectedModel: config.model,
    recommendedModel: RECOMMENDED_META_MODEL,
    comparisonModel: COMPARISON_META_MODEL,
    reasoningEffort: config.reasoningEffort,
    keyConfigured: Boolean(config.apiKey),
    customEndpoint: config.baseUrl !== 'https://api.meta.ai/v1',
    accountAccess,
    generationVerification: 'not-performed',
    modelApi: 'responses',
    structuredOutput: 'text.format-json_schema-strict',
    maxOutputTokensPerCall: 4096,
    maxOutputTokensPerInvestigation: 32768,
  };
}
