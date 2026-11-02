import { describe, expect, it, vi } from 'vitest';
import { InvestigatorError, publicError } from '../src/core/errors.js';
import type { JsonObject, JsonValue } from '../src/core/json.js';
import { MetaResponsesProvider } from '../src/providers/meta-responses.js';
import type { ModelRequest, ToolDefinition } from '../src/providers/model-provider.js';

const TEST_KEY = 'test-only-model-key';
const TOOL: ToolDefinition = {
  name: 'read_evidence',
  description: 'Read a selected evidence record.',
  parameters: {
    type: 'object',
    properties: { id: { type: 'string' } },
    required: ['id'],
    additionalProperties: false,
  },
};
function request(overrides: Partial<ModelRequest> = {}): ModelRequest {
  return {
    instructions: 'Investigate the named claim using cited evidence.',
    input: [{ type: 'message', role: 'user', content: 'Check the export approval claim.' }],
    tools: [TOOL],
    signal: new AbortController().signal,
    ...overrides,
  };
}
function message(text = 'The evidence is insufficient.'): JsonValue {
  return {
    type: 'message',
    role: 'assistant',
    content: [{ type: 'output_text', text }],
    status: 'completed',
  };
}
function call(overrides: Record<string, JsonValue> = {}): JsonValue {
  return {
    type: 'function_call',
    id: 'fc-item-1',
    call_id: 'call-1',
    name: TOOL.name,
    arguments: '{"id":"policy"}',
    status: 'completed',
    ...overrides,
  };
}
function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
function reply(output: JsonValue[] = [message()], extra: Record<string, unknown> = {}): Response {
  return jsonResponse({
    id: 'response-1',
    status: 'completed',
    model: 'muse-wonder-1.0',
    output,
    usage: { input_tokens: 50, output_tokens: 12 },
    ...extra,
  });
}
function transport(...responses: Response[]): {
  fetch: ReturnType<typeof vi.fn<typeof globalThis.fetch>>;
  requests: { url: string; init: RequestInit }[];
} {
  const requests: { url: string; init: RequestInit }[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
    requests.push({ url: String(url), init: init ?? {} });
    const response = responses.shift();
    if (!response) throw new Error('Unexpected transport call in test.');
    return response;
  });
  return { fetch, requests };
}
function bodyAt(mock: ReturnType<typeof transport>, index: number): Record<string, unknown> {
  return JSON.parse(String(mock.requests[index]?.init.body)) as Record<string, unknown>;
}

describe('Meta Responses transport', () => {
  it('sends an explicit stateless Responses request and maps text and usage', async () => {
    const mock = transport(reply());
    const provider = new MetaResponsesProvider({ apiKey: TEST_KEY, fetch: mock.fetch });
    const result = await provider.complete(request());
    expect(provider).toMatchObject({
      id: 'meta-responses',
      mode: 'live',
      model: 'muse-wonder-1.0',
    });
    expect(mock.requests).toHaveLength(1);
    expect(mock.requests[0]).toMatchObject({
      url: 'https://api.meta.ai/v1/responses',
      init: { method: 'POST', redirect: 'error', headers: { Authorization: `Bearer ${TEST_KEY}` } },
    });
    expect(bodyAt(mock, 0)).toMatchObject({
      model: 'muse-wonder-1.0',
      store: false,
      stream: false,
      include: ['reasoning.encrypted_content'],
      parallel_tool_calls: false,
      tool_choice: 'auto',
      max_output_tokens: 4096,
      reasoning: { effort: 'medium' },
      input: [
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Check the export approval claim.' }],
        },
      ],
      tools: [{ type: 'function', name: TOOL.name, parameters: TOOL.parameters, strict: true }],
    });
    expect(result).toMatchObject({
      text: 'The evidence is insufficient.',
      toolCalls: [],
      usage: { inputTokens: 50, outputTokens: 12 },
    });
    expect(result.state).toHaveLength(2);
    expect(JSON.stringify(provider)).not.toContain(TEST_KEY);
    expect(mock.requests[0]?.init.body).not.toContain(TEST_KEY);
  });

  it('maps the provider-neutral strict schema and explicit generation limits to Responses', async () => {
    const schema = {
      type: 'object',
      properties: { verdict: { type: 'string' } },
      required: ['verdict'],
      additionalProperties: false,
    };
    const mock = transport(reply([message('{"verdict":"insufficient_evidence"}')]));
    const provider = new MetaResponsesProvider({ apiKey: TEST_KEY, fetch: mock.fetch });
    await provider.complete(
      request({
        outputFormat: { name: 'finding_v1', schema },
        maxOutputTokens: 1024,
        reasoningEffort: 'high',
      }),
    );
    expect(bodyAt(mock, 0)).toMatchObject({
      text: { format: { type: 'json_schema', name: 'finding_v1', schema, strict: true } },
      max_output_tokens: 1024,
      reasoning: { effort: 'high' },
    });
    expect(bodyAt(mock, 0)).not.toHaveProperty('response_format');
  });

  it.each([
    { type: 'object' },
    {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: [],
      additionalProperties: false,
    },
    { type: 'object', properties: {}, required: [], additionalProperties: true },
    {
      type: 'object',
      properties: { id: { oneOf: [{ type: 'string' }, { type: 'null' }] } },
      required: ['id'],
      additionalProperties: false,
    },
  ] as JsonObject[])(
    'rejects incompatible strict tool and output schemas before any provider request',
    async (schema) => {
      for (const surface of ['tool', 'output'] as const) {
        const mock = transport();
        const provider = new MetaResponsesProvider({ apiKey: TEST_KEY, fetch: mock.fetch });
        await expect(
          provider.complete(
            request(
              surface === 'tool'
                ? { tools: [{ ...TOOL, parameters: schema }] }
                : { outputFormat: { name: 'invalid_schema', schema } },
            ),
          ),
        ).rejects.toMatchObject({ code: 'MODEL_REQUEST_INVALID' });
        expect(mock.fetch).not.toHaveBeenCalled();
      }
    },
  );

  it('keeps nested alternatives valid under strict mode and allows an explicitly closed empty tool', async () => {
    const mock = transport(reply());
    const provider = new MetaResponsesProvider({ apiKey: TEST_KEY, fetch: mock.fetch });
    await provider.complete(
      request({
        tools: [
          {
            name: 'inspect',
            description: 'Read only.',
            parameters: {
              type: 'object',
              properties: {},
              required: [],
              additionalProperties: false,
            },
          },
        ],
        outputFormat: {
          name: 'nullable_result',
          schema: {
            type: 'object',
            properties: { result: { anyOf: [{ type: 'string' }, { type: 'null' }] } },
            required: ['result'],
            additionalProperties: false,
          },
        },
      }),
    );
    expect(bodyAt(mock, 0)['tools']).toEqual([
      {
        type: 'function',
        name: 'inspect',
        description: 'Read only.',
        parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
        strict: true,
      },
    ]);
  });

  it('retains usage on output truncation without exposing partial text or dispatching partial calls', async () => {
    const mock = transport(
      reply([call({ status: 'incomplete', arguments: '{"id":' })], {
        status: 'incomplete',
        incomplete_details: { reason: 'max_output_tokens' },
      }),
    );
    const provider = new MetaResponsesProvider({ apiKey: TEST_KEY, fetch: mock.fetch });
    const result = await provider.complete(request());
    expect(result).toMatchObject({
      text: '',
      toolCalls: [],
      finishReason: 'output_limit',
      usage: { inputTokens: 50, outputTokens: 12 },
    });
    expect(result.state).toHaveLength(1);
  });

  it('returns a typed refusal instead of presenting refusal text as finding JSON', async () => {
    const mock = transport(
      reply([
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'refusal', refusal: 'Cannot assess this request.' }],
        },
      ]),
    );
    const provider = new MetaResponsesProvider({ apiKey: TEST_KEY, fetch: mock.fetch });
    expect(await provider.complete(request())).toMatchObject({
      text: '',
      toolCalls: [],
      finishReason: 'refused',
    });
  });

  it.each([0, 15, 32_769, Number.POSITIVE_INFINITY])(
    'rejects invalid output token limit %s before dispatch',
    async (maxOutputTokens) => {
      const mock = transport();
      const provider = new MetaResponsesProvider({ apiKey: TEST_KEY, fetch: mock.fetch });
      await expect(provider.complete(request({ maxOutputTokens }))).rejects.toMatchObject({
        code: 'MODEL_REQUEST_INVALID',
      });
      expect(mock.fetch).not.toHaveBeenCalled();
    },
  );

  it('replays full opaque output, encrypted reasoning and commentary with matched call IDs', async () => {
    const reasoning: JsonValue = {
      type: 'reasoning',
      id: 'rs-1',
      summary: [],
      encrypted_content: 'opaque-encrypted-test-state',
      provider_extension: { version: 7 },
    };
    const commentary: JsonValue = {
      type: 'message',
      role: 'assistant',
      phase: 'commentary',
      id: 'comment-1',
      content: [
        {
          type: 'output_text',
          text: 'Checking the policy.',
          annotations: [{ type: 'test-extension' }],
        },
      ],
    };
    const toolCall = call({ provider_extension: 'retain-this' });
    const mock = transport(
      reply([reasoning, commentary, toolCall]),
      reply([message('The claim is contradicted.')], { usage: null }),
    );
    const provider = new MetaResponsesProvider({ apiKey: TEST_KEY, fetch: mock.fetch });
    const first = await provider.complete(request());
    expect(first.text).toBe('');
    expect(first.toolCalls).toEqual([
      { id: 'call-1', name: TOOL.name, arguments: { id: 'policy' } },
    ]);
    expect(first.state.slice(1)).toEqual([reasoning, commentary, toolCall]);
    const second = await provider.complete(
      request({
        state: first.state,
        input: [
          {
            type: 'tool-result',
            callId: 'call-1',
            output: { evidenceId: 'policy', text: 'Approval is required.' },
          },
        ],
      }),
    );
    const expectedInput = [
      ...first.state,
      {
        type: 'function_call_output',
        call_id: 'call-1',
        output: JSON.stringify({ evidenceId: 'policy', text: 'Approval is required.' }),
      },
    ];
    expect(bodyAt(mock, 1)['input']).toEqual(expectedInput);
    expect(bodyAt(mock, 1)).not.toHaveProperty('previous_response_id');
    expect(second.state).toEqual([...expectedInput, message('The claim is contradicted.')]);
    expect(second.usage).toBeUndefined();
  });

  it('accepts distinct calls while exposing only declared tools', async () => {
    const mock = transport(
      reply([call(), call({ id: 'fc-item-2', call_id: 'call-2', arguments: '{"id":"runtime"}' })]),
    );
    const provider = new MetaResponsesProvider({ apiKey: TEST_KEY, fetch: mock.fetch });
    const result = await provider.complete(request());
    expect(result.toolCalls.map((entry) => entry.id)).toEqual(['call-1', 'call-2']);
  });

  it.each([
    ['missing output', { status: 'completed' }],
    ['incomplete status', { status: 'incomplete', output: [message()] }],
    ['failure envelope', { status: 'failed', output: [], error: { message: TEST_KEY } }],
    ['non-array output', { status: 'completed', output: 'not-an-array' }],
    ['malformed argument JSON', { status: 'completed', output: [call({ arguments: '{bad}' })] }],
    ['array arguments', { status: 'completed', output: [call({ arguments: '[]' })] }],
    ['null arguments', { status: 'completed', output: [call({ arguments: 'null' })] }],
    ['primitive arguments', { status: 'completed', output: [call({ arguments: '1' })] }],
    ['unknown tool', { status: 'completed', output: [call({ name: 'run_shell' })] }],
    [
      'duplicate call ID',
      { status: 'completed', output: [call(), call({ id: 'different-item' })] },
    ],
    ['empty call ID', { status: 'completed', output: [call({ call_id: '' })] }],
    ['oversized call ID', { status: 'completed', output: [call({ call_id: 'x'.repeat(65) })] }],
    ['unfinished call', { status: 'completed', output: [call({ status: 'in_progress' })] }],
    ['invalid tool name', { status: 'completed', output: [call({ name: 'a.b.c' })] }],
    [
      'missing encrypted reasoning',
      { status: 'completed', output: [{ type: 'reasoning', summary: [] }, message()] },
    ],
    [
      'malformed message content',
      {
        status: 'completed',
        output: [
          { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 42 }] },
        ],
      },
    ],
    [
      'unexpected output type',
      { status: 'completed', output: [{ type: 'custom_tool_call', name: 'run_shell' }] },
    ],
    [
      'reasoning-only result',
      {
        status: 'completed',
        output: [{ type: 'reasoning', summary: [], encrypted_content: 'opaque' }],
      },
    ],
    [
      'negative usage',
      { status: 'completed', output: [message()], usage: { input_tokens: -1, output_tokens: 1 } },
    ],
    ['different model', { status: 'completed', model: 'unrequested-model', output: [message()] }],
  ])('rejects %s without exposing response content', async (_label, payload) => {
    const mock = transport(jsonResponse(payload));
    const provider = new MetaResponsesProvider({ apiKey: TEST_KEY, fetch: mock.fetch });
    await expect(provider.complete(request())).rejects.toMatchObject({
      code: 'MODEL_RESPONSE_INVALID',
    });
    expect(mock.fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    'http://api.meta.ai/v1',
    'http://127.0.0.1:1234/v1',
    'ftp://example.test/v1',
    'https://user:secret@example.test/v1',
    'https://example.test/v1?key=secret',
    'https://example.test/v1#secret',
    'https://example.test/v1?',
    ' https://example.test/v1',
    'https://example.test\\@localhost/v1',
  ])('rejects unsafe base URL configuration', (baseUrl) => {
    expect(() => new MetaResponsesProvider({ apiKey: TEST_KEY, baseUrl })).toThrowError(
      InvestigatorError,
    );
  });

  it('allows loopback HTTP only through an explicit option and normalizes its path', async () => {
    const mock = transport(reply());
    const provider = new MetaResponsesProvider({
      apiKey: TEST_KEY,
      baseUrl: 'http://127.0.0.1:1234/v1/',
      allowLoopbackHttp: true,
      fetch: mock.fetch,
    });
    await provider.complete(request());
    expect(mock.requests[0]?.url).toBe('http://127.0.0.1:1234/v1/responses');
    expect(
      () =>
        new MetaResponsesProvider({
          apiKey: TEST_KEY,
          baseUrl: 'http://other.test/v1',
          allowLoopbackHttp: true,
        }),
    ).toThrowError(InvestigatorError);
  });

  it('supports an explicit permitted model and HTTPS base URL', async () => {
    const mock = transport(reply([message()], { model: 'muse-spark-1.3' }));
    const provider = new MetaResponsesProvider({
      apiKey: TEST_KEY,
      model: 'muse-spark-1.3',
      baseUrl: 'https://model.example.test/api/',
      fetch: mock.fetch,
    });
    await provider.complete(request());
    expect(bodyAt(mock, 0)['model']).toBe('muse-spark-1.3');
    expect(mock.requests[0]?.url).toBe('https://model.example.test/api/responses');
  });

  it.each(['', 'key with spaces', 'key\nAuthorization: leaked'])(
    'rejects invalid credentials with a fixed error',
    (apiKey) => {
      try {
        new MetaResponsesProvider({ apiKey });
        throw new Error('Expected rejection.');
      } catch (error: unknown) {
        expect(error).toBeInstanceOf(InvestigatorError);
        expect(publicError(error)).toEqual({
          code: 'MODEL_CONFIG_INVALID',
          message: 'The model provider configuration is invalid.',
        });
      }
    },
  );

  it.each([
    { state: [], input: [{ type: 'tool-result', callId: 'unmatched', output: {} }] },
    { state: [call()], input: [] },
    {
      state: [call()],
      input: [
        { type: 'tool-result', callId: 'call-1', output: {} },
        { type: 'tool-result', callId: 'call-1', output: {} },
      ],
    },
    { state: [call(), call()], input: [{ type: 'tool-result', callId: 'call-1', output: {} }] },
  ] satisfies Partial<ModelRequest>[])(
    'rejects unmatched/duplicate continuation results before transport',
    async (overrides) => {
      const mock = transport();
      const provider = new MetaResponsesProvider({ apiKey: TEST_KEY, fetch: mock.fetch });
      await expect(provider.complete(request(overrides))).rejects.toMatchObject({
        code: 'MODEL_REQUEST_INVALID',
      });
      expect(mock.fetch).not.toHaveBeenCalled();
    },
  );

  it('rejects reusing a call ID from an earlier completed turn', async () => {
    const mock = transport(reply([call()]));
    const provider = new MetaResponsesProvider({ apiKey: TEST_KEY, fetch: mock.fetch });
    await expect(
      provider.complete(
        request({
          state: [call(), { type: 'function_call_output', call_id: 'call-1', output: '{}' }],
          input: [],
        }),
      ),
    ).rejects.toMatchObject({ code: 'MODEL_RESPONSE_INVALID' });
  });

  it('does not follow a redirect or expose a redirect target/body', async () => {
    const secret = `${TEST_KEY} https://sensitive.example.test/private`;
    const mock = transport(
      new Response(secret, {
        status: 302,
        headers: { Location: 'https://sensitive.example.test/private' },
      }),
    );
    const provider = new MetaResponsesProvider({ apiKey: TEST_KEY, fetch: mock.fetch });
    try {
      await provider.complete(request());
      throw new Error('Expected rejection.');
    } catch (error: unknown) {
      expect(publicError(error)).toEqual({
        code: 'MODEL_REDIRECT_REJECTED',
        message: 'The model endpoint attempted an unsupported redirect.',
      });
      expect(String(error)).not.toContain(secret);
    }
    expect(mock.fetch).toHaveBeenCalledTimes(1);
  });

  it.each([401, 429, 500])(
    'does not retry HTTP %s or expose an upstream error body',
    async (status) => {
      const mock = transport(new Response(`${TEST_KEY} upstream-private-payload`, { status }));
      const provider = new MetaResponsesProvider({ apiKey: TEST_KEY, fetch: mock.fetch });
      await expect(provider.complete(request())).rejects.toMatchObject({
        code: 'MODEL_HTTP_ERROR',
        message: 'The model service rejected the request.',
      });
      expect(mock.fetch).toHaveBeenCalledTimes(1);
    },
  );

  it('sanitizes thrown transport errors even if they use the application error class', async () => {
    const mock = vi.fn<typeof globalThis.fetch>(async () => {
      throw new InvestigatorError('PRIVATE', `${TEST_KEY} https://private.example.test`);
    });
    const provider = new MetaResponsesProvider({ apiKey: TEST_KEY, fetch: mock });
    try {
      await provider.complete(request());
      throw new Error('Expected rejection.');
    } catch (error: unknown) {
      expect(publicError(error)).toEqual({
        code: 'MODEL_REQUEST_FAILED',
        message: 'The model request failed.',
      });
      expect(String(error)).not.toContain(TEST_KEY);
      expect(error).not.toHaveProperty('cause');
    }
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it('bounds both declared and actual streamed response bytes', async () => {
    let streamCancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(65).fill(97));
      },
      cancel() {
        streamCancelled = true;
      },
    });
    const mock = transport(
      new Response('private', {
        headers: { 'Content-Type': 'application/json', 'Content-Length': '99999' },
      }),
      new Response(body, { headers: { 'Content-Type': 'application/json' } }),
    );
    const provider = new MetaResponsesProvider({
      apiKey: TEST_KEY,
      fetch: mock.fetch,
      maxResponseBytes: 64,
    });
    await expect(provider.complete(request())).rejects.toMatchObject({
      code: 'MODEL_RESPONSE_TOO_LARGE',
    });
    await expect(provider.complete(request())).rejects.toMatchObject({
      code: 'MODEL_RESPONSE_TOO_LARGE',
    });
    expect(streamCancelled).toBe(true);
  });

  it.each([
    () => new Response('{bad-json}', { headers: { 'Content-Type': 'application/json' } }),
    () => new Response(new Uint8Array([0xff]), { headers: { 'Content-Type': 'application/json' } }),
    () => new Response('private HTML response', { headers: { 'Content-Type': 'text/html' } }),
  ])('rejects malformed JSON, invalid UTF-8 and non-JSON responses', async (response) => {
    const mock = transport(response());
    const provider = new MetaResponsesProvider({ apiKey: TEST_KEY, fetch: mock.fetch });
    await expect(provider.complete(request())).rejects.toMatchObject({
      code: 'MODEL_RESPONSE_INVALID',
    });
  });

  it('does not dispatch an already cancelled request', async () => {
    const controller = new AbortController();
    controller.abort(`${TEST_KEY} private cancellation reason`);
    const mock = transport();
    const provider = new MetaResponsesProvider({ apiKey: TEST_KEY, fetch: mock.fetch });
    await expect(provider.complete(request({ signal: controller.signal }))).rejects.toMatchObject({
      code: 'MODEL_CANCELLED',
      message: 'The model request was cancelled.',
    });
    expect(mock.fetch).not.toHaveBeenCalled();
  });

  it('cancels an in-flight transport even when it ignores its signal', async () => {
    const controller = new AbortController();
    const mock = vi.fn<typeof globalThis.fetch>(() => new Promise<Response>(() => undefined));
    const provider = new MetaResponsesProvider({ apiKey: TEST_KEY, fetch: mock });
    const pending = provider.complete(request({ signal: controller.signal }));
    controller.abort(TEST_KEY);
    await expect(pending).rejects.toMatchObject({
      code: 'MODEL_CANCELLED',
      message: 'The model request was cancelled.',
    });
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it('enforces a finite timeout for a stalled response body', async () => {
    vi.useFakeTimers();
    try {
      let bodyCancelled = false;
      const body = new ReadableStream<Uint8Array>({
        cancel() {
          bodyCancelled = true;
        },
      });
      const mock = transport(
        new Response(body, { headers: { 'Content-Type': 'application/json' } }),
      );
      const provider = new MetaResponsesProvider({
        apiKey: TEST_KEY,
        fetch: mock.fetch,
        timeoutMs: 10,
      });
      const assertion = expect(provider.complete(request())).rejects.toMatchObject({
        code: 'MODEL_TIMEOUT',
        message: 'The model request exceeded its time limit.',
      });
      await vi.advanceTimersByTimeAsync(11);
      await assertion;
      expect(bodyCancelled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
