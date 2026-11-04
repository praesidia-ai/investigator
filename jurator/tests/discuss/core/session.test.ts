// DS-A: the discuss core against scripted rounds. No network: every model answer is a recorded file.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DISCUSS_TOOL_NAMES, type DiscussEvent, type DiscussSession } from '../../../src/discuss/contract.js';
import { openDiscussSession } from '../../../src/discuss/core/index.js';
import { openSession } from '../../../src/discuss/core/session.js';
import type { ChatModel, ScriptedChat } from '../../../src/model/chat.js';
import { cleanup, collect, INJECTION, makeRepo, makeWorkspace, tempDir, treeHashes, writeRounds } from './helpers.js';

const dirs: string[] = [];
const sessions: DiscussSession[] = [];
afterEach(async () => {
  for (const s of sessions.splice(0)) await s.close();
  cleanup(...dirs.splice(0));
});

async function open(rounds: Record<string, unknown>, extra: { budgetUsd?: number; save?: boolean } = {}) {
  const { root, commit } = makeWorkspace();
  const script = writeRounds(join(tempDir('ds-a-script-'), 'rounds'), rounds);
  dirs.push(root, join(script, '..'));
  const chats: ChatModel[] = [];
  const session = await openSession(
    { cwd: root, env: {}, scriptedDir: script, now: () => new Date('2026-11-04T11:30:00.000Z'), ...extra },
    { onChat: (c) => chats.push(c) },
  );
  sessions.push(session);
  const requests = () => chats.flatMap((c) => (c as ScriptedChat).requests);
  return { root, commit, session, requests };
}

const types = (events: readonly DiscussEvent[]) => events.map((e) => e.type);
const last = <T,>(xs: readonly T[]): T => xs[xs.length - 1] as T;

describe('a question that searches, reads and cites', () => {
  it('runs search_code and read_lines, and the cited lines are copied from git at the snapshot', async () => {
    const { root, commit, session, requests } = await open({
      '1-1': { toolCalls: [{ name: 'search_code', arguments: { query: 'CHAT_TTL_DAYS' } }], usage: { inputTokens: 5000, outputTokens: 300 } },
      '1-2': { toolCalls: [{ name: 'read_lines', arguments: { path: 'src/config.ts', start: 1, end: 3 } }], usage: { inputTokens: 5600, outputTokens: 200 } },
      '1-3': {
        text: 'Support chats are kept 90 days [[src/config.ts:2]]; privacy.01 is BROKEN (rule, no AI). To re-check after a fix: `jurator check`.',
        usage: { inputTokens: 6000, outputTokens: 150 },
      },
    });
    const events = await collect(session, 'how long are support chats kept?');
    expect(types(events)).toEqual([
      'turn-start',
      'thinking', 'tool-call', 'tool-result', 'usage',
      'thinking', 'tool-call', 'tool-result', 'usage',
      'thinking', 'usage', 'text', 'evidence', 'done',
    ]);
    const calls = events.filter((e) => e.type === 'tool-call');
    expect(calls.map((c) => c.type === 'tool-call' && c.label)).toEqual(['search_code "CHAT_TTL_DAYS"', 'read_lines src/config.ts:1-3']);
    const results = events.filter((e): e is Extract<DiscussEvent, { type: 'tool-result' }> => e.type === 'tool-result');
    expect(results[0]?.ok).toBe(true);
    expect(results[0]?.summary).toBe('2 hits in 2 files');
    const read = results[1];
    expect(read?.summary).toBe('3 lines');
    expect(read?.evidence?.[0]).toMatchObject({ path: 'src/config.ts', commit, startLine: 1, endLine: 3 });
    // the secret on line 3 is masked in the evidence and in everything the model was sent
    expect(read?.evidence?.[0]?.quote).toContain('STRIPE_KEY = "[masked]"');
    expect(JSON.stringify(requests())).not.toContain('sk_live_');
    expect(JSON.stringify(events)).not.toContain('sk_live_');

    const evidence = events.find((e) => e.type === 'evidence');
    expect(evidence).toEqual({
      type: 'evidence',
      turn: 1,
      citations: [{ path: 'src/config.ts', commit, startLine: 2, endLine: 2, quote: 'export const CHAT_TTL_DAYS = 90;' }],
      policy: [],
      unresolved: [],
    });
    const done = last(events);
    expect(done).toMatchObject({ type: 'done', turn: 1, reason: 'answered' });
    // usd: wonder at $4 in / $20 out per million
    const usd = (5000 + 5600 + 6000) * 4e-6 + (300 + 200 + 150) * 20e-6;
    expect(done.type === 'done' && done.usd).toBeCloseTo(usd, 6);
    expect(session.info()).toMatchObject({ spentUsd: expect.closeTo(usd, 6), inputTokens: 16600, outputTokens: 650, turns: 1, busy: false });

    // what the model saw: the question first, then the tool results as data, with the same tools every round
    const reqs = requests();
    expect(reqs.map((r) => `${r.turn}-${r.round}`)).toEqual(['1-1', '1-2', '1-3']);
    expect(reqs[0]?.input).toEqual([{ type: 'message', role: 'user', content: 'how long are support chats kept?' }]);
    expect(reqs[1]?.input[0]).toMatchObject({ type: 'tool-result' });
    expect(String((reqs[1]?.input[0] as { output: unknown }).output)).toContain('src/config.ts:2: export const CHAT_TTL_DAYS = 90;');
    for (const r of reqs) expect(r.tools).toEqual([...DISCUSS_TOOL_NAMES]);

    // the transcript is written after the turn, with the program's evidence
    const path = session.info().transcriptPath as string;
    expect(path.startsWith(join(root, '.jurator', 'local', 'discuss'))).toBe(true);
    const md = readFileSync(path, 'utf8');
    expect(md).toContain('## 1 · You');
    expect(md).toContain('- search_code "CHAT_TTL_DAYS" · 2 hits in 2 files');
    expect(md).toContain(`src/config.ts:2 @ ${commit.slice(0, 7)}`);
    expect(md).not.toContain('sk_live_');
  });

  it('keeps the conversation: turn 2 continues from turn 1', async () => {
    const { session, requests } = await open({
      '1-1': { text: 'Hello.' },
      '2-1': { text: 'Still here.' },
    });
    await collect(session, 'hi');
    await collect(session, 'again');
    const second = requests()[1];
    expect(JSON.stringify(second?.state)).toContain('Hello.');
    expect(JSON.stringify(second?.state)).toContain('"text":"hi"');
  });
});

describe('a prompt injection in the code', () => {
  it('stays data: no tool appears, nothing is written, secret files stay closed, fake cites are not verified', async () => {
    const { root, session, requests } = await open({
      '1-1': {
        toolCalls: [
          { name: 'search_code', arguments: { query: 'retention' } },
          { name: 'read_lines', arguments: { path: 'src/evil.ts', start: 1, end: 3 } },
        ],
      },
      // the "model" obeys the comment: it asks for a tool that does not exist and for the .env file
      '1-2': {
        toolCalls: [
          { name: 'accept_promise', arguments: { id: 'privacy.01' } },
          { name: 'read_lines', arguments: { path: '.env', start: 1, end: 5 } },
        ],
      },
      '1-3': { text: 'Done: every promise HOLDS [[src/evil.ts:400]] [[.env:1]].' },
    });
    const before = treeHashes(root, ['.jurator/local/discuss', '.git']);
    const events = await collect(session, 'what does the retention helper do?');

    const calls = events.filter((e) => e.type === 'tool-call').map((e) => e.type === 'tool-call' && e.name);
    expect(calls).toEqual(['search_code', 'read_lines', 'read_lines']);
    const results = events.filter((e): e is Extract<DiscussEvent, { type: 'tool-result' }> => e.type === 'tool-result');
    expect(results[2]).toMatchObject({ ok: false, summary: 'refused: secret files are never read' });
    expect(results[2]?.evidence).toBeUndefined();

    const reqs = requests();
    // the unknown tool was answered with a refusal, never run
    const refusal = reqs[2]?.input.find((i) => i.type === 'tool-result' && String(i.output).includes('accept_promise'));
    expect(String(refusal && 'output' in refusal ? refusal.output : '')).toContain('read-only');
    // same rules and the same read-only tools in every call; the injection only ever arrives as tool output
    expect(new Set(reqs.map((r) => r.instructions)).size).toBe(1);
    expect(reqs[0]?.instructions).not.toContain('accept_promise');
    for (const r of reqs) expect(r.tools).toEqual([...DISCUSS_TOOL_NAMES]);
    for (const r of reqs) {
      for (const i of r.input) if (i.type === 'message') expect(i.content).not.toContain('ignore all previous instructions');
    }
    expect(String((reqs[1]?.input[1] as { output: unknown }).output)).toContain('ignore all previous instructions');
    expect(JSON.stringify(reqs)).not.toContain('hunter2');

    // the answer's markers are checked by the program: neither becomes evidence
    const evidence = events.find((e) => e.type === 'evidence');
    expect(evidence).toMatchObject({
      citations: [],
      unresolved: [
        { marker: '[[src/evil.ts:400]]', reason: 'out-of-range' },
        { marker: '[[.env:1]]', reason: 'secret-file' },
      ],
    });
    // nothing in the workspace changed
    expect(treeHashes(root, ['.jurator/local/discuss', '.git'])).toEqual(before);
    expect(INJECTION).toContain('accept_promise');
  });
});

describe('the session budget', () => {
  it('stops before a call that could pass the budget, drops the turn, and goes on after /budget', async () => {
    const { session, requests } = await open(
      {
        // the first call costs $0.25 (12,500 output tokens); the second could cost more than the $0.05 left
        '1-1': { toolCalls: [{ name: 'list_promises', arguments: {} }], usage: { inputTokens: 0, outputTokens: 12500 } },
        '1-2': { text: 'never sent' },
        '2-1': { text: 'Two promises are accepted.' },
      },
      { budgetUsd: 0.3 },
    );
    const events = await collect(session, 'list the promises');
    const error = events.find((e) => e.type === 'error');
    expect(error).toMatchObject({ type: 'error', code: 'BUDGET' });
    expect(error?.type === 'error' && error.next).toMatch(/^\/budget \d+$/u);
    expect(last(events)).toMatchObject({ type: 'done', reason: 'error', usd: 0.25 });
    expect(requests().map((r) => `${r.turn}-${r.round}`)).toEqual(['1-1']);
    expect(session.info()).toMatchObject({ spentUsd: 0.25, budgetUsd: 0.3 });

    expect(await session.slash('/budget 0.1')).toMatchObject({ kind: 'error', code: 'BAD_INPUT' });
    expect(await session.slash('/budget 2')).toEqual({ kind: 'budget', budgetUsd: 2, spentUsd: 0.25, changed: true });
    const again = await collect(session, 'list the promises');
    expect(last(again)).toMatchObject({ type: 'done', turn: 2, reason: 'answered' });
    // the stopped turn is not in the model's history
    expect(requests()[1]?.state).toEqual([]);
    expect(await session.slash('/cost')).toMatchObject({ kind: 'cost', totalUsd: 0.25, budgetUsd: 2, turns: [{ turn: 1, usd: 0.25 }, { turn: 2, usd: 0 }] });
  });
});

describe('cancel and busy', () => {
  it('a cancel ends the turn with done cancelled and drops it from the history', async () => {
    const { session, requests } = await open({
      '1-1': { toolCalls: [{ name: 'last_check', arguments: {} }] },
      '1-2': { text: 'never sent' },
      '2-1': { text: 'ok' },
    });
    const ac = new AbortController();
    const events: DiscussEvent[] = [];
    for await (const e of session.send('which promises are broken?', ac.signal)) {
      events.push(e);
      if (e.type === 'tool-result') ac.abort();
    }
    expect(last(events)).toMatchObject({ type: 'done', reason: 'cancelled' });
    expect(events.filter((e) => e.type === 'done')).toHaveLength(1);
    const next = await collect(session, 'hello');
    expect(last(next)).toMatchObject({ reason: 'answered' });
    expect(requests()[1]?.state).toEqual([]);
    expect(readFileSync(session.info().transcriptPath as string, 'utf8')).toContain('## 1 · Jurator (cancelled)');
  });

  it('a second send while one runs yields BUSY and done', async () => {
    const { session } = await open({ '1-1': { text: 'ok' } });
    const first = session.send('one', new AbortController().signal)[Symbol.asyncIterator]();
    await first.next(); // turn-start: the first turn is now running
    const second = await collect(session, 'two');
    expect(types(second)).toEqual(['error', 'done']);
    expect(second[0]).toMatchObject({ code: 'BUSY' });
    for (let r = await first.next(); !r.done; r = await first.next());
    expect(session.info().busy).toBe(false);
  });

  it('a missing recorded round is SCRIPT_MISSING, not a crash', async () => {
    const { session } = await open({});
    const events = await collect(session, 'hi');
    expect(events.find((e) => e.type === 'error')).toMatchObject({ code: 'SCRIPT_MISSING' });
    expect(last(events)).toMatchObject({ type: 'done', reason: 'error' });
  });
});

describe('slash commands (no model, no cost)', () => {
  it('answers from the record', async () => {
    const { commit, session } = await open({});
    expect(await session.slash('/help')).toMatchObject({ kind: 'help' });
    const promises = await session.slash('/promises');
    expect(promises).toMatchObject({
      kind: 'promises',
      items: [
        { id: 'privacy.01', kind: 'must', rules: 1, bindings: 1, verdict: 'broken' },
        { id: 'privacy.02', kind: 'must-not', rules: 0, bindings: 0, verdict: 'not-checked' },
      ],
    });
    const findings = await session.slash('/findings');
    expect(findings).toMatchObject({ kind: 'findings', run: { stale: false, commit } });
    expect(findings.kind === 'findings' && findings.items[0]).toMatchObject({
      promiseId: 'privacy.01',
      label: 'BROKEN (rule, no AI)',
      citations: [{ path: 'src/config.ts', startLine: 2, quote: 'export const CHAT_TTL_DAYS = 90;' }],
    });
    const explain = await session.slash('/explain privacy.01');
    expect(explain.kind).toBe('explain');
    if (explain.kind === 'explain') {
      expect(explain.detail.policy).toMatchObject({ alias: 'privacy', where: 'docs/privacy.md', startLine: 3, endLine: 3, text: '1. Support chats are deleted after 30 days.' });
      expect(explain.detail.bindings).toEqual([
        { id: 'B-privacy.01-1', symbol: 'CHAT_TTL_DAYS', moved: false, citation: { path: 'src/config.ts', commit, startLine: 2, endLine: 2, quote: 'export const CHAT_TTL_DAYS = 90;' } },
      ]);
      expect(explain.detail.finding?.label).toBe('BROKEN (rule, no AI)');
    }
    expect(await session.slash('/explain nope.01')).toMatchObject({ kind: 'error', code: 'NOT_FOUND' });
    expect(await session.slash('/rule privacy.01')).toMatchObject({ kind: 'rule', promiseId: 'privacy.01', rules: [{ id: 'R-privacy.01-1', provenToFail: true }] });
    expect(await session.slash('/rule privacy.02')).toMatchObject({ kind: 'rule', rules: [], next: 'jurator rule propose privacy.02' });
    expect(await session.slash('/model')).toEqual({ kind: 'model', model: 'wonder', modelId: 'muse-wonder-1.0', changed: false });
    expect(await session.slash('/model spark')).toEqual({ kind: 'model', model: 'spark', modelId: 'muse-spark-1.3', changed: true });
    expect(session.info().modelId).toBe('muse-spark-1.3');
    expect(await session.slash('/model gpt')).toMatchObject({ kind: 'error', code: 'BAD_INPUT' });
    expect(await session.slash('/budget')).toEqual({ kind: 'budget', budgetUsd: 3, spentUsd: 0, changed: false });
    expect(await session.slash('/clear')).toEqual({ kind: 'cleared' });
    const saved = await session.slash('/save');
    expect(saved.kind).toBe('saved');
    expect(saved.kind === 'saved' && existsSync(saved.path)).toBe(true);
    expect(await session.slash('/pro')).toMatchObject({ kind: 'promises' });
    expect(await session.slash('/bogus')).toMatchObject({ kind: 'error', code: 'UNKNOWN_COMMAND' });
    expect(await session.slash('/exit')).toEqual({ kind: 'exit' });
  });

  it('/save says NO_SAVE with --no-save, and no transcript is written', async () => {
    const { session } = await open({ '1-1': { text: 'ok' } }, { save: false });
    await collect(session, 'hi');
    expect(session.info().transcriptPath).toBeNull();
    expect(await session.slash('/save')).toMatchObject({ kind: 'error', code: 'NO_SAVE' });
  });
});

describe('opening a session', () => {
  it('throws NO_WORKSPACE outside a workspace and MODEL_KEY_REQUIRED without a key', async () => {
    const plain = tempDir();
    dirs.push(plain);
    makeRepo(plain, { 'a.txt': 'a\n' });
    await expect(openDiscussSession({ cwd: plain, env: {}, scriptedDir: plain })).rejects.toMatchObject({ code: 'NO_WORKSPACE' });
    const { root } = makeWorkspace();
    dirs.push(root);
    await expect(openDiscussSession({ cwd: root, env: {} })).rejects.toMatchObject({ code: 'MODEL_KEY_REQUIRED' });
    await expect(openDiscussSession({ cwd: root, env: {}, scriptedDir: root, budgetUsd: -1 })).rejects.toMatchObject({ code: 'BAD_INPUT' });
    const s = await openDiscussSession({ cwd: root, env: {}, scriptedDir: root });
    sessions.push(s);
    expect(s.info()).toMatchObject({ mode: 'scripted', model: 'wonder', budgetUsd: 3, promises: 2, lastCheck: { broken: 1, stale: false } });
  });
});

describe('limits', () => {
  it('after 12 model calls the last call has no tools and asks for an answer now', async () => {
    const rounds: Record<string, unknown> = {};
    for (let r = 1; r <= 12; r += 1) rounds[`1-${r}`] = { toolCalls: [{ name: 'list_rules', arguments: {} }] };
    rounds['1-13'] = { text: "Can't tell from the rules alone." };
    const { session, requests } = await open(rounds);
    const events = await collect(session, 'loop');
    expect(events.filter((e) => e.type === 'tool-call')).toHaveLength(12);
    const reqs = requests();
    expect(reqs).toHaveLength(13);
    expect(reqs[12]?.tools).toEqual([]);
    const lastInput = reqs[12]?.input[reqs[12].input.length - 1];
    expect(lastInput?.type === 'message' && lastInput.content).toContain('tool limit');
    expect(last(events)).toMatchObject({ reason: 'answered' });
  });

  it('no answer even then is ROUND_LIMIT', async () => {
    const rounds: Record<string, unknown> = {};
    for (let r = 1; r <= 13; r += 1) rounds[`1-${r}`] = { toolCalls: [{ name: 'list_rules', arguments: {} }] };
    const { session } = await open(rounds);
    const events = await collect(session, 'loop');
    expect(events.find((e) => e.type === 'error')).toMatchObject({ code: 'ROUND_LIMIT' });
    expect(last(events)).toMatchObject({ reason: 'error' });
  });

  it('tool results older than two turns shrink to their summary in the history', async () => {
    const { session, requests } = await open({
      '1-1': { toolCalls: [{ name: 'read_lines', arguments: { path: 'src/upload.ts', start: 1, end: 4 } }] },
      '1-2': { text: 'It uploads to S3 [[src/upload.ts:3]].' },
      '2-1': { text: 'two' },
      '3-1': { text: 'three' },
      '4-1': { text: 'four' },
    });
    for (const q of ['one', 'two', 'three', 'four']) await collect(session, q);
    const stateAt = (turn: number) => JSON.stringify(requests().find((r) => r.turn === turn)?.state);
    expect(stateAt(3)).toContain('s3.putObject');
    expect(stateAt(4)).not.toContain('s3.putObject');
    expect(stateAt(4)).toContain('older result, shortened to its summary');
  });

  it('read_lines reads at most 120 lines and says it cut', async () => {
    const { capForModel } = await import('../../../src/discuss/tools/index.js');
    const cut = capForModel('x'.repeat(20_000));
    expect(cut.cut).toBe(true);
    expect(cut.text.length).toBe(12_000);
    expect(cut.text).toContain('[result cut at 12000 characters');
    const { session } = await open({
      '1-1': { toolCalls: [{ name: 'read_lines', arguments: { path: 'src/config.ts', start: 1, end: 500 } }] },
      '1-2': { text: 'ok' },
    });
    const events = await collect(session, 'read');
    const result = events.find((e): e is Extract<DiscussEvent, { type: 'tool-result' }> => e.type === 'tool-result');
    // the file has 3 lines: the end is clamped to the file, not an error
    expect(result).toMatchObject({ ok: true, summary: '3 lines' });
  });
});

describe('list_promises filters', () => {
  it('a placeholder source ("null") lists every promise, an unknown alias names the real ones', async () => {
    const { session } = await open({
      '1-1': { toolCalls: [{ id: 'a', name: 'list_promises', arguments: { source: 'null' } }, { id: 'b', name: 'list_promises', arguments: { source: 'nope' } }] },
      '1-2': { text: 'ok' },
    });
    const events = await collect(session, 'which promises?');
    const calls = events.filter((e): e is Extract<DiscussEvent, { type: 'tool-call' }> => e.type === 'tool-call');
    const results = events.filter((e): e is Extract<DiscussEvent, { type: 'tool-result' }> => e.type === 'tool-result');
    expect(calls[0]?.label).toBe('list_promises');
    expect(results[0]).toMatchObject({ ok: true });
    expect(results[0]?.summary).not.toBe('no promises');
    expect(results[1]).toMatchObject({ ok: false, summary: 'no source nope' });
  });
});

describe('search ranking', () => {
  it('puts the configured code first and tests, docs and lock files last', async () => {
    const { hitRank } = await import('../../../src/discuss/tools/code-reader.js');
    const prefer = ['api/src/**'];
    expect(hitRank('api/src/a.ts', prefer)).toBe(0);
    expect(hitRank('api/lib/a.ts', prefer)).toBe(1);
    expect(hitRank('api/tests/a.py', prefer)).toBe(2);
    expect(hitRank('api/src/a.test.ts', prefer)).toBe(2);
    expect(hitRank('api/docs/x.md', prefer)).toBe(2);
    expect(hitRank('api/uv.lock', prefer)).toBe(2);
  });
});
