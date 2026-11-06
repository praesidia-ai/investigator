import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, readdir } from 'node:fs/promises';
import { readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, type CheckRun, type PromiseRecord } from '../../src/contracts.js';
import { main } from '../../src/cli/main.js';
import {
  buildRecord,
  digestOf,
  jsonValueAt,
  quoteProblem,
  buildRequest,
  exactQuote,
  parseRequest,
  parseResult,
  sealResult,
  sha256Text,
  verifyRecord,
} from '../../src/investigations/index.js';
import { promiseDigest } from '../../src/cache/index.js';
import { initWorkspace } from '../../src/workspace/index.js';

const fixtures = fileURLToPath(new URL('../../../schemas/interop/v1/', import.meta.url));
const load = (n: string): unknown => JSON.parse(readFileSync(fixtures + n, 'utf8'));

describe('shared v1 fixtures', () => {
  it('accepts the valid pair', () => {
    parseRequest(load('request.valid.json'));
    expect(parseResult(load('result.valid.json')).mismatch).not.toBeNull();
  });
  for (const f of readdirSync(fixtures).filter((n) => n.includes('.invalid.')))
    it(`refuses ${f}`, () => {
      expect(() => (f.startsWith('request') ? parseRequest : parseResult)(load(f))).toThrow();
    });
});

const POLICY = '# Security\n\n1. Only workspace   admins can export\ncustomer data.\n';
const COLLAPSED = 'Only workspace admins can export customer data.';
const promise = (over: Partial<PromiseRecord> = {}): PromiseRecord => ({
  id: 'security.01',
  status: 'accepted',
  wording: COLLAPSED,
  quote: { alias: 'security', policySha256: sha256Text(POLICY), text: COLLAPSED, line: 3 },
  kind: 'must',
  checkable: 'code',
  scope: [],
  foundBy: 'model',
  firstSeen: '2026-11-05T00:00:00.000Z',
  ...over,
});
const cur = (p: PromiseRecord | undefined = promise()) => ({ promise: p, lockSha256: sha256Text(POLICY) });
const COMMIT = 'b'.repeat(40);
const run = (verdict = 'holds'): CheckRun =>
  ({
    schemaVersion: 1,
    toolVersion: '0.1.0',
    createdAt: '2026-11-05T09:30:00.000Z',
    target: { kind: 'repo', head: COMMIT },
    failMode: 'block',
    status: 'completed',
    checklist: [],
    summary: { promises: 1, checked: 1, holds: 1, broken: 0, looksKept: 0, looksBroken: 0, cantTell: 0, notChecked: 0, coveredByRules: 1, codePromises: 1 },
    costUsd: 0,
    digest: 'a'.repeat(64),
    id: 'run-1',
    snapshot: { repo: '/w/acme', branch: 'main', commit: COMMIT, dirty: false },
    results: [{ promiseId: 'security.01', wording: COLLAPSED, verdict, level: 'rule', citations: [{ path: 'src/a.ts', commit: COMMIT, startLine: 1, endLine: 1, quote: 'x' }], policyQuote: promise().quote, ruleResults: [] }],
  }) as unknown as CheckRun;
const mapping = { profileId: 'customer-export-approval', profileVersion: 1, requirementsDigest: 'c'.repeat(64), reviewedBy: 'lead', reviewedAt: '2026-11-05T09:00:00.000Z' };
const input = (p = promise(), r = run()) => ({
  promise: p,
  run: r,
  lock: { alias: 'security', connector: 'file', locator: 'docs/security.md', sha256: sha256Text(POLICY), fetchedAt: 'x', textPath: 'x' },
  sourceText: POLICY,
  mapping,
  tenant: 'acme',
  workflow: 'customer-export',
  environment: 'reference-test',
  window: { start: '2026-11-04T00:00:00.000Z', end: '2026-11-05T00:00:00.000Z' },
  adapter: { id: 'scripted-reference', configurationDigest: 'f'.repeat(64) },
  scope: 'Isolated workload.',
  budget: { maxModelTurns: 8, maxToolCalls: 12, maxRuntimeSeconds: 120 },
  now: new Date('2026-11-05T10:00:00Z'),
});

describe('export', () => {
  it('recopies the raw span from a whitespace-collapsed quote', () => {
    const q = exactQuote(promise(), POLICY);
    expect(q.text).toBe('Only workspace   admins can export\ncustomer data.');
    const req = buildRequest(input());
    expect(req.quote.text).toBe(q.text);
    expect(req.promise.digest).toBe(promiseDigest(promise()));
  });
  it('refuses a promise that is not accepted, a changed source and process promises', () => {
    expect(() => buildRequest(input(promise({ status: 'draft' })))).toThrow(/Accept it first/);
    expect(() => buildRequest({ ...input(), sourceText: POLICY + 'x' })).toThrow(/no longer matches/);
    expect(() => buildRequest(input(promise({ checkable: 'process' })))).toThrow(/process promise/);
  });
  it('exports a runtime promise as not code-checked', () => {
    const req = buildRequest(input(promise({ checkable: 'runtime' }), { ...run(), results: [] } as CheckRun));
    expect(req.trigger.codeCheck).toEqual({ level: 'none', verdict: 'not-checked' });
  });
  it('refuses a mapping that is not reviewed', () => {
    expect(() => buildRequest({ ...input(), mapping: { profileId: 'x' } })).toThrow(/reviewed mapping/);
  });
});

describe('import', () => {
  const req = () => buildRequest(input());
  const result = (over: Record<string, unknown> = {}) => {
    const r = req();
    return sealResult({
      schema: 'praesidia.investigation-result/v1',
      createdAt: '2026-11-05T10:05:00.000Z',
      requestDigest: r.digest,
      profile: { id: mapping.profileId, version: 1, requirementsDigest: mapping.requirementsDigest },
      adapter: r.adapter,
      execution: { status: 'completed', reason: null },
      behavioral: { verdict: 'contradicted', statement: 's' },
      static: r.trigger.codeCheck,
      mismatch: { kind: 'static-pass-runtime-contradicted', explanation: 'x' },
      scope: ['s'],
      captures: [],
      missingEvidence: [],
      proposedAction: null,
      ...over,
    } as never);
  };
  it('keeps code check and behavioral result separate, preserving the mismatch', () => {
    const rec = buildRecord({ requestRaw: req(), resultRaw: result(), current: cur(), now: new Date() });
    expect(rec.codeCheck).toMatchObject({ level: 'rule', verdict: 'holds' });
    expect(rec.behavioral).toEqual({ execution: 'completed', verdict: 'contradicted' });
    expect(rec.mismatch?.kind).toBe('static-pass-runtime-contradicted');
    expect(verifyRecord(rec, cur()).ok).toBe(true);
  });
  it('refuses a result for another request and detects tampering and stale promises', () => {
    const other = buildRequest({ ...input(), tenant: 'other' });
    expect(() => buildRecord({ requestRaw: other, resultRaw: result(), current: cur(), now: new Date() })).toThrow(/not bound/);
    const rec = buildRecord({ requestRaw: req(), resultRaw: result(), current: cur(), now: new Date() });
    expect(verifyRecord({ ...rec, behavioral: { execution: 'completed', verdict: 'supported' } }, cur()).ok).toBe(false);
    expect(verifyRecord(rec, cur(promise({ wording: 'Changed wording here.' }))).problems.join()).toMatch(/stale/);
  });
  it('rejects a tampered quote or source in the request', () => {
    const r = JSON.parse(JSON.stringify(req()));
    r.quote.text = r.quote.text.replace('admins', 'anyone');
    expect(() => parseRequest(r)).toThrow();
  });
});

describe('review fixes', () => {
  const none = { promise: undefined, lockSha256: sha256Text(POLICY) };
  const req = () => buildRequest(input());
  const res = () =>
    sealResult({ schema: 'praesidia.investigation-result/v1', createdAt: '2026-11-05T10:05:00.000Z', requestDigest: req().digest, profile: { id: mapping.profileId, version: 1, requirementsDigest: mapping.requirementsDigest }, adapter: req().adapter, execution: { status: 'completed', reason: null }, behavioral: { verdict: 'contradicted', statement: 's' }, static: req().trigger.codeCheck, mismatch: { kind: 'static-pass-runtime-contradicted', explanation: 'x' }, scope: ['s'], captures: [], missingEvidence: [], proposedAction: null } as never);
  const rec = () => buildRecord({ requestRaw: req(), resultRaw: res(), current: cur(), now: new Date() });
  const reseal = (over: Record<string, unknown>) => {
    const { digest: _d, ...rest } = { ...rec(), ...over };
    void _d;
    return { ...rest, digest: digestOf(rest) };
  };
  it('11: refuses a retired promise or a policy that is not the locked source', () => {
    expect(verifyRecord(rec(), cur(promise({ status: 'retired' }))).ok).toBe(false);
    expect(verifyRecord(rec(), { promise: promise(), lockSha256: 'f'.repeat(64) }).ok).toBe(false);
    expect(() => buildRecord({ requestRaw: req(), resultRaw: res(), current: cur(promise({ status: 'draft' })), now: new Date() })).toThrow(/not accepted/);
  });
  it('12: resealed summary fields cannot hide a mismatch or point at a missing promise', () => {
    expect(verifyRecord(reseal({ mismatch: null }), cur()).ok).toBe(false);
    expect(verifyRecord(reseal({ promiseId: 'gone.99' }), none).ok).toBe(false);
    expect(verifyRecord(rec(), none).ok).toBe(false);
    expect(verifyRecord(reseal({ codeCheck: { level: 'rule', verdict: 'holds', runId: 'other' } }), cur()).ok).toBe(false);
  });
  it('13: says authorship is not established', () => {
    expect(verifyRecord(rec(), cur())).toMatchObject({ ok: true, authenticity: 'not-established' });
  });
  it('15: JSON quotes are exact and never resolve proto keys or array length', () => {
    const src = '{"x":1,"arr":[1],"__proto__":{"allowAll":true}}';
    const q = (text: string, pointer: string) => quoteProblem(src, 'application/json', { text, locator: { kind: 'json-pointer', pointer } });
    expect(q('1', '/x')).toBeNull();
    expect(q(' 1', '/x')).not.toBeNull();
    expect(q('1', '/arr/length')).not.toBeNull();
    expect(q('{"x":1,"__proto__":{"allowAll":false}}', '')).not.toBeNull();
    expect(q(JSON.stringify(JSON.parse(src)), '')).toBeNull();
    expect(jsonValueAt('{"a":{"b":2}}', '/a/b')).toEqual({ value: 2 });
    expect(exactQuote(promise({ quote: { alias: 'security', policySha256: 'a'.repeat(64), text: '1', jsonPointer: '/x' } }), '{"x": 1}').text).toBe('1');
  });
  it('16: refuses a run that checked older wording', () => {
    expect(() => buildRequest(input(promise({ wording: 'Admins only export customer data.' }), run()))).toThrow(/older wording/);
  });
  it('17: citation at another commit and unknown nested keys are refused', () => {
    const r = JSON.parse(JSON.stringify(req()));
    r.trigger.citations[0].commit = 'c'.repeat(40);
    r.digest = digestOf(r);
    expect(() => buildRecord({ requestRaw: r, resultRaw: res(), current: cur(), now: new Date() })).toThrow();
    const withKey = reseal({ behavioral: { ...rec().behavioral, extra: 1 } });
    expect(verifyRecord(withKey, cur()).ok).toBe(false);
  });
});

describe('investigation CLI', () => {
  it('exports, imports and verifies in a real workspace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jur-inv-'));
    execFileSync('git', ['init', '-q'], { cwd: root });
    const store = await initWorkspace(root, { ...DEFAULT_CONFIG, sources: [{ alias: 'security', connector: 'file', locator: 'docs/security.md' }] });
    const p = promise();
    const textPath = await store.saveSourceText({ alias: 'security', connector: 'file', locator: 'docs/security.md', mediaType: 'text/markdown', text: POLICY, sha256: sha256Text(POLICY), fetchedAt: '2026-11-05T00:00:00.000Z' });
    await store.writeLock([{ alias: 'security', connector: 'file', locator: 'docs/security.md', sha256: sha256Text(POLICY), fetchedAt: '2026-11-05T00:00:00.000Z', textPath }]);
    await store.writePromises('security', [p]);
    await store.writeRun({ ...run(), snapshot: { repo: root, branch: 'main', commit: COMMIT, dirty: false } } as CheckRun);
    await writeFile(join(root, 'mapping.json'), JSON.stringify(mapping));
    await writeFile(join(root, 'adapter.json'), JSON.stringify({ kind: 'scripted-local', schemaVersion: 1, adapterId: 'scripted-reference' }));
    const cwd = process.cwd();
    process.chdir(root);
    const logs: string[] = [];
    const log = console.log;
    console.log = (...a: unknown[]) => void logs.push(a.join(' '));
    try {
      const exp = await main(['investigation', 'export', 'security.01', '--run', 'run-1', '--mapping', 'mapping.json', '--tenant', 'acme', '--workflow', 'customer-export', '--env', 'reference-test', '--window', '2026-11-04T00:00:00.000Z..2026-11-05T00:00:00.000Z', '--adapter', 'scripted-reference', '--adapter-config', 'adapter.json', '--out', 'request.json']);
      expect(exp).toBe(0);
      const req = parseRequest(JSON.parse(await readFile(join(root, 'request.json'), 'utf8')));
      const res = sealResult({ schema: 'praesidia.investigation-result/v1', createdAt: '2026-11-05T10:05:00.000Z', requestDigest: req.digest, profile: null, adapter: req.adapter, execution: { status: 'unsupported', reason: 'no' }, behavioral: { verdict: null, statement: null }, static: req.trigger.codeCheck, mismatch: null, scope: ['n'], captures: [], missingEvidence: [], proposedAction: null } as never);
      await writeFile(join(root, 'result.json'), JSON.stringify(res));
      expect(await main(['investigation', 'import', 'result.json'])).toBe(0);
      const [name] = await readdir(join(store.dir, 'investigations'));
      expect(await main(['investigation', 'verify', name!.replace(/\.json$/u, '')])).toBe(0);
      expect(await main(['investigation', 'export', 'security.99', '--run', 'run-1'])).toBe(2);
    } finally {
      console.log = log;
      process.chdir(cwd);
    }
  });
});
