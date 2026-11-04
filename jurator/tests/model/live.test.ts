import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createModel, LiveModelClient, ModelIncompleteError } from '../../src/model/index.js';
import { JuratorError } from '../../src/util/errors.js';
import { CONFIG, jsonResponse, noSleep, reply, TEST_KEY, transport } from './helpers.js';

const schema = z.object({
  promises: z.array(z.object({ wording: z.string(), quote: z.string(), unit: z.string().nullable() })),
  note: z.string().optional(),
});
const request = {
  task: 'compile:privacy',
  instructions: 'Find the promises.',
  input: 'We delete chats after 30 days.',
  schemaName: 'compile_drafts.v1',
  schema,
  maxOutputTokens: 4096,
};
const answer = { promises: [{ wording: 'Delete chats after 30 days.', quote: 'delete chats after 30 days', unit: 'days' }] };

function live(t: ReturnType<typeof transport>, env: NodeJS.ProcessEnv = { META_API_KEY: TEST_KEY }, budget = 2) {
  return createModel({
    config: { ...CONFIG, budgetUsdPerRun: budget },
    env,
    fetch: t.fetch,
    sleep: noSleep,
  }) as LiveModelClient;
}

async function failure(promise: Promise<unknown>): Promise<JuratorError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof JuratorError) return error;
    throw error;
  }
  throw new Error('expected a failure');
}

describe('live Meta client (fake fetch)', () => {
  it('sends a strict, stateless structured-output request and returns the validated value with cost', async () => {
    const t = transport(reply(JSON.stringify({ ...answer, note: null })));
    const model = live(t);
    const result = await model.json(request);
    expect(result.value).toEqual(answer);
    expect(result.usage).toEqual({ id: 'muse-wonder-1.0', mode: 'live', inputTokens: 1000, outputTokens: 100, usd: 0.006 });
    expect(model.spentUsd).toBe(0.006);

    const sent = t.requests[0]!;
    expect(sent.url).toBe('https://api.meta.ai/v1/responses');
    expect(sent.headers['Authorization']).toBe(`Bearer ${TEST_KEY}`);
    expect(sent.body['model']).toBe('muse-wonder-1.0');
    expect(sent.body['store']).toBe(false);
    expect(sent.body['stream']).toBe(false);
    expect(sent.body['max_output_tokens']).toBe(4096);
    expect(sent.body['reasoning']).toEqual({ effort: 'low' });
    expect(sent.body['tools']).toBeUndefined();
    expect(sent.body['tool_choice']).toBeUndefined();
    expect(sent.body['instructions']).toBe('Find the promises.');
    expect(sent.body['input']).toEqual([
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'We delete chats after 30 days.' }] },
    ]);
    const format = (sent.body['text'] as { format: Record<string, unknown> }).format;
    expect(format['type']).toBe('json_schema');
    expect(format['strict']).toBe(true);
    expect(format['name']).toBe('compile_drafts_v1');
    const strict = format['schema'] as { required: string[]; additionalProperties: boolean };
    expect(strict.required).toEqual(['promises', 'note']);
    expect(strict.additionalProperties).toBe(false);
  });

  it('prices cached input tokens and honours MODEL_ID', async () => {
    const t = transport(
      reply(JSON.stringify(answer), {
        model: 'muse-spark-1.3',
        usage: { input_tokens: 1_000_000, output_tokens: 0, input_tokens_details: { cached_tokens: 900_000 } },
      }),
    );
    const model = live(t, { META_API_KEY: TEST_KEY, MODEL_ID: 'muse-spark-1.3' });
    const result = await model.json(request);
    expect(t.requests[0]!.body['model']).toBe('muse-spark-1.3');
    expect(result.usage.usd).toBe(0.26);
  });

  it('retries once after a 429 or 5xx', async () => {
    const t = transport(jsonResponse({ error: 'slow down' }, 429), reply(JSON.stringify(answer)));
    noSleep.mockClear();
    const result = await live(t).json(request);
    expect(result.value).toEqual(answer);
    expect(t.fetch).toHaveBeenCalledTimes(2);
    expect(noSleep).toHaveBeenCalledWith(2000);

    const t2 = transport(jsonResponse({}, 503), jsonResponse({}, 502));
    const error = await failure(live(t2).json(request));
    expect(error.code).toBe('MODEL_SERVER_ERROR');
    expect(t2.fetch).toHaveBeenCalledTimes(2);
  });

  it('does not retry an auth failure', async () => {
    const t = transport(jsonResponse({}, 401));
    const error = await failure(live(t).json(request));
    expect(error.code).toBe('MODEL_AUTH_FAILED');
    expect(error.message).not.toContain(TEST_KEY);
    expect(t.fetch).toHaveBeenCalledTimes(1);
  });

  it('retries once on invalid JSON and adds up the usage of both calls', async () => {
    const t = transport(reply('not json at all'), reply(JSON.stringify(answer)));
    const model = live(t);
    const result = await model.json(request);
    expect(result.value).toEqual(answer);
    expect(result.usage.inputTokens).toBe(2000);
    expect(result.usage.usd).toBe(0.012);
    expect(model.spentUsd).toBe(0.012);
  });

  it('gives up with MODEL_OUTPUT_INVALID after two off-schema answers', async () => {
    const t = transport(reply('{"promises":"x"}'), reply('{"wrong":true}'));
    const error = await failure(live(t).json(request));
    expect(error.code).toBe('MODEL_OUTPUT_INVALID');
    expect(error.message).toContain('compile:privacy');
    expect(t.fetch).toHaveBeenCalledTimes(2);
  });

  it('reports a truncated or refused answer as MODEL_INCOMPLETE with its cost', async () => {
    const t = transport(
      jsonResponse({
        id: 'r',
        status: 'incomplete',
        model: 'muse-wonder-1.0',
        incomplete_details: { reason: 'max_output_tokens' },
        output: [],
        usage: { input_tokens: 10, output_tokens: 4096 },
      }),
    );
    const error = await failure(live(t).json(request));
    expect(error).toBeInstanceOf(ModelIncompleteError);
    expect(error.code).toBe('MODEL_INCOMPLETE');
    expect((error as ModelIncompleteError).usage.outputTokens).toBe(4096);

    const refused = transport(
      jsonResponse({
        id: 'r',
        status: 'completed',
        model: 'muse-wonder-1.0',
        output: [{ type: 'message', role: 'assistant', content: [{ type: 'refusal', refusal: 'no' }] }],
        usage: { input_tokens: 10, output_tokens: 1 },
      }),
    );
    expect((await failure(live(refused).json(request))).code).toBe('MODEL_INCOMPLETE');
    expect(refused.fetch).toHaveBeenCalledTimes(1);
  });

  it('stops before a call once the run budget is spent', async () => {
    const t = transport(reply(JSON.stringify(answer), { usage: { input_tokens: 0, output_tokens: 100_000 } }));
    const model = live(t, { META_API_KEY: TEST_KEY }, 1);
    await model.json(request); // $2.00 spent
    const error = await failure(model.json(request));
    expect(error.code).toBe('MODEL_BUDGET_EXCEEDED');
    expect(t.fetch).toHaveBeenCalledTimes(1);
  });

  it('rejects a schema Meta strict mode cannot take before any network call', async () => {
    const t = transport();
    const bad = { ...request, schema: z.object({ m: z.record(z.string(), z.string()) }) };
    expect((await failure(live(t).json(bad))).code).toBe('META_SCHEMA_INVALID');
    expect(t.fetch).not.toHaveBeenCalled();
  });
});

describe('R5-B: budget reservation for calls in flight', () => {
  it('reserves each call before it starts, so 8 calls at once cannot pass the budget, and says how much more is needed', async () => {
    // Every call could cost up to ~$0.085 (4096 output tokens at $20/M); $0.30 covers 3 at once, not 8.
    const t = transport(...Array.from({ length: 8 }, () => reply(JSON.stringify(answer), { usage: { input_tokens: 1000, output_tokens: 4000 } })));
    const model = live(t, { META_API_KEY: TEST_KEY }, 0.3);
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => model.json(request)));
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    expect(ok).toBe(3);
    expect(t.fetch).toHaveBeenCalledTimes(3);
    expect(model.spentUsd).toBeLessThanOrEqual(0.3);
    expect(model.reservedUsd).toBe(0);
    const stop = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect((stop.reason as JuratorError).code).toBe('MODEL_BUDGET_EXCEEDED');
    expect((stop.reason as JuratorError).message).toMatch(/could cost up to \$0\.08\d+, so no new call was started \(about \$0\.\d+ more is needed for it\)/u);
  });

  it('after a budget stop no new call starts, even a small one', async () => {
    const t = transport(reply(JSON.stringify(answer)));
    const model = live(t, { META_API_KEY: TEST_KEY }, 0.1);
    expect((await failure(model.json({ ...request, maxOutputTokens: 8000 }))).code).toBe('MODEL_BUDGET_EXCEEDED');
    expect((await failure(model.json({ ...request, maxOutputTokens: 100 }))).code).toBe('MODEL_BUDGET_EXCEEDED');
    expect(t.fetch).not.toHaveBeenCalled();
  });

  it('estimates from the prompt size and the output cap', async () => {
    const { estimateCallUsd } = await import('../../src/model/index.js');
    const small = estimateCallUsd('muse-wonder-1.0', { instructions: 'x', input: 'y', maxOutputTokens: 1000 });
    const big = estimateCallUsd('muse-wonder-1.0', { instructions: 'x', input: 'y'.repeat(30_000), maxOutputTokens: 1000 });
    expect(small).toBeCloseTo((501 * 4 + 1000 * 20) / 1e6, 6);
    expect(big - small).toBeCloseTo((10_000 * 4) / 1e6, 4);
  });
});
