import { describe, expect, it } from 'vitest';
import { runCancellationWorkflow } from '../src/cancellation/workflow.js';
import type { JsonValue } from '../src/core/json.js';
import { MetaResponsesProvider } from '../src/providers/meta-responses.js';
import type { ModelInput } from '../src/providers/model-provider.js';
import { ScriptedCancellationProvider } from '../src/providers/scripted-cancellation.js';

const TEST_KEY = 'test-key-not-a-secret';

/**
 * A fake Responses endpoint: it replays the scripted reference's batched tool calls as real
 * `function_call` items, so the real MetaResponsesProvider and host loop see Wonder-shaped turns.
 */
function batchedEndpoint(log: { bodies: Record<string, JsonValue>[]; batchSizes: number[] }) {
  const scripted = new ScriptedCancellationProvider();
  const seen = new Set<string>();
  const fetch: typeof globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, JsonValue>;
    log.bodies.push(body);
    const fresh: ModelInput[] = [];
    let first = true;
    for (const raw of body['input'] as JsonValue[]) {
      const item = raw as Record<string, JsonValue>;
      if (item['type'] === 'message' && item['role'] === 'user' && first) {
        first = false;
        continue;
      }
      if (item['type'] === 'function_call_output' && !seen.has(String(item['call_id']))) {
        seen.add(String(item['call_id']));
        fresh.push({
          type: 'tool-result',
          callId: String(item['call_id']),
          output: JSON.parse(String(item['output'])) as JsonValue,
        });
      }
    }
    const next = await scripted.complete({
      instructions: '',
      input: fresh,
      tools: [],
      signal: new AbortController().signal,
    });
    log.batchSizes.push(next.toolCalls.length);
    const output: JsonValue[] = next.toolCalls.length
      ? next.toolCalls.map((call) => ({
          type: 'function_call',
          call_id: call.id,
          name: call.name,
          arguments: JSON.stringify(call.arguments),
          status: 'completed',
        }))
      : [
          {
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: next.text }],
          },
        ];
    return new Response(
      JSON.stringify({
        status: 'completed',
        model: 'muse-wonder-1.0',
        output,
        usage: { input_tokens: 1000, output_tokens: 50 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };
  return fetch;
}

describe('live-shaped batched investigation', () => {
  it('sends parallel_tool_calls only when the request opts in', async () => {
    const bodies: Record<string, JsonValue>[] = [];
    const fetch: typeof globalThis.fetch = async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, JsonValue>);
      return new Response(
        JSON.stringify({
          status: 'completed',
          output: [
            {
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text: 'done' }],
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };
    const provider = new MetaResponsesProvider({ apiKey: TEST_KEY, fetch });
    const base = {
      instructions: 'x',
      input: [{ type: 'message' as const, role: 'user' as const, content: 'hi' }],
      tools: [],
      signal: new AbortController().signal,
    };
    await provider.complete(base);
    await provider.complete({ ...base, parallelToolCalls: true });
    expect(bodies[0]!['parallel_tool_calls']).toBe(false);
    expect(bodies[1]!['parallel_tool_calls']).toBe(true);
  });

  it('closes the gap with batched function calls through the real provider', async () => {
    const logs: { bodies: Record<string, JsonValue>[]; batchSizes: number[] }[] = [];
    const report = await runCancellationWorkflow({
      mode: 'cached-worker',
      providerFactory: () => {
        const log = { bodies: [], batchSizes: [] };
        logs.push(log);
        return new MetaResponsesProvider({ apiKey: TEST_KEY, fetch: batchedEndpoint(log) });
      },
    });
    expect(report.before.provider.mode).toBe('live');
    expect(report.before.status).toBe('completed');
    expect(report.before.validation).toEqual({ accepted: true, issues: [] });
    expect(report.repair.status).toBe('applied');
    expect(report.after?.finding?.verdict).toBe('supported');
    expect(report.verification.closedGap).toBe(true);
    expect(logs).toHaveLength(2);
    for (const log of logs) {
      expect(log.bodies.every((body) => body['parallel_tool_calls'] === true)).toBe(true);
      expect(log.bodies.length).toBeLessThanOrEqual(4);
      expect(Math.max(...log.batchSizes)).toBeGreaterThanOrEqual(4);
    }
    expect(report.before.events.length).toBeLessThanOrEqual(12);
    expect(report.after!.events.length).toBeLessThanOrEqual(24);
  }, 60_000);
});
