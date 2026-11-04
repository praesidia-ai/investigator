// R5-A: what the live workspace run (R4-I) got wrong, replayed offline. Backend promises were judged on extension
// files (prompts filled by sort order), rule globs read tests, and BROKEN NOW accepted fixes that deleted 67-87 lines.
import { describe, expect, it } from 'vitest';
import type { SourceFile } from '../../src/contracts.js';
import { buildBindPrompt } from '../../src/bindings/index.js';
import { buildRulePrompt, proposeRule, runRule } from '../../src/rules/index.js';
import { MAX_FIX_LINES } from '../../src/rules/propose.js';
import { fairOrder, globInside, isTestPath, narrowGlob, ruleReadsTests } from '../../src/rules/select.js';
import { COMMIT, fixedModel, promise, rule } from './helpers.js';

const NOW = new Date('2026-11-04T10:00:00.000Z');

/** A workspace shaped like a real run: many extension files first by sort order, the backend after. */
function workspace(): SourceFile[] {
  const files: SourceFile[] = [];
  for (let i = 0; i < 60; i += 1) {
    files.push({ path: `chrome-extension/ai-mode/src/client/mod${String(i).padStart(2, '0')}.ts`, text: `export const m${i} = ${i};\n`.repeat(40) });
  }
  files.push({ path: 'chrome-extension/ai-mode/test/home.mjs', text: "await store().set({ extractedText });\n" });
  files.push({ path: 'chrome-extension/ai-mode/src/shared/fixtures.ts', text: "fetch('fixture.json');\n" });
  files.push({ path: 'backend-api/src/api/clipboard.py', text: 'def extract(doc):\n    text = parse(doc)\n    return text\n' });
  files.push({ path: 'backend-api/src/services/cache_service.py', text: 'def put(key, doc):\n    redis.set(key, doc)\n' });
  files.push({ path: 'backend-api/tests/test_clipboard.py', text: "open('doc.pdf', 'wb').write(data)\n" });
  return files;
}

const CODE_SCOPE = ['chrome-extension/ai-mode/src/**', 'chrome-extension/src/**', 'backend-api/src/**'];

describe('item 2: prompts never fill the window with one repo by sort order', () => {
  it('an unscoped promise in a workspace sees both repos in the rule prompt', () => {
    const p = promise('document-handling.04', 'The backend must not write a clipboard document to disk.', []);
    const prompt = buildRulePrompt(p, workspace(), COMMIT, 6000);
    expect(prompt).toContain('=== backend-api/src/api/clipboard.py');
    expect(prompt).toContain('=== chrome-extension/');
  });
  it('a backend-scoped promise shows backend files first (rule and bind prompts)', () => {
    const p = promise('document-handling.04', 'The backend must not write a clipboard document to disk.', ['backend-api/src/**']);
    for (const prompt of [buildRulePrompt(p, workspace(), COMMIT, 3000), buildBindPrompt(p, workspace(), COMMIT, 3000)]) {
      const firstFile = /=== (\S+)/u.exec(prompt)?.[1] ?? '';
      expect(firstFile.startsWith('backend-api/'), firstFile).toBe(true);
    }
  });
  it('fairOrder: scope first, repos take turns, files naming the promise lead', () => {
    const paths = ['a/1.ts', 'a/2.ts', 'a/3.ts', 'b/x.ts', 'b/clipboard.ts', 'c/in.ts'];
    const out = fairOrder(paths, (x) => x, { scope: ['c/**'], words: ['clipboard'] });
    expect(out).toEqual(['c/in.ts', 'a/1.ts', 'b/clipboard.ts', 'a/2.ts', 'b/x.ts', 'a/3.ts']);
    const changedFirst = fairOrder(paths, (x) => x, { scope: [], first: (x) => x === 'a/3.ts' });
    expect(changedFirst[0]).toBe('a/3.ts');
  });
});

describe('item 3: rule globs stay in the code scope and skip tests and fixtures', () => {
  it('test paths are recognised', () => {
    for (const p of ['a/test/x.ts', 'a/tests/x.py', 'a/__tests__/x.ts', 'src/a.test.ts', 'src/a.spec.js', 'a/fixtures/x.json', 'src/shared/fixtures.ts', 'tests/test_a.py', 'pkg/a_test.go']) {
      expect(isTestPath(p), p).toBe(true);
    }
    for (const p of ['src/a.ts', 'src/testimony.ts', 'src/contest/a.ts', 'backend-api/src/api/clipboard.py']) expect(isTestPath(p), p).toBe(false);
    expect(ruleReadsTests(['src/**/*.test.ts'])).toBe(true);
    expect(ruleReadsTests(['src/**/*.ts'])).toBe(false);
  });
  it('the engine skips tests and fixtures unless the globs name them', () => {
    const r = rule({ mode: 'must-not-match', pattern: 'extractedText', globs: ['chrome-extension/**'] });
    expect(runRule(r, workspace(), COMMIT).outcome).toBe('pass');
    const onTests = { ...r, globs: ['chrome-extension/ai-mode/test/**'] };
    expect(runRule(onTests, workspace(), COMMIT).outcome).toBe('fail');
  });
  it('narrowGlob keeps globs inside the scope and narrows wide ones', () => {
    const paths = workspace().map((f) => f.path).filter((x) => !isTestPath(x));
    expect(globInside('backend-api/src/api/**', CODE_SCOPE)).toBe(true);
    expect(globInside('**/*.ts', CODE_SCOPE)).toBe(false);
    expect(narrowGlob('**/*.py', ['backend-api/src/**'], paths)).toEqual(['backend-api/src/**/*.py']);
    expect(narrowGlob('chrome-extension/**/*.ts', CODE_SCOPE, paths)).toEqual(['chrome-extension/ai-mode/src/**/*.ts']);
    expect(narrowGlob('**/*.ts', ['backend-api/src/**'], paths)).toEqual([]);
  });
  it('a backend promise whose rule reads **/*.ts (all extension) is rejected, not a BROKEN NOW on extension files', async () => {
    // R4-I .04: must-not-match over **/*.ts, "fixed" by removing chrome-extension/ai-mode/test/home.mjs:443.
    const p = promise('document-handling.04', 'The backend must not write a clipboard document to disk.', ['backend-api/src/**'], { kind: 'must-not' });
    const answer = {
      feasible: true,
      reason: 'Breaks now',
      violationExamples: ['await store().set({ extractedText });'],
      keptExamples: [],
      mode: 'must-not-match',
      pattern: 'store\\(\\)\\.set\\(',
      flags: null,
      anchor: null,
      within: null,
      globs: ['**/*.ts', '**/*.mjs'],
      description: 'No document written to storage.',
    };
    const res = await proposeRule(p, workspace(), COMMIT, fixedModel(answer), NOW, { codeScope: CODE_SCOPE });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("cover no file inside the promise's code");
  });
  it('an unscoped promise keeps its rule inside the configured code scope (tests outside it are not read)', async () => {
    const p = promise('document-handling.10', 'Extracted text must not be written to a cache.', [], { kind: 'must-not' });
    const answer = {
      feasible: true,
      reason: 'catches storing extracted text',
      violationExamples: ['redis.set(key, extracted_text)'],
      keptExamples: ['redis.set(key, session_id)'],
      mode: 'must-not-match',
      pattern: 'redis\\.set\\([^)]*extracted',
      flags: null,
      anchor: null,
      within: null,
      globs: ['backend-api/**/*.py'],
      description: 'No extracted text goes to the cache.',
    };
    const res = await proposeRule(p, workspace(), COMMIT, fixedModel(answer), NOW, { codeScope: CODE_SCOPE });
    expect(res.ok, res.ok ? '' : res.reason).toBe(true);
    if (res.ok) expect(res.rule.globs).toEqual(['backend-api/src/**/*.py']);
  });
  it('globs that only name tests are rejected unless the promise is about tests', async () => {
    const p = promise('x.01', 'Card numbers must not be logged.', ['src/**'], { kind: 'must-not' });
    const answer = {
      feasible: true, reason: 'r', violationExamples: ['log(card)'], keptExamples: [], mode: 'must-not-match',
      pattern: 'log\\(card', flags: null, anchor: null, within: null, globs: ['src/**/*.test.ts'], description: 'd',
    };
    const files = [{ path: 'src/a.ts', text: 'log(user)\n' }];
    const res = await proposeRule(p, files, COMMIT, fixedModel(answer), NOW);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain('only tests or fixtures');
  });
});

describe('item 4: BROKEN NOW needs a small, believable fix in the promise scope', () => {
  const p = promise('document-handling.02', 'The backend must keep clipboard documents only in memory.', ['app/**'], { kind: 'must-not' });
  const answer = {
    feasible: true,
    reason: 'Breaks now: app/store.ts:1-12 writes documents to storage',
    violationExamples: ['storage.save(doc)'],
    keptExamples: ['memory.keep(doc)'],
    mode: 'must-not-match',
    pattern: 'storage\\.save\\(',
    flags: null,
    anchor: null,
    within: null,
    globs: ['app/**'],
    description: 'Documents are never saved to storage.',
  };
  it(`a fix of more than ${MAX_FIX_LINES} lines is not a finding (R4-I: 67 lines removed)`, async () => {
    const lines = Array.from({ length: 12 }, (_, i) => `storage.save(doc${i})`).join('\n');
    const res = await proposeRule(p, [{ path: 'app/store.ts', text: `${lines}\n` }], COMMIT, fixedModel(answer), NOW);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/changes 12 lines .*at most 5 lines/u);
  });
  it('a one-line fix is still a BROKEN NOW finding', async () => {
    const res = await proposeRule(p, [{ path: 'app/store.ts', text: 'memory.keep(doc)\nstorage.save(doc)\n' }], COMMIT, fixedModel(answer), NOW);
    expect(res.ok, res.ok ? '' : res.reason).toBe(true);
    if (res.ok) expect(res.brokenNow?.evidence[0]).toMatchObject({ path: 'app/store.ts', line: 2 });
  });
});
