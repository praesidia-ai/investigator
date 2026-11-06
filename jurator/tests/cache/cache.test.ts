import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  blobIds,
  cacheKeyFor,
  lastVerified,
  lookup,
  policyStateOf,
  promiseDigest,
  recordVerified,
  remember,
  ruleDigest,
  withEffectiveScope,
  EVALUATOR_VERSION,
  engineIdentity,
} from '../../src/cache/index.js';
import type { Binding, CheckResult } from '../../src/contracts.js';
import { FakeRepo, FakeStore, FILES, HEAD, BASE, promise, rule } from '../check/fakes.js';

const ROUTES = ['src/routes/export.ts'];

describe('digests and policy state', () => {
  it('a promise digest ignores the policy sha and quote offsets, but not the words', () => {
    const p = promise('privacy.01');
    const movedInPolicy = { ...p, quote: { ...p.quote, policySha256: 'f'.repeat(64), line: 40, start: 10, end: 20 } };
    expect(promiseDigest(movedInPolicy)).toBe(promiseDigest(p));
    expect(promiseDigest({ ...p, wording: 'Chats are deleted after 31 days.' })).not.toBe(promiseDigest(p));
    expect(promiseDigest({ ...p, quote: { ...p.quote, text: 'other words' } })).not.toBe(promiseDigest(p));
  });

  it('a rule digest ignores when it was written or proven, but not its pattern', () => {
    const r = rule('R-security.01', 'security.01', ['src/routes/**']);
    expect(ruleDigest({ ...r, createdAt: '2026-11-05T00:00:00.000Z', provenBy: null })).toBe(ruleDigest(r));
    expect(ruleDigest({ ...r, pattern: 'requireOwner\\(' })).not.toBe(ruleDigest(r));
  });

  it('policyStateOf is stable in order, counts only accepted items, and changes with any accepted promise or rule', () => {
    const a = promise('privacy.01');
    const b = promise('security.01');
    const r = rule('R-security.01', 'security.01', ['src/routes/**']);
    const s = policyStateOf([a, b], [r]);
    expect(s).toMatch(/^[0-9a-f]{64}$/u);
    expect(policyStateOf([b, a], [r])).toBe(s);
    expect(policyStateOf([a, b, promise('privacy.09', { status: 'draft' })], [r, rule('R-x', 'privacy.01', ['src/**'], { status: 'proposed' })])).toBe(s);
    expect(policyStateOf([a, { ...b, wording: 'Changed.' }], [r])).not.toBe(s);
    expect(policyStateOf([a, b], [{ ...r, globs: ['src/**'] }])).not.toBe(s);
    expect(policyStateOf([a, b], [])).not.toBe(s);
  });

  it('withEffectiveScope fills an empty scope from the config', () => {
    const [p] = withEffectiveScope([promise('privacy.01')], ['src/**']);
    expect(p?.scope).toEqual(['src/**']);
  });
});

describe('cacheKeyFor', () => {
  const sec = promise('security.01', { scope: ['src/routes/**'] });
  const secRule = rule('R-security.01', 'security.01', ['src/routes/**']);

  it('changes when a file it depends on changes, not when another file changes', async () => {
    const other = { ...FILES, 'src/agent/chats.ts': 'export const CHAT_TTL_DAYS = 90;\n' };
    const routeChanged = { ...FILES, 'src/routes/export.ts': `${FILES['src/routes/export.ts']}// more\n` };
    const repo = new FakeRepo({ [HEAD]: FILES, [BASE]: other, ['c'.repeat(40)]: routeChanged });
    const k1 = await cacheKeyFor(sec, [secRule], [], repo, HEAD, ROUTES);
    expect(await cacheKeyFor(sec, [secRule], [], repo, BASE, ROUTES)).toBe(k1);
    expect(await cacheKeyFor(sec, [secRule], [], repo, 'c'.repeat(40), ROUTES)).not.toBe(k1);
    expect(await cacheKeyFor(sec, [{ ...secRule, pattern: 'x' }], [], repo, HEAD, ROUTES)).not.toBe(k1);
    expect(await cacheKeyFor({ ...sec, wording: 'New words.' }, [secRule], [], repo, HEAD, ROUTES)).not.toBe(k1);
    // A new file in scope changes the key (a new route without a guard must be checked).
    expect(await cacheKeyFor(sec, [secRule], [], repo, HEAD, [...ROUTES, 'src/routes/new.ts'])).not.toBe(k1);
  });

  it('a promise with a rule ignores bindings (rules read whole files); without a rule, bound quotes decide', async () => {
    const repo = new FakeRepo();
    const binding: Binding = {
      id: 'B-privacy.01-1',
      promiseId: 'privacy.01',
      path: 'src/agent/chats.ts',
      symbol: 'CHAT_TTL_DAYS',
      kind: 'constant',
      startLine: 1,
      endLine: 1,
      quote: 'export const CHAT_TTL_DAYS = 30;',
      quoteSha256: '0'.repeat(64),
      anchoredAt: HEAD,
      expected: { op: '<=', value: '30', unit: 'days' },
      foundBy: 'rule',
    };
    const p = promise('privacy.01', { scope: ['src/agent/**'] });
    let quote: string | null = 'export const CHAT_TTL_DAYS = 30;';
    const reanchor = async () => (quote === null ? null : { startLine: 1, endLine: 1, quote, status: 'same' as const });
    const k1 = await cacheKeyFor(p, [], [binding], repo, HEAD, ['src/agent/chats.ts', 'src/log.ts'], reanchor);
    // Corrected (P0 identity): the AI read also sees the other files in scope, so a new scope file is a new effect path.
    expect(await cacheKeyFor(p, [], [binding], repo, HEAD, ['src/agent/chats.ts'], reanchor)).not.toBe(k1);
    expect(await cacheKeyFor(p, [], [binding], repo, HEAD, ['src/agent/chats.ts', 'src/log.ts'], reanchor)).toBe(k1);
    quote = 'export const CHAT_TTL_DAYS = 90;';
    expect(await cacheKeyFor(p, [], [binding], repo, HEAD, ['src/agent/chats.ts'], reanchor)).not.toBe(k1);
    quote = null; // lost
    expect(await cacheKeyFor(p, [], [binding], repo, HEAD, ['src/agent/chats.ts'], reanchor)).not.toBe(k1);
    // With a rule, the files decide, whatever the bindings say.
    const r = rule('R-privacy.01', 'privacy.01', ['src/agent/**']);
    const kr = await cacheKeyFor(p, [r], [binding], repo, HEAD, ['src/agent/chats.ts'], reanchor);
    quote = 'anything';
    expect(await cacheKeyFor(p, [r], [binding], repo, HEAD, ['src/agent/chats.ts'], reanchor)).toBe(kr);
  });

  it('blobIds marks a missing file and is sorted', async () => {
    const ids = await blobIds(new FakeRepo(), HEAD, ['src/log.ts', 'nope.ts', 'src/log.ts']);
    expect(ids.map(([p]) => p)).toEqual(['nope.ts', 'src/log.ts']);
    expect(ids[0]?.[1]).toBe('missing');
    expect(ids[1]?.[1]).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });
});

describe('local cache files', () => {
  let dir: string;
  let store: FakeStore;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'kw-cache-'));
    store = Object.assign(new FakeStore([]), { dir }) as FakeStore;
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const result: CheckResult = {
    promiseId: 'security.01',
    wording: 'Exports need an admin.',
    verdict: 'holds',
    level: 'rule',
    citations: [],
    policyQuote: { alias: 'security', policySha256: '0'.repeat(64), text: 'Only admins may export.' },
  };

  it('remember then lookup returns the entry; unknown or unsafe keys are a miss', async () => {
    const key = 'a'.repeat(64);
    expect(await lookup(store, key)).toBeNull();
    await remember(store, key, { result, runId: 'run-1', commit: HEAD });
    expect(await lookup(store, key)).toEqual({ result, runId: 'run-1', commit: HEAD });
    expect(await lookup(store, '../../etc/passwd')).toBeNull();
    const raw = JSON.parse(await readFile(join(dir, 'local', 'cache', `${key}.json`), 'utf8'));
    expect(raw.runId).toBe('run-1');
  });

  it('a half-written cache file is a miss, not an error', async () => {
    await mkdir(join(dir, 'local', 'cache'), { recursive: true });
    await writeFile(join(dir, 'local', 'cache', `${'b'.repeat(64)}.json`), '{"result":', 'utf8');
    expect(await lookup(store, 'b'.repeat(64))).toBeNull();
  });

  it('recordVerified then lastVerified returns the pair', async () => {
    expect(await lastVerified(store)).toBeNull();
    const pair = { commit: HEAD, policyState: 'c'.repeat(64), runId: 'run-2', at: '2026-11-04T04:00:00.000Z' };
    await recordVerified(store, pair);
    expect(await lastVerified(store)).toEqual(pair);
  });
});

describe('cache identity v2', () => {
  const p = promise('privacy.01', { scope: ['src/agent/**'] });
  const bound: Binding = {
    id: 'B-privacy.01-1', promiseId: 'privacy.01', path: 'src/agent/chats.ts', symbol: 'CHAT_TTL_DAYS', kind: 'constant',
    startLine: 1, endLine: 1, quote: 'export const CHAT_TTL_DAYS = 30;', quoteSha256: '0'.repeat(64), anchoredAt: HEAD,
    expected: { op: '<=', value: '30', unit: 'days' }, foundBy: 'rule',
  };
  const reanchor = async () => ({ startLine: 1, endLine: 1, quote: 'export const CHAT_TTL_DAYS = 30;', status: 'same' as const });
  const SCOPE = ['src/agent/chats.ts', 'src/agent/helper.ts'];
  const withFiles = (extra: Record<string, string>) => new FakeRepo({ [HEAD]: { ...FILES, ...extra } });
  const key = (repo: FakeRepo, scope = SCOPE, identity = { reader: { id: 'm1', effort: 'low' }, codeScope: ['src/**'] }) =>
    cacheKeyFor(p, [], [bound], repo, HEAD, scope, reanchor, identity);
  const base = { 'src/agent/helper.ts': "export const x = 1;\n" };

  it('AI read: model id/effort, dependency change and new scope file invalidate; unrelated file reuses', async () => {
    const k = await key(withFiles(base));
    expect(await key(withFiles({ ...base, 'docs/other.md': 'x' }))).toBe(k); // unrelated
    expect(await key(withFiles(base), SCOPE, { reader: { id: 'm2', effort: 'low' }, codeScope: ['src/**'] })).not.toBe(k);
    expect(await key(withFiles(base), SCOPE, { reader: { id: 'm1', effort: 'high' }, codeScope: ['src/**'] })).not.toBe(k);
    expect(await key(withFiles(base), SCOPE, { reader: { id: 'm1', effort: 'low' }, codeScope: ['lib/**'] })).not.toBe(k);
    expect(await key(withFiles({ 'src/agent/helper.ts': "export const x = 2;\n" }))).not.toBe(k); // imported code changed
    expect(await key(withFiles({ ...base, 'src/agent/new.ts': 'y' }), [...SCOPE, 'src/agent/new.ts'])).not.toBe(k); // new effect path
  });

  it('analyzer version and evaluator version change the key and the fast-path identity', async () => {
    const r = rule('R-privacy.01', 'privacy.01', ['src/agent/**']);
    const sem = { ...r, mode: 'semantic' as const, semantic: { adapter: 'ts-express', adapterVersion: '1', control: 'guard', config: {} } };
    const repo = withFiles(base);
    const k1 = await cacheKeyFor(p, [sem], [], repo, HEAD, SCOPE);
    const k2 = await cacheKeyFor(p, [{ ...sem, semantic: { ...sem.semantic, adapterVersion: '2' } }], [], repo, HEAD, SCOPE);
    expect(k2).not.toBe(k1);
    expect(engineIdentity([sem], ['src/**'])).not.toBe(engineIdentity([{ ...sem, semantic: { ...sem.semantic, adapterVersion: '2' } }], ['src/**']));
    expect(EVALUATOR_VERSION).toBeTruthy();
  });

  it('digests stay the same for promises without obligation and rules without semantic', () => {
    const r = rule('R-privacy.01', 'privacy.01', ['src/**']);
    expect(ruleDigest({ ...r, semantic: undefined })).toBe(ruleDigest(r));
    expect(promiseDigest({ ...p, obligation: undefined })).toBe(promiseDigest(p));
  });
});
