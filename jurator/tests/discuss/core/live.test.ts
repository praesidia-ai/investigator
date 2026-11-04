// DS-A: the session through the real Meta Responses provider with a fake transport (never the network).
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DISCUSS_TOOL_NAMES, type DiscussEvent, type DiscussSession } from '../../../src/discuss/contract.js';
import { openSession } from '../../../src/discuss/core/session.js';
import { toolDefinitions } from '../../../src/discuss/tools/index.js';
import { assertStrictMetaSchema } from '../../../src/model/meta/strict-schema.js';
import { cleanup, collect, makeRepo, makeWorkspace, tempDir, writeFiles } from './helpers.js';

const dirs: string[] = [];
const sessions: DiscussSession[] = [];
afterEach(async () => {
  for (const s of sessions.splice(0)) await s.close();
  cleanup(...dirs.splice(0));
});

function respond(output: unknown[], model = 'muse-wonder-1.0', usage = { input_tokens: 4000, output_tokens: 200 }): Response {
  return new Response(JSON.stringify({ id: 'r', status: 'completed', model, output, usage }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
const call = (id: string, name: string, args: Record<string, unknown>) => ({ type: 'function_call', call_id: id, name, arguments: JSON.stringify(args), status: 'completed' });
const say = (text: string) => ({ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text }] });

function transport(...responses: Response[]) {
  const bodies: Array<Record<string, unknown>> = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    const next = responses.shift();
    if (!next) throw new Error('unexpected call');
    return next;
  });
  return { fetch, bodies };
}

describe('discuss tools in Meta strict mode', () => {
  it('every tool schema passes the strict check and the list is the read-only ten', () => {
    const defs = toolDefinitions();
    expect(defs.map((d) => d.name)).toEqual([...DISCUSS_TOOL_NAMES]);
    for (const d of defs) expect(() => assertStrictMetaSchema(d.parameters, 'tool')).not.toThrow();
  });
});

describe('a live turn (fake transport)', () => {
  it('sends tools with parallel calls, returns both results, and continues from the provider state', async () => {
    const { root, commit } = makeWorkspace();
    dirs.push(root);
    const { fetch, bodies } = transport(
      respond([
        { type: 'reasoning', summary: [], encrypted_content: 'opaque-1' },
        call('c1', 'search_code', { query: 'CHAT_TTL_DAYS', regex: null, glob: null, caseSensitive: null }),
        call('c2', 'read_lines', { path: 'src/config.ts', start: 2, end: 2 }),
      ]),
      respond([say('Chats are kept 90 days [[src/config.ts:2]].')]),
      respond([say('Spark here.')], 'muse-spark-1.3'),
    );
    const session = await openSession({ cwd: root, env: { META_API_KEY: 'test-only-key' } }, { fetch });
    sessions.push(session);
    const events = await collect(session, 'how long are chats kept?');
    expect(events.filter((e) => e.type === 'tool-result').map((e) => e.type === 'tool-result' && e.ok)).toEqual([true, true]);
    const evidence = events.find((e): e is Extract<DiscussEvent, { type: 'evidence' }> => e.type === 'evidence');
    expect(evidence?.citations).toEqual([{ path: 'src/config.ts', commit, startLine: 2, endLine: 2, quote: 'export const CHAT_TTL_DAYS = 90;' }]);
    expect(events[events.length - 1]).toMatchObject({ type: 'done', reason: 'answered' });

    const first = bodies[0] as Record<string, unknown>;
    expect(first).toMatchObject({ model: 'muse-wonder-1.0', store: false, parallel_tool_calls: true, tool_choice: 'auto', stream: false });
    expect((first['tools'] as Array<{ name: string; strict: boolean }>).map((t) => [t.name, t.strict])).toEqual(DISCUSS_TOOL_NAMES.map((n) => [n, true]));
    const second = bodies[1] as { input: Array<Record<string, unknown>> };
    const outputs = second.input.filter((i) => i['type'] === 'function_call_output');
    expect(outputs.map((o) => o['call_id'])).toEqual(['c1', 'c2']);
    expect(String(outputs[1]?.['output'])).toContain('2  export const CHAT_TTL_DAYS = 90;');
    expect(second.input.some((i) => i['type'] === 'reasoning')).toBe(true);

    // switching the model keeps the conversation but drops the old model's reasoning state
    expect(await session.slash('/model spark')).toMatchObject({ changed: true });
    await collect(session, 'and now?');
    const third = bodies[2] as { model: string; input: Array<Record<string, unknown>> };
    expect(third.model).toBe('muse-spark-1.3');
    expect(third.input.some((i) => i['type'] === 'reasoning')).toBe(false);
    expect(third.input.filter((i) => i['type'] === 'function_call_output')).toHaveLength(2);
    expect(JSON.stringify(bodies)).not.toContain('sk_live_');
    expect(session.info().spentUsd).toBeGreaterThan(0);
  });
});

describe('a multi-repo workspace', () => {
  it('searches every repo and reads repo-prefixed paths at the composite snapshot', async () => {
    const root = tempDir();
    dirs.push(root);
    makeRepo(join(root, 'api'), { 'app/upload.py': 'def upload(doc):\n    s3.put_object(Bucket="docs", Body=doc)\n' });
    makeRepo(join(root, 'web'), { 'src/save.ts': 'await chrome.storage.local.set({ draft });\n' });
    writeFiles(root, {
      '.jurator/config.json': JSON.stringify({
        schemaVersion: 1,
        sources: [],
        failMode: 'block',
        codeScope: ['src/**'],
        model: { id: 'muse-spark-1.3' },
        budgetUsdPerRun: 10,
        repos: [
          { name: 'api', path: 'api' },
          { name: 'web', path: 'web' },
        ],
      }),
    });
    const script = join(tempDir('ds-a-script-'), 'r');
    dirs.push(join(script, '..'));
    writeFiles(script, {
      '1-1.json': JSON.stringify({ toolCalls: [{ name: 'search_code', arguments: { query: 'put_object|storage', regex: true } }] }),
      '1-2.json': JSON.stringify({ toolCalls: [{ name: 'list_files', arguments: { globs: ['*.py'] } }] }),
      '1-3.json': JSON.stringify({ text: 'Uploads go to S3 [[api/app/upload.py:2]].' }),
    });
    const session = await openSession({ cwd: join(root, 'web'), env: {}, scriptedDir: script });
    sessions.push(session);
    const info = session.info();
    expect(info.model).toBe('spark');
    expect(info.repos.map((r) => r.name)).toEqual(['api', 'web']);
    const events = await collect(session, 'where do documents go?');
    const results = events.filter((e): e is Extract<DiscussEvent, { type: 'tool-result' }> => e.type === 'tool-result');
    expect(results[0]?.summary).toBe('2 hits in 2 files');
    // hits in the configured code scope (src/** in every repo) come first
    expect(results[0]?.evidence?.map((c) => `${c.path}:${c.startLine}`)).toEqual(['web/src/save.ts:1', 'api/app/upload.py:2']);
    expect(results[1]?.summary).toBe('1 file');
    const evidence = events.find((e): e is Extract<DiscussEvent, { type: 'evidence' }> => e.type === 'evidence');
    expect(evidence?.citations[0]).toMatchObject({ path: 'api/app/upload.py', startLine: 2, commit: info.snapshot.commit });
    expect(evidence?.citations[0]?.quote).toBe('    s3.put_object(Bucket="docs", Body=doc)');
  });
});
