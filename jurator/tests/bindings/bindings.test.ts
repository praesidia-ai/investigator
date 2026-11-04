import { describe, expect, it } from 'vitest';
import type { Binding } from '../../src/contracts.js';
import {
  anchorIn,
  bindingsFromRule,
  bindingsFromRules,
  mergeBindings,
  overlaps,
  parseUnifiedDiff,
  patternNames,
  touchedBindings,
  unquotePath,
  verifyLocations,
  proposeBindings,
  type BindAnswer,
} from '../../src/bindings/index.js';
import { runRule } from '../../src/rules/index.js';
import { sha256 } from '../../src/util/json.js';
import { CHATS, COMMIT, EXPORT_ROUTE, P, R, SCRIPTED_ACME, TOOLS, files, fixedModel, scriptedModel } from './helpers.js';

const fromRule = (p: (typeof P)[keyof typeof P], r: (typeof R)[keyof typeof R]): Binding[] => bindingsFromRule(p, r, runRule(r, files(), COMMIT));

describe('hunk parsing (git diff -U0)', () => {
  it('reads one-line changes, insertions, deletions, new and deleted files, and quoted paths', () => {
    const text = [
      'diff --git a/src/agent/chats.ts b/src/agent/chats.ts',
      'index dfcbfa6..0c5a903 100644',
      '--- a/src/agent/chats.ts',
      '+++ b/src/agent/chats.ts',
      '@@ -2 +2 @@',
      '-export const CHAT_TTL_DAYS = 30;',
      '+export const CHAT_TTL_DAYS = 90;',
      '@@ -13,0 +14,5 @@ router.get',
      '+',
      '@@ -20,3 +25,0 @@',
      '--- a removed SQL comment that looks like a header',
      '-x',
      '-y',
      'diff --git a/src/new.ts b/src/new.ts',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/src/new.ts',
      '@@ -0,0 +1,2 @@',
      '+a',
      '+b',
      'diff --git a/src/old.ts b/src/old.ts',
      'deleted file mode 100644',
      '--- a/src/old.ts',
      '+++ /dev/null',
      '@@ -1,4 +0,0 @@',
      '-1',
      'diff --git "a/src/we\\tird.ts" "b/src/we\\tird.ts"',
      '--- "a/src/we\\tird.ts"',
      '+++ "b/src/we\\tird.ts"',
      '@@ -5,2 +5,3 @@',
      'Binary files a/img.png and b/img.png differ',
    ].join('\n');
    expect(parseUnifiedDiff(text)).toEqual([
      { path: 'src/agent/chats.ts', oldStart: 2, oldLines: 1, newStart: 2, newLines: 1 },
      { path: 'src/agent/chats.ts', oldStart: 13, oldLines: 0, newStart: 14, newLines: 5 },
      { path: 'src/agent/chats.ts', oldStart: 20, oldLines: 3, newStart: 25, newLines: 0 },
      { path: 'src/new.ts', oldStart: 0, oldLines: 0, newStart: 1, newLines: 2 },
      { path: 'src/old.ts', oldStart: 1, oldLines: 4, newStart: 0, newLines: 0 },
      { path: 'src/we\tird.ts', oldStart: 5, oldLines: 2, newStart: 5, newLines: 3 },
    ]);
  });
  it('unquotes octal escapes as UTF-8 bytes', () => {
    expect(unquotePath('"a/caf\\303\\251.ts"')).toBe('a/café.ts');
    expect(unquotePath('a/plain.ts')).toBe('a/plain.ts');
  });
});

describe('overlap at the old side', () => {
  const change = (oldStart: number, oldLines: number) => ({ path: 'f', oldStart, oldLines, newStart: oldStart, newLines: 1 });
  it('counts a changed or deleted line inside the range', () => {
    expect(overlaps(change(2, 1), 2, 2)).toBe(true);
    expect(overlaps(change(1, 3), 2, 2)).toBe(true);
    expect(overlaps(change(3, 1), 2, 2)).toBe(false);
    expect(overlaps(change(1, 1), 2, 2)).toBe(false);
  });
  it('counts an insertion only between two bound lines, not next to them', () => {
    expect(overlaps(change(8, 0), 8, 9)).toBe(true); // a line pushed between the route and its guard
    expect(overlaps(change(9, 0), 8, 9)).toBe(false); // after the guard
    expect(overlaps(change(7, 0), 8, 9)).toBe(false); // before the route
    expect(overlaps(change(2, 0), 2, 2)).toBe(false);
  });
});

describe('bindings from rules (no AI)', () => {
  it('a value rule binds the constant, with what the policy expects', () => {
    const [b, ...rest] = fromRule(P.privacy01, R.privacy01);
    expect(rest).toEqual([]);
    expect(b).toMatchObject({
      id: 'B-privacy.01-1',
      promiseId: 'privacy.01',
      path: 'src/agent/chats.ts',
      symbol: 'CHAT_TTL_DAYS',
      kind: 'constant',
      startLine: 2,
      endLine: 2,
      quote: 'export const CHAT_TTL_DAYS = 30;',
      anchoredAt: COMMIT,
      expected: { op: '<=', value: '30', unit: 'days' },
      foundBy: 'rule',
    });
    expect(b?.quoteSha256).toBe(sha256('export const CHAT_TTL_DAYS = 30;'));
  });
  it('an each-near rule binds the route through its guard call', () => {
    expect(fromRule(P.security01, R.security01)).toMatchObject([
      { id: 'B-security.01-1', path: 'src/routes/export.ts', symbol: 'requireAdmin', kind: 'guard', startLine: 8, endLine: 9, expected: null },
    ]);
  });
  it('a must-match guard call is a guard', () => {
    expect(fromRule(P.praesidia03, R.praesidia03)).toMatchObject([{ symbol: 'approvalGate', kind: 'guard', path: 'src/agent/tools.ts', startLine: 7 }]);
  });
  it('a must-not-match rule, a failing rule, or a rule of another promise gives nothing', () => {
    expect(fromRule(P.security03, R.security03)).toEqual([]);
    const broken = runRule(R.privacy01, files({ 'src/agent/chats.ts': CHATS.replace('= 30', '= 90') }), COMMIT);
    expect(broken.outcome).toBe('fail');
    expect(bindingsFromRule(P.privacy01, R.privacy01, broken)).toEqual([]);
    expect(fromRule(P.security01, R.privacy01)).toEqual([]);
  });
  it('bindingsFromRules numbers across accepted rules and skips proposed ones', () => {
    const second = { ...R.privacy01, id: 'R-privacy.01-2', pattern: 'CHAT_TTL_DAYS \\* 24' };
    const proposed = { ...R.privacy01, id: 'R-privacy.01-3', status: 'proposed' as const, pattern: 'isExpired' };
    const items = bindingsFromRules(P.privacy01, [R.privacy01, second, proposed], files(), COMMIT);
    expect(items.map((b) => [b.id, b.startLine])).toEqual([
      ['B-privacy.01-1', 2],
      ['B-privacy.01-2', 5],
    ]);
  });
  it('patternNames reads the names a pattern spells out', () => {
    expect(patternNames(R.privacy01.pattern)).toEqual(['CHAT_TTL_DAYS']);
    expect(patternNames(R.praesidia03.pattern)).toEqual(['approvalGate', 'export_notes']);
    expect(patternNames('deletedAt\\s*===\\s*null\\b.*\\barchivedAt')).toEqual(['deletedAt', 'archivedAt']);
  });
});

describe('model locations are verified by the program', () => {
  const loc = (over: Partial<BindAnswer['locations'][number]>): BindAnswer['locations'][number] => ({
    name: null,
    path: 'src/agent/tools.ts',
    startLine: 5,
    endLine: 5,
    kind: 'allowlist',
    why: 'x',
    ...over,
  });
  it('copies the quote from the file, never from the model', () => {
    const { bindings, dropped } = verifyLocations(P.praesidia02, { locations: [loc({ name: 'search_notes' })] }, files(), COMMIT);
    expect(dropped).toEqual([]);
    expect(bindings).toMatchObject([
      { id: 'B-praesidia.02-1', symbol: 'search_notes', kind: 'allowlist', quote: TOOLS.split('\n')[4], foundBy: 'model', expected: null },
    ]);
  });
  it('drops what it cannot verify: unknown file, lines out of range, too long, name not there, blank', () => {
    const long = { path: 'src/long.ts', text: Array.from({ length: 30 }, (_, i) => `export const V${i} = ${i};`).join('\n') };
    const { bindings, dropped } = verifyLocations(
      P.praesidia02,
      {
        locations: [
          loc({ path: 'src/agent/nope.ts' }),
          loc({ startLine: 40, endLine: 41 }),
          loc({ startLine: 0, endLine: 1 }),
          loc({ path: 'src/long.ts', startLine: 1, endLine: 25 }),
          loc({ name: 'deleteEverything' }),
        ],
      },
      [...files(), long],
      COMMIT,
    );
    expect(bindings).toEqual([]);
    expect(dropped.map((d) => d.reason)).toEqual([
      "src/agent/nope.ts is not a file of this commit in the promise's code",
      'lines 40-41 do not exist (the file has 11)',
      'lines 0-1 do not exist (the file has 11)',
      'lines 1-25 are more than 20 lines; a binding points at the line itself',
      'deleteEverything is not on src/agent/tools.ts:5-5',
    ]);
    const blank = verifyLocations(P.privacy03, { locations: [loc({ path: 'src/routes/export.ts', startLine: 5, endLine: 5 })] }, files(), COMMIT);
    expect(blank.dropped.map((d) => d.reason)).toEqual(['src/routes/export.ts:5-5 is blank']);
  });
  it('moves a range onto the stated name when the model is off by a line or two, and drops duplicates', () => {
    const { bindings, dropped } = verifyLocations(
      P.security01,
      {
        locations: [
          loc({ path: 'src/routes/export.ts', startLine: 8, endLine: 8, name: 'requireAdmin', kind: 'call' }),
          loc({ path: 'src/routes/export.ts', startLine: 9, endLine: 9, name: 'requireAdmin', kind: 'guard' }),
        ],
      },
      files(),
      COMMIT,
    );
    expect(bindings).toMatchObject([{ startLine: 9, endLine: 9, symbol: 'requireAdmin', kind: 'guard', quote: '  requireAdmin(req);' }]);
    expect(dropped.map((d) => d.reason)).toEqual(['src/routes/export.ts:9-9 repeats a location already bound']);
  });
  it('proposeBindings uses task bind:<id> and the scripted acme answers', async () => {
    const calls: string[] = [];
    const res = await proposeBindings(P.praesidia02, files(), COMMIT, scriptedModel(SCRIPTED_ACME, calls));
    expect(calls).toEqual(['bind:praesidia.02']);
    expect(res.bindings.map((b) => `${b.path}:${b.startLine} ${b.symbol} ${b.kind}`)).toEqual([
      'src/agent/tools.ts:5 search_notes allowlist',
      'src/agent/praesidia.ts:2 approvalGate guard',
    ]);
    const logs = await proposeBindings(P.security03, files(), COMMIT, scriptedModel(SCRIPTED_ACME));
    expect(logs.bindings.map((b) => `${b.path}:${b.startLine} ${b.symbol} ${b.kind}`)).toEqual(['src/log.ts:1 SECRET_KEYS allowlist', 'src/log.ts:5 SECRET_KEYS guard']);
  });
  it('an empty answer binds nothing; at most 5 locations are read', async () => {
    expect((await proposeBindings(P.privacy03, files(), COMMIT, fixedModel({ locations: [] }))).bindings).toEqual([]);
    const many = Array.from({ length: 8 }, (_, i) => loc({ path: 'src/routes/export.ts', startLine: 8 + i, endLine: 8 + i }));
    const res = await proposeBindings(P.privacy03, files(), COMMIT, fixedModel({ locations: many }));
    expect(res.bindings.length + res.dropped.length).toBe(5);
  });
});

describe('touched bindings', () => {
  const b = (over: Partial<Binding>): Binding => ({
    id: 'B-privacy.01-1',
    promiseId: 'privacy.01',
    path: 'src/agent/chats.ts',
    symbol: 'CHAT_TTL_DAYS',
    kind: 'constant',
    startLine: 2,
    endLine: 2,
    quote: 'export const CHAT_TTL_DAYS = 30;',
    quoteSha256: sha256('export const CHAT_TTL_DAYS = 30;'),
    anchoredAt: COMMIT,
    expected: { op: '<=', value: '30', unit: 'days' },
    foundBy: 'rule',
    ...over,
  });
  it('names the touched line and the promise it is bound to', () => {
    const items = [b({}), b({ id: 'B-praesidia.01-1', promiseId: 'praesidia.01' }), b({ id: 'B-security.01-1', promiseId: 'security.01', path: 'src/routes/export.ts', startLine: 8, endLine: 9 })];
    const touched = touchedBindings(items, [{ path: 'src/agent/chats.ts', oldStart: 2, oldLines: 1, newStart: 2, newLines: 1 }]);
    expect(touched.map((t) => t.reason)).toEqual([
      'touched CHAT_TTL_DAYS = 30 at src/agent/chats.ts:2 (bound to praesidia.01)',
      'touched CHAT_TTL_DAYS = 30 at src/agent/chats.ts:2 (bound to privacy.01)',
    ]);
    // The csv-export branch adds a route after line 13: no bound line is touched (the scope check still runs).
    expect(touchedBindings(items, [{ path: 'src/routes/export.ts', oldStart: 13, oldLines: 0, newStart: 14, newLines: 5 }])).toEqual([]);
  });
});

describe('reanchor', () => {
  const guard: Binding = {
    id: 'B-security.01-1',
    promiseId: 'security.01',
    path: 'src/routes/export.ts',
    symbol: 'requireAdmin',
    kind: 'guard',
    startLine: 8,
    endLine: 9,
    quote: "router.get('/export', async (req, res) => {\n  requireAdmin(req);",
    quoteSha256: 'x'.repeat(64).replace(/x/gu, 'a'),
    anchoredAt: COMMIT,
    expected: null,
    foundBy: 'rule',
  };
  const ttl: Binding = { ...guard, id: 'B-privacy.01-1', promiseId: 'privacy.01', path: 'src/agent/chats.ts', symbol: 'CHAT_TTL_DAYS', kind: 'constant', startLine: 2, endLine: 2, quote: 'export const CHAT_TTL_DAYS = 30;' };
  it('same: the lines are where they were', () => {
    expect(anchorIn(guard, EXPORT_ROUTE)).toEqual({ startLine: 8, endLine: 9, quote: guard.quote, status: 'same' });
  });
  it('moved: the same quote elsewhere in the file', () => {
    expect(anchorIn(guard, `// a header\n// two\n${EXPORT_ROUTE}`)).toMatchObject({ startLine: 10, endLine: 11, status: 'moved' });
  });
  it('changed: the same symbol with a new value (a value binding follows its declaration, not a usage)', () => {
    expect(anchorIn(ttl, `// note\n${CHATS.replace('= 30', '= 90')}`)).toEqual({ startLine: 3, endLine: 3, quote: 'export const CHAT_TTL_DAYS = 90;', status: 'changed' });
    const onlyUsage = CHATS.replace('export const CHAT_TTL_DAYS = 30;', "import { CHAT_TTL_DAYS } from './config.js';");
    expect(anchorIn(ttl, onlyUsage)).toBeNull();
  });
  it('changed: a guard keeps its shape (route line through the guard)', () => {
    const text = EXPORT_ROUTE.replace("router.get('/export', async (req, res) => {", "router.get('/export', async (req: Request, res) => {");
    expect(anchorIn(guard, text)).toMatchObject({ startLine: 8, endLine: 9, status: 'changed' });
  });
  it('lost: neither the quote nor the symbol is there', () => {
    expect(anchorIn(guard, EXPORT_ROUTE.replace('  requireAdmin(req);\n', ''))).toBeNull();
  });
});

describe('merging', () => {
  it('replaces a promise rule/model bindings, keeps human ones and other promises, renumbers', () => {
    const base = fromRule(P.privacy01, R.privacy01)[0] as Binding;
    const human = { ...base, id: 'B-privacy.01-2', startLine: 5, endLine: 5, foundBy: 'human' as const };
    const other = { ...base, id: 'B-praesidia.01-1', promiseId: 'praesidia.01' };
    const fresh = new Map([['privacy.01', [{ ...base, id: 'B-privacy.01-1', foundBy: 'model' as const }]]]);
    const merged = mergeBindings([base, human, other], fresh);
    expect(merged.map((b) => [b.id, b.foundBy, b.startLine])).toEqual([
      ['B-praesidia.01-1', 'rule', 2],
      ['B-privacy.01-1', 'human', 5],
      ['B-privacy.01-2', 'model', 2],
    ]);
  });
});
