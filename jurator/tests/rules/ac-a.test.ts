// AC-A (SC-3 fixes 1, 2, 4, 5, 6 and the no-rule record): findings only on lines the model named, the program shows
// where the code writes, logs and sends, broad must-match rules and unnamed value rules are rejected, and why a promise
// got no rule is saved.
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Config, ModelClient, ModelJsonRequest, ModelJsonResult, Rule, Store } from '../../src/contracts.js';
import { runRuleCommand } from '../../src/cli/commands/rule.js';
import { buildRulePrompt, proposeRule } from '../../src/rules/index.js';
import { nextNoRule, readNoRule, writeNoRule, type NoRuleFile } from '../../src/rules/no-rule.js';
import { RULE_PROPOSE_INSTRUCTIONS } from '../../src/rules/prompts.js';
import { MAX_MUST_MATCH_LINES, namesLine, namesSetting, unnamedHits } from '../../src/rules/propose.js';
import { fileBlock, findSinks, sinkSection } from '../../src/rules/sinks.js';
import { PROMPT_VERSION } from '../../src/model/preamble.js';
import { makeStyle } from '../../src/util/term.js';
import { COMMIT, fixedModel, promise } from './helpers.js';

const NOW = new Date('2026-11-04T04:00:00.000Z');
const base = { feasible: true, flags: null, anchor: null, within: null, description: 'test rule' };

/** A live model that answers in turn and keeps every prompt it was sent. */
function liveModel(answers: unknown[], inputs: string[]): ModelClient {
  return {
    id: 'fake-live',
    mode: 'live',
    async json<T>(request: ModelJsonRequest<T>): Promise<ModelJsonResult<T>> {
      inputs.push(request.input);
      const value = request.schema.parse(answers[Math.min(inputs.length - 1, answers.length - 1)]);
      return { value, usage: { id: 'fake-live', mode: 'live', inputTokens: 1, outputTokens: 1, usd: 0.01 } };
    },
  };
}

describe('fix 1: BROKEN NOW only on lines the model named', () => {
  it('namesLine reads full paths, file names, ranges and lists', () => {
    expect(namesLine('Breaks now: src/log.ts:3 logs it', 'src/log.ts', 3)).toBe(true);
    expect(namesLine('Breaks now: log.ts:3 logs it', 'src/log.ts', 3)).toBe(true);
    expect(namesLine('Breaks now: orchestrator.py:650-710 uploads', 'app/orchestrator.py', 665)).toBe(true);
    expect(namesLine('Breaks now: a.py:10, 12 and b.py:4', 'x/a.py', 12)).toBe(true);
    expect(namesLine('Breaks now: log.ts:3 logs it', 'src/log.ts', 5)).toBe(false);
    expect(namesLine('Breaks now: blog.ts:3', 'src/log.ts', 3)).toBe(false);
    const hits = [{ path: 'src/log.ts', commit: COMMIT, startLine: 3, endLine: 3, quote: '' }, { path: 'src/log.ts', commit: COMMIT, startLine: 5, endLine: 5, quote: '' }];
    expect(unnamedHits('Breaks now: log.ts:3', hits).map((h) => h.startLine)).toEqual([5]);
  });

  // .27-style: the rule matches the real write and a second line that only reads the data by key.
  const files = [
    {
      path: 'src/cache.ts',
      text: [
        "import { redis } from './redis';",
        'export async function keep(doc: Doc) {',
        "  await redis.set('clipboard:' + doc.id, doc.text);",
        '}',
        "const hit = cached['clipboard'];",
      ].join('\n'),
    },
    { path: 'src/redis.ts', text: "export const redis = makeClient();\nredis.del('x');\n" },
  ];
  const p = promise('dh.09', 'The backend never caches clipboard documents.', ['src/**'], { kind: 'must-not' });
  const wide = {
    ...base,
    reason: 'Breaks now: cache.ts:3 writes the clipboard document to redis',
    violationExamples: ["await redis.set('clipboard:' + id, body)"],
    keptExamples: ["redis.del('clipboard:' + id)"],
    mode: 'must-not-match',
    pattern: 'clipboard',
    globs: ['src/**'],
  };

  it('a hit the reason does not name is no finding: rejected (scripted answers get no retry)', async () => {
    const res = await proposeRule(p, files, COMMIT, fixedModel(wide), NOW);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/fails on 1 line your "Breaks now:" does not name \(src\/cache\.ts:5\)/u);
  });

  it('the retry carries the unnamed lines with program-copied context; a narrowed rule is a finding on the named line only', async () => {
    const inputs: string[] = [];
    const narrow = { ...wide, pattern: '\\.set\\w*\\([^)]*clipboard' };
    const res = await proposeRule(p, files, COMMIT, liveModel([wide, narrow], inputs), NOW);
    expect(inputs).toHaveLength(2);
    expect(inputs[1]).toContain('=== src/cache.ts (lines 1-5; the rule fails on line 5)');
    expect(inputs[1]).toContain("5| const hit = cached['clipboard'];");
    expect(res.ok, JSON.stringify(res)).toBe(true);
    if (!res.ok) return;
    expect(res.brokenNow?.evidence.map((e) => `${e.path}:${e.line}`)).toEqual(['src/cache.ts:3']);
  });

  it('a rule that fails today with no "Breaks now:" is rejected, never reported as broken', async () => {
    const res = await proposeRule(p, files, COMMIT, fixedModel({ ...wide, reason: 'Catches any new cache write.' }), NOW);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/does not start with "Breaks now:"/u);
  });

  it('the prompt asks for every path:line and says unnamed lines come back', () => {
    expect(RULE_PROPOSE_INSTRUCTIONS).toContain('then every path:line that breaks it (as in the "=== " headers)');
    expect(RULE_PROPOSE_INSTRUCTIONS).toContain('if it fails on a line you did not name, those lines come back to you');
    expect(PROMPT_VERSION).toBe(3);
  });
});

describe('fix 2: the program shows where the code writes, logs and sends', () => {
  const filler = Array.from({ length: 900 }, (_, i) => `const filler${i} = compute(${i}); // padding line ${i}`).join('\n');
  const files = [
    { path: 'app/clipboard/screen.ts', text: `${filler}\n` },
    {
      path: 'app/core/orchestrator.py',
      text: [...Array.from({ length: 640 }, (_, i) => `x${i} = step(${i})`), 'result = await upload_client.upload_documents(bundles)', 'logger.info("extracted %s fields", n)'].join('\n'),
    },
    { path: 'app/helpers/storage.ts', text: "export const localStorage = new ChromeStorage(chrome.storage.local);\nexport function noop() {}\n" },
    { path: 'app/a.ts', text: "await localStorage.set('clipboard_records', rows);\nawait fetch(url, { body });\nlocalStorage.remove('x');\n" },
    { path: 'app/config.py', text: 'EXTRACTION_RESULT_CACHE_TTL: int = 1209600  # 14 days in seconds\n' },
    { path: 'tests/a.test.ts', text: "localStorage.set('t', 1);\n" },
  ];
  const p = promise('dh.10', 'The backend never writes a clipboard document to cloud storage.', ['app/**'], { kind: 'must-not' });

  it('finds writes, logs, sends, deletes and lifetimes in live code, never in tests', () => {
    const kinds = findSinks(files.filter((f) => !f.path.startsWith('tests/'))).map((s) => `${s.kind} ${s.path}:${s.line}`);
    expect(kinds).toEqual(
      expect.arrayContaining([
        'write app/core/orchestrator.py:641',
        'log app/core/orchestrator.py:642',
        'write app/a.ts:1',
        'send app/a.ts:2',
        'delete app/a.ts:3',
        'lifetime app/config.py:1',
      ]),
    );
    const section = sinkSection(p, files);
    expect(section.lines.join('\n')).not.toContain('tests/a.test.ts');
  });

  it('lists them before the files, with the definitions they call through', () => {
    const prompt = buildRulePrompt(p, files, COMMIT);
    const head = prompt.slice(0, prompt.indexOf('=== '));
    expect(head).toContain('app/core/orchestrator.py:641  result = await upload_client.upload_documents(bundles)');
    expect(head).toContain("app/a.ts:1  await localStorage.set('clipboard_records', rows);");
    expect(head).toContain('definitions those lines call through');
    expect(head).toContain('app/helpers/storage.ts:1  export const localStorage = new ChromeStorage(chrome.storage.local);');
    // The writes come first for a "never write" promise.
    expect(head.indexOf('- stores or writes:')).toBeLessThan(head.indexOf('- logs:'));
  });

  it('a long file is shown as a window around its first sink line, with its own line numbers', () => {
    const prompt = buildRulePrompt(p, files, COMMIT);
    expect(prompt).toContain('641| result = await upload_client.upload_documents(bundles)');
    expect(prompt).toMatch(/=== app\/core\/orchestrator\.py\n\.\.\. \(lines 1-\d+ not shown\)\n/u);
    const block = fileBlock(files[1]!, 641);
    expect(block.length).toBeLessThan(6_200);
  });
});

describe('fix 4: the write call, in this code\'s names', () => {
  it('the prompt asks for the write call, a delete keptExample and this code\'s names', () => {
    expect(RULE_PROPOSE_INSTRUCTIONS).toContain('the pattern must contain the write call');
    expect(RULE_PROPOSE_INSTRUCTIONS).toContain('make one keptExample a delete');
    expect(RULE_PROPOSE_INSTRUCTIONS).toContain('if a policy name (localStorage, S3) is a wrapper here, match what it calls');
  });

  it('a bare-noun pattern that matches the delete keptExample is rejected', async () => {
    const p = promise('dh.14', 'The extension never stores clipboard documents in IndexedDB.', ['src/**'], { kind: 'must-not' });
    const files = [{ path: 'src/rollback.ts', text: "export function reset() {}\nreset();\n" }];
    const answer = {
      ...base,
      reason: 'Catches a new IndexedDB write.',
      violationExamples: ["indexedDB.open('clipboard')"],
      keptExamples: ["indexedDB.deleteDatabase('clipboard')"],
      mode: 'must-not-match',
      pattern: 'indexedDB',
      globs: ['src/**'],
    };
    const res = await proposeRule(p, files, COMMIT, fixedModel(answer), NOW);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("matches the kept example `indexedDB.deleteDatabase('clipboard')`");
  });
});

describe('fix 5: a must-match names one guard; "act when X arrives" is checkable', () => {
  const p = promise('dh.18', 'Uploaded files are scanned before processing.', ['app/**']);
  const answer = { ...base, reason: 'Catches removing the scan.', violationExamples: [], keptExamples: [], mode: 'must-match', globs: ['app/**'] };

  it(`a must-match on more than ${MAX_MUST_MATCH_LINES} lines is rejected (.18: 15 initialisers)`, async () => {
    const text = Array.from({ length: 6 }, (_, i) => `self.client${i} = None`).join('\n');
    const res = await proposeRule(p, [{ path: 'app/document_processor.py', text }], COMMIT, fixedModel({ ...answer, pattern: 'self\\.\\w+\\s*=' }), NOW);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/matches 6 lines in 1 file \(e\.g\. `app\/document_processor\.py:1`\).*name the one guard/u);
  });

  it('a must-match in more than 2 files is rejected; one guard line is kept', async () => {
    const many = ['a', 'b', 'c'].map((n) => ({ path: `app/${n}.py`, text: 'scan_file(upload)\n' }));
    const res = await proposeRule(p, many, COMMIT, fixedModel({ ...answer, pattern: 'scan_file\\(' }), NOW);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain('in 3 files');
    const one = await proposeRule(p, many.slice(0, 1), COMMIT, fixedModel({ ...answer, pattern: 'scan_file\\(' }), NOW);
    expect(one.ok, one.ok ? '' : one.reason).toBe(true);
  });

  it('the prompt says a handler promise is checkable; no handler is Breaks now', async () => {
    expect(RULE_PROPOSE_INSTRUCTIONS).toContain('A promise that code acts when a request or event arrives is checkable');
    expect(RULE_PROPOSE_INSTRUCTIONS).toContain('if no handler exists, that is "Breaks now:", not feasible=false');
    // .17: no delete handler exists. The rule requires the route; the program adds the kept line in memory.
    const q = promise('dh.17', 'A clipboard document is deleted when a delete request arrives.', ['app/**']);
    const files = [{ path: 'app/routes.py', text: '@router.post("/clipboard")\ndef add(doc): ...\n' }];
    const res = await proposeRule(
      q,
      files,
      COMMIT,
      fixedModel({ ...answer, reason: 'Breaks now: routes.py has no delete handler for clipboard documents', pattern: '@router\\.delete\\(\\s*[\'"][^\'"]*clipboard', keptExamples: ['@router.delete("/clipboard/{id}")'] }),
      NOW,
    );
    expect(res.ok, res.ok ? '' : res.reason).toBe(true);
    if (res.ok) expect(res.brokenNow?.fix).toContain('app/routes.py');
  });
});

describe('fix 6: a value rule names its setting', () => {
  const facets = { facets: { subject: 'extraction results', action: 'keep', constraint: { name: 'retention', op: '<=' as const, value: '24', unit: 'hours' } } };
  const p = promise('dh.20', 'Extraction results are kept for at most 24 hours.', ['app/**'], facets);
  const files = [{ path: 'app/config.py', text: 'EXTRACTION_RESULT_CACHE_TTL: int = 1209600\nRESULT_TTL_HOURS = 24\n' }];

  it('namesSetting: a named constant or a short key counts, a bare number pattern does not', () => {
    expect(namesSetting('CHAT_TTL_DAYS\\s*=\\s*30\\b')).toBe(true);
    expect(namesSetting('ttl\\s*=\\s*(?:[0-9]{1,4})\\b')).toBe(true);
    expect(namesSetting('(?:[0-9]|1[0-9]|2[0-3]|24)\\b')).toBe(false);
    expect(namesSetting('\\b(?:[0-9]|1[0-9]|2[0-4])\\s*\\*\\s*60\\b')).toBe(false);
  });

  it('a must-match with no named setting is rejected (.20 copied the hours-only number pattern)', async () => {
    const answer = { ...base, reason: 'Catches a longer lifetime.', violationExamples: [], keptExamples: ['24'], mode: 'must-match', pattern: '(?:[0-9]|1[0-9]|2[0-3]|24)\\b', globs: ['app/**'] };
    const res = await proposeRule(p, files, COMMIT, fixedModel(answer), NOW);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain('names no constant or setting');
  });

  it('an added constant nobody uses is no fix for a number: no finding', async () => {
    const answer = {
      ...base,
      reason: 'Breaks now: config.py:1 keeps results 14 days',
      violationExamples: [],
      keptExamples: ['RESULT_CACHE_TTL_SECONDS = 86400'],
      mode: 'must-match',
      pattern: 'RESULT_CACHE_TTL_SECONDS\\s*=\\s*(?:[0-9]{1,4}|[1-7][0-9]{4}|8[0-5][0-9]{3}|86[0-3][0-9]{2}|86400)\\b',
      globs: ['app/**'],
    };
    const res = await proposeRule(p, files, COMMIT, fixedModel(answer), NOW);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/no small fix/u);
  });

  it('evidence never reports a unit factor (the 60 in CHAT_TTL_DAYS * 24 * 60 * 60) as the broken value', async () => {
    const q = promise('privacy.01', 'Support chats are deleted after 30 days.', ['src/**'], {
      facets: { subject: 'chats', action: 'delete', constraint: { name: 'retention', op: '<=' as const, value: '30', unit: 'days' } },
    });
    const chat = [{ path: 'src/chats.ts', text: 'export const CHAT_TTL_SECONDS = CHAT_TTL_DAYS * 24 * 60 * 60;\nexport const CHAT_TTL_DAYS = 90;\n' }];
    const answer = { ...base, reason: 'Breaks now: chats.ts:2 keeps chats 90 days', violationExamples: [], keptExamples: [], mode: 'must-match', pattern: 'CHAT_TTL_DAYS\\s*=\\s*(?:[0-9]|[12][0-9]|30)\\b', globs: ['src/**'] };
    const res = await proposeRule(q, chat, COMMIT, fixedModel(answer), NOW);
    expect(res.ok, res.ok ? '' : res.reason).toBe(true);
    if (!res.ok) return;
    const ev = res.brokenNow!.evidence;
    expect(ev.find((e) => e.line === 2)?.actual).toBe('90');
    expect(ev.some((e) => e.actual === '60' || e.actual === '24')).toBe(false);
    expect(res.brokenNow!.fix).toContain('src/chats.ts:2');
    expect(res.brokenNow!.fix).not.toContain('src/chats.ts:1');
  });

  it('the prompt asks for the named setting in the unit the code counts in', () => {
    expect(RULE_PROPOSE_INSTRUCTIONS).toContain('must-match on the named constant or setting that holds it, in the file that sets it');
    expect(RULE_PROPOSE_INSTRUCTIONS).toContain('24 hours = 86400');
  });
});

describe('no-rule record: why a promise got no rule (.jurator/local/no-rule.json)', () => {
  it('reads, writes and updates the file (a promise that gets a rule leaves)', async () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'kw-norule-')), '.jurator');
    expect(await readNoRule(dir)).toEqual({});
    const entry = { reason: 'the model call failed', infeasible: false, commit: 'abc', at: NOW.toISOString() };
    expect(await writeNoRule(dir, { 'b.02': entry, 'a.01': { ...entry, infeasible: true } })).toBe(true);
    const saved = JSON.parse(readFileSync(join(dir, 'local', 'no-rule.json'), 'utf8'));
    expect(Object.keys(saved)).toEqual(['a.01', 'b.02']);
    expect(await readNoRule(dir)).toEqual({ 'a.01': { ...entry, infeasible: true }, 'b.02': entry });
    expect(nextNoRule(saved, { 'c.03': entry }, ['a.01'])).toEqual({ 'b.02': entry, 'c.03': entry });
  });

  it('rule propose saves the reason for each promise that got no rule, and drops promises that got one', async () => {
    const SHA = '2222222222222222222222222222222222222222';
    const code = [{ path: 'src/agent/chats.ts', text: 'export const CHAT_TTL_DAYS = 30;\nlog(chatCount);\n' }];
    const promises = [
      promise('privacy.01', 'Support chats are deleted after 30 days.', ['src/agent/**']),
      promise('privacy.02', 'Chats are never logged.', ['src/agent/**'], { kind: 'must-not' }),
    ];
    const answers: Record<string, unknown> = {
      'rule-propose:privacy.01': { ...base, reason: 'Catches a longer lifetime.', violationExamples: [], keptExamples: [], mode: 'must-match', pattern: 'CHAT_TTL_DAYS\\s*=', globs: ['src/agent/**'] },
      // Fails today on a line it does not name: no finding, no rule, and the reason is saved.
      'rule-propose:privacy.02': { ...base, reason: 'Catches chat logging.', violationExamples: ['log("chat body", chat)'], keptExamples: ['log("login")'], mode: 'must-not-match', pattern: 'log\\([^)]*chat', globs: ['src/agent/**'] },
    };
    let rules: Rule[] = [];
    let saved: NoRuleFile = { 'privacy.01': { reason: 'old reason', infeasible: false, commit: 'old', at: 'old' } };
    const store = {
      dir: '/x/.jurator',
      repoRoot: '/x',
      exists: async () => true,
      readConfig: async () => ({ schemaVersion: 1, sources: [], failMode: 'block', codeScope: ['src/**'], model: { id: 'm' }, budgetUsdPerRun: 10 }) as unknown as Config,
      readPromises: async () => promises,
      readRules: async () => rules,
      writeRules: async (items: Rule[]) => {
        rules = items;
      },
      readBindings: async () => [],
      writeBindings: async () => undefined,
    } as unknown as Store;
    const repo = {
      root: '/x',
      snapshot: async () => ({ repo: '/x', branch: 'main', commit: SHA, dirty: false }),
      resolve: async () => SHA,
      listFiles: async () => code.map((f) => f.path),
      readFile: async (_c: string, path: string) => code.find((f) => f.path === path)?.text ?? '',
      changedFiles: async () => [],
    };
    const deps = {
      findRepoRoot: async () => '/x',
      openStore: () => store,
      openRepo: async () => repo,
      createModel: (): ModelClient => ({
        id: 'fake',
        mode: 'scripted',
        async json<T>(request: ModelJsonRequest<T>): Promise<ModelJsonResult<T>> {
          return { value: request.schema.parse(answers[request.task]), usage: { id: 'fake', mode: 'scripted', inputTokens: 1, outputTokens: 1, usd: 0 } };
        },
      }),
      infeasible: { read: async () => [], write: async () => true },
      mutants: { read: async () => ({ version: 1 as const, rules: {} }), write: async () => true },
      noRule: {
        read: async () => saved,
        write: async (_d: string, data: NoRuleFile) => {
          saved = data;
          return true;
        },
      },
    };
    const out: string[] = [];
    const c = { cwd: '/x', argv: ['propose', '--all'], env: {}, out: (l: string) => out.push(l), err: (l: string) => out.push(l), style: makeStyle(false), now: () => NOW };
    expect(await runRuleCommand(c as never, deps as never)).toBe(0);
    expect(Object.keys(saved)).toEqual(['privacy.02']);
    expect(saved['privacy.02']).toMatchObject({ infeasible: false, commit: SHA, at: NOW.toISOString() });
    expect(saved['privacy.02']!.reason).toMatch(/does not start with "Breaks now:"/u);
  });
});
