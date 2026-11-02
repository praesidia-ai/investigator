import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { MetaResponsesProvider } from '../src/providers/meta-responses.js';

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
  });
}

describe('Responses protocol over real loopback HTTP', () => {
  it('performs a native HTTP tool-call round trip with opaque continuation and no server storage', async () => {
    const requests: Record<string, unknown>[] = [];
    const headers: (string | undefined)[] = [];
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array));
      requests.push(JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>);
      headers.push(request.headers.authorization);
      response.setHeader('content-type', 'application/json');
      response.end(
        JSON.stringify({
          status: 'completed',
          model: 'test-model',
          output:
            requests.length === 1
              ? [
                  { type: 'reasoning', summary: [], encrypted_content: 'opaque-test-continuation' },
                  {
                    type: 'function_call',
                    call_id: 'tool-1',
                    name: 'get_control',
                    arguments: '{}',
                  },
                ]
              : [
                  {
                    type: 'message',
                    role: 'assistant',
                    content: [{ type: 'output_text', text: 'Round trip complete.' }],
                  },
                ],
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
      );
    });
    try {
      const port = await listen(server);
      const provider = new MetaResponsesProvider({
        apiKey: 'synthetic-local-key',
        model: 'test-model',
        baseUrl: `http://127.0.0.1:${port}/v1`,
        allowLoopbackHttp: true,
      });
      const tools = [
        {
          name: 'get_control',
          description: 'Read test control',
          parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
        },
      ];
      const first = await provider.complete({
        instructions: 'Use the declared tool.',
        input: [{ type: 'message', role: 'user', content: 'Read this case.' }],
        tools,
        signal: AbortSignal.timeout(2000),
      });
      expect(first.toolCalls[0]?.id).toBe('tool-1');
      const second = await provider.complete({
        instructions: 'Use the declared tool.',
        state: first.state,
        input: [{ type: 'tool-result', callId: 'tool-1', output: { ok: true } }],
        tools,
        signal: AbortSignal.timeout(2000),
      });
      expect(second.text).toBe('Round trip complete.');
      expect(requests).toHaveLength(2);
      expect(requests.every((body) => body.store === false)).toBe(true);
      expect(JSON.stringify(requests[1])).toContain('opaque-test-continuation');
      expect(JSON.stringify(requests[1])).toContain('function_call_output');
      expect(JSON.stringify(requests)).not.toContain('synthetic-local-key');
      expect(headers).toEqual(['Bearer synthetic-local-key', 'Bearer synthetic-local-key']);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  });
});
