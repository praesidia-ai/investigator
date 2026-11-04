// FU-2 (D-1 items 2, 3, 6): kept needs code evidence, broken needs 2 of 3 answers, secrets never reach the model.
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { aiReadTask, citesCode, isCodeLine, runCheck } from '../../src/check/index.js';
import type { ModelClient } from '../../src/contracts.js';
import { ScriptedModelClient } from '../../src/model/index.js';
import { BASE, FakeModel, FakeRepo, FakeStore, FILES, fixedNow, HEAD, promise } from './fakes.js';

const repoTarget = { kind: 'repo' as const, head: 'HEAD' };
const withFiles = (extra: Record<string, string>) => new FakeRepo({ [HEAD]: { ...FILES, ...extra }, [BASE]: { ...FILES, ...extra } });
const cite = (path: string, startLine: number, endLine = startLine) => ({ path, startLine, endLine });
const kept = (...citations: Array<ReturnType<typeof cite>>) => ({ verdict: 'kept', explanation: 'Kept.', citations });
const broken = (...citations: Array<ReturnType<typeof cite>>) => ({ verdict: 'broken', explanation: 'Broken.', citations });
const cantTell = { verdict: 'cant-tell', explanation: 'Not shown.', citations: [] };

async function check(repo: FakeRepo, model: ModelClient, store = new FakeStore([promise('privacy.01', { scope: ['src/agent/**'] })])) {
  return runCheck({ repo, store, model, target: repoTarget, aiRead: true, now: fixedNow });
}

describe('a looks-kept needs code behind it (D-1 #2)', () => {
  const chats = {
    'src/agent/chats.ts': [
      '// Chats are deleted after 30 days, as the privacy policy says.',
      '/* retention: 30 days */',
      'const NOTE = [',
      '  "we keep chats for 30 days",',
      '];',
      'export const CHAT_TTL_DAYS = 90;',
      '',
    ].join('\n'),
  };

  it('citing only comments makes it CANT TELL', async () => {
    const run = await check(withFiles(chats), new FakeModel({ 'ai-read:privacy.01': kept(cite('src/agent/chats.ts', 1, 2)) }));
    expect(run.results[0]).toMatchObject({ verdict: 'cant-tell', level: 'ai-read' });
    expect(run.results[0]?.reason).toBe('the AI said kept but cited only comments or strings, so this is not evidence');
    expect(run.results[0]?.citations[0]?.quote).toContain('// Chats are deleted'); // still copied from git
  });

  it('citing only a string line makes it CANT TELL', async () => {
    const run = await check(withFiles(chats), new FakeModel({ 'ai-read:privacy.01': kept(cite('src/agent/chats.ts', 4)) }));
    expect(run.results[0]?.verdict).toBe('cant-tell');
  });

  it('one cited line of code is enough', async () => {
    const run = await check(withFiles(chats), new FakeModel({ 'ai-read:privacy.01': kept(cite('src/agent/chats.ts', 1), cite('src/agent/chats.ts', 6)) }));
    expect(run.results[0]).toMatchObject({ verdict: 'looks-kept' });
    expect(run.results[0]?.reason).toBeUndefined();
  });

  it('a kept with no citation that exists makes it CANT TELL', async () => {
    const run = await check(withFiles(chats), new FakeModel({ 'ai-read:privacy.01': kept(cite('src/agent/chats.ts', 40)) }));
    expect(run.results[0]?.verdict).toBe('cant-tell');
    expect(run.results[0]?.reason).toMatch(/cited no lines that exist/u);
  });

  it('isCodeLine / citesCode: comments, strings and braces are not code; keys, values and templates are', () => {
    expect(isCodeLine('   ')).toBe(false);
    expect(isCodeLine('  "only a string",')).toBe(false);
    expect(isCodeLine('});')).toBe(false);
    expect(isCodeLine("  'Cache-Control': 'no-store',")).toBe(true);
    expect(isCodeLine('  `user ${email} exported`,')).toBe(true);
    expect(isCodeLine('export const CHAT_TTL_DAYS = 30;')).toBe(true);
    expect(citesCode(cite('app/jobs.py', 1, 2), '# keep 30 days\n"""Docstring."""\nTTL = 30\n')).toBe(false);
    expect(citesCode(cite('app/jobs.py', 3), '# keep 30 days\n"""Docstring."""\nTTL = 30\n')).toBe(true);
    expect(citesCode(cite('config/app.json', 1), '"retention": "30 days"\n')).toBe(true); // JSON strings are the data
  });
});

describe('a looks-broken needs 2 of 3 answers (D-1 #3)', () => {
  const route = cite('src/routes/export.ts', 9, 10);
  const store = () => new FakeStore([promise('security.01', { scope: ['src/routes/**'] })]);

  it('task keys for the extra answers', () => {
    expect([aiReadTask('security.01'), aiReadTask('security.01', 2), aiReadTask('security.01', 3)]).toEqual([
      'ai-read:security.01',
      'ai-read:security.01:2',
      'ai-read:security.01:3',
    ]);
  });

  it('2 of 3 broken: LOOKS BROKEN, and all 3 calls are in the cost', async () => {
    const model = new FakeModel({ 'ai-read:security.01': broken(route), 'ai-read:security.01:2': broken(route), 'ai-read:security.01:3': kept(route) }, 0.01);
    const run = await check(new FakeRepo(), model, store());
    expect(run.results[0]).toMatchObject({ verdict: 'looks-broken', level: 'ai-read', reason: '2 of 3 AI answers said broken' });
    expect(run.results[0]?.model).toMatchObject({ inputTokens: 300, outputTokens: 60, usd: 0.03 });
    expect(run.costUsd).toBe(0.03);
    expect(model.requests.map((r) => r.task).sort()).toEqual(['ai-read:security.01', 'ai-read:security.01:2', 'ai-read:security.01:3']);
    expect(model.requests[1]?.input).toBe(model.requests[0]?.input); // the same question each time
  });

  it('1 of 3 broken: CANT TELL ("answers disagreed")', async () => {
    const model = new FakeModel({ 'ai-read:security.01': broken(route), 'ai-read:security.01:2': kept(route), 'ai-read:security.01:3': cantTell });
    const run = await check(new FakeRepo(), model, store());
    expect(run.results[0]).toMatchObject({ verdict: 'cant-tell', reason: 'answers disagreed: 1 of 3 AI answers said broken' });
    expect(run.results[0]?.citations).toHaveLength(1); // what the first answer pointed at, copied from git
    expect(run.costUsd).toBe(0.03);
    expect(run.status).toBe('completed');
  });

  it('a broken with no line that exists does not count as agreeing', async () => {
    const model = new FakeModel({
      'ai-read:security.01': broken(route),
      'ai-read:security.01:2': broken(cite('src/nowhere.ts', 1)),
      'ai-read:security.01:3': kept(route),
    });
    const run = await check(new FakeRepo(), model, store());
    expect(run.results[0]?.verdict).toBe('cant-tell');
  });

  it('a kept or cant-tell first answer makes no extra calls', async () => {
    const model = new FakeModel({ 'ai-read:privacy.01': kept(cite('src/agent/chats.ts', 1)) });
    await check(new FakeRepo(), model);
    expect(model.requests).toHaveLength(1);
  });

  it('live: a confirming call that fails leaves CANT TELL and marks the run incomplete', async () => {
    const fake = new FakeModel({
      'ai-read:security.01': broken(route),
      'ai-read:security.01:2': new Error('Meta is down'),
      'ai-read:security.01:3': kept(route),
    });
    const live: ModelClient = { id: 'live-fake', mode: 'live', json: (r) => fake.json(r) };
    const run = await check(new FakeRepo(), live, store());
    expect(run.results[0]).toMatchObject({ verdict: 'cant-tell' });
    expect(run.results[0]?.reason).toMatch(/answers asked to confirm it failed: Meta is down/u);
    expect(run.status).toBe('incomplete');
  });

  it('the budget reached after the first answer: CANT TELL, no extra calls', async () => {
    const s = store();
    s.config = { ...s.config, budgetUsdPerRun: 0.01 };
    const model = new FakeModel({ 'ai-read:security.01': broken(route), 'ai-read:security.01:2': broken(route), 'ai-read:security.01:3': broken(route) }, 0.5);
    const run = await check(new FakeRepo(), model, s);
    expect(run.results[0]?.verdict).toBe('cant-tell');
    expect(run.results[0]?.reason).toMatch(/budget of \$0\.01 was reached before a second answer/u);
    expect(model.requests).toHaveLength(1);
  });

  it('scripted: __2 / __3 files answer the extra calls; a missing one repeats the first answer', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kw-fu2-'));
    const put = (name: string, value: unknown) => writeFile(join(dir, name), JSON.stringify(value));
    await put('ai-read__security.01.json', broken(route));
    await put('ai-read__security.01__2.json', kept(route));
    let run = await check(new FakeRepo(), new ScriptedModelClient(dir), store());
    expect(run.results[0]).toMatchObject({ verdict: 'looks-broken', reason: '2 of 3 AI answers said broken' });
    await put('ai-read__security.01__3.json', cantTell);
    run = await check(new FakeRepo(), new ScriptedModelClient(dir), store());
    expect(run.results[0]).toMatchObject({ verdict: 'cant-tell', reason: 'answers disagreed: 1 of 3 AI answers said broken' });
  });
});

describe('secrets never reach the model (D-1 #6)', () => {
  const config = [
    "export const API_KEY = 'sk-abcdefghijklmnopqrstuvwxyz123456';",
    "const dbPassword = 'hunter2';",
    'export const CHAT_TTL_DAYS = 30;',
    '',
  ].join('\n');

  it('masks secrets in what is sent, skips .env and key files, and still quotes git', async () => {
    const repo = withFiles({ 'src/agent/config.ts': config, 'src/agent/.env.local': 'META_API_KEY=abc\n', 'src/agent/server.pem': 'x\n' });
    const model = new FakeModel({ 'ai-read:privacy.01': kept(cite('src/agent/config.ts', 1, 3)) });
    const run = await check(repo, model);
    const input = model.requests[0]?.input ?? '';
    expect(input).not.toMatch(/sk-abcdef|hunter2/u);
    expect(input).toContain("export const API_KEY = '[masked]';");
    expect(input).toContain('   3  export const CHAT_TTL_DAYS = 30;'); // same line numbers
    expect(input).not.toMatch(/\.env\.local|server\.pem|META_API_KEY/u);
    expect(input).toContain('Files in scope: 2; all shown below.');
    expect(run.results[0]).toMatchObject({ verdict: 'looks-kept' });
    expect(run.results[0]?.citations[0]?.quote).toBe(config.split('\n').slice(0, 3).join('\n')); // copied from git, not the masked text
  });
});
