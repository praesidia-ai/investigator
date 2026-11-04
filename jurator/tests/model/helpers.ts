import { vi } from 'vitest';
import { type Config, DEFAULT_CONFIG } from '../../src/contracts.js';

export const TEST_KEY = 'test-only-model-key';
export const CONFIG: Config = { ...DEFAULT_CONFIG, model: { id: 'muse-wonder-1.0', reasoningEffort: 'low' } };

export function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
}

/** A Meta Responses API answer whose output text is `text`. */
export function reply(
  text: string,
  options: { model?: string; usage?: Record<string, unknown>; status?: string; extra?: Record<string, unknown> } = {},
): Response {
  return jsonResponse({
    id: 'resp-1',
    status: options.status ?? 'completed',
    model: options.model ?? 'muse-wonder-1.0',
    output: [
      { type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text }] },
    ],
    usage: options.usage ?? { input_tokens: 1000, output_tokens: 100 },
    ...options.extra,
  });
}

export function transport(...responses: Response[]) {
  const requests: { url: string; body: Record<string, unknown>; headers: Record<string, string> }[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
    requests.push({
      url: String(url),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    const next = responses.shift();
    if (!next) throw new Error('Unexpected transport call in test.');
    return next;
  });
  return { fetch, requests };
}

export const noSleep = vi.fn(async (_ms: number) => {});
