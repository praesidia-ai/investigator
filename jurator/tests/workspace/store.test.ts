import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, type CheckRun, type PromiseRecord } from '../../src/contracts.js';
import { compareIds, findRepoRoot, initWorkspace, listRuns, openStore } from '../../src/workspace/index.js';
import { aliasFromName, detectCodeScope, detectSources, parseSourceFlag } from '../../src/workspace/detect.js';
import { ACME_FILES, cleanup, makeRepo, tempDir, writeFiles } from '../git/helpers.js';

const dirs: string[] = [];
afterAll(() => cleanup(...dirs));
function repo(): string {
  const r = makeRepo(ACME_FILES);
  dirs.push(r);
  return r;
}

const SHA = 'a'.repeat(64);
function promise(id: string): PromiseRecord {
  return {
    id,
    status: 'draft',
    wording: 'Support chats are deleted after 30 days.',
    quote: { alias: id.split('.')[0] as string, policySha256: SHA, text: 'Support chats are deleted after 30 days.' },
    kind: 'must',
    checkable: 'code',
    scope: ['src/**'],
    foundBy: 'model',
    firstSeen: '2026-11-04T05:00:00.000Z',
  };
}

function run(id: string, createdAt: string): CheckRun {
  return {
    schemaVersion: 1,
    id,
    toolVersion: '0.1.0',
    createdAt,
    snapshot: { repo: 'acme', branch: 'main', commit: 'b'.repeat(40), dirty: false },
    target: { kind: 'repo', head: 'b'.repeat(40) },
    failMode: 'block',
    status: 'completed',
    results: [],
    checklist: [],
    summary: {
      promises: 0, checked: 0, holds: 0, broken: 0, looksKept: 0, looksBroken: 0, cantTell: 0, notChecked: 0,
      coveredByRules: 0, codePromises: 0,
    },
    costUsd: 0,
    digest: 'c'.repeat(64),
  };
}

describe('store', () => {
  it('initWorkspace writes config, .gitignore and empty lists, once', async () => {
    const root = repo();
    const store = await initWorkspace(root, DEFAULT_CONFIG);
    expect(await store.exists()).toBe(true);
    expect(await store.readConfig()).toEqual(DEFAULT_CONFIG);
    expect(readFileSync(join(root, '.jurator', '.gitignore'), 'utf8')).toBe('local/\n');
    expect(JSON.parse(readFileSync(join(root, '.jurator', 'rules.json'), 'utf8'))).toEqual({ schemaVersion: 1, items: [] });
    expect(await store.readLock()).toEqual([]);
    expect(await store.readPromises()).toEqual([]);
    await expect(initWorkspace(root, DEFAULT_CONFIG)).rejects.toMatchObject({ code: 'WORKSPACE_EXISTS' });
  });

  it('reads missing list files as [] and a missing config as NO_WORKSPACE', async () => {
    const store = openStore(repo());
    expect(await store.exists()).toBe(false);
    expect(await store.readRules()).toEqual([]);
    expect(await store.readContradictions()).toEqual([]);
    await expect(store.readConfig()).rejects.toMatchObject({ code: 'NO_WORKSPACE' });
  });

  it('writes promises per alias, sorted by id, pretty, and reads them all back', async () => {
    const root = repo();
    const store = await initWorkspace(root, DEFAULT_CONFIG);
    await store.writePromises('privacy', [promise('privacy.10'), promise('privacy.02'), promise('privacy.01')]);
    await store.writePromises('security', [promise('security.01')]);
    const text = readFileSync(join(root, '.jurator', 'promises', 'privacy.json'), 'utf8');
    expect(text.startsWith('{\n  "schemaVersion": 1,\n  "items": [')).toBe(true);
    expect(text.endsWith('\n')).toBe(true);
    expect((await store.readPromises()).map((p) => p.id)).toEqual(['privacy.01', 'privacy.02', 'privacy.10', 'security.01']);
    await expect(store.writePromises('privacy', [promise('security.02')])).rejects.toMatchObject({ code: 'BAD_WORKSPACE_WRITE' });
  });

  it('refuses to write invalid records and to read a hand-broken file', async () => {
    const root = repo();
    const store = await initWorkspace(root, DEFAULT_CONFIG);
    const bad = { ...promise('privacy.01'), wording: '' };
    await expect(store.writePromises('privacy', [bad])).rejects.toMatchObject({ code: 'BAD_WORKSPACE_WRITE' });
    writeFileSync(join(root, '.jurator', 'rules.json'), '{"schemaVersion":1,"items":[{"id":"nope"}]}');
    await expect(store.readRules()).rejects.toMatchObject({ code: 'BAD_WORKSPACE_FILE' });
    writeFileSync(join(root, '.jurator', 'contradictions.json'), '{not json');
    await expect(store.readContradictions()).rejects.toMatchObject({ code: 'BAD_WORKSPACE_FILE' });
  });

  it('saves source text by media type and reads it back through the lock entry', async () => {
    const store = await initWorkspace(repo(), DEFAULT_CONFIG);
    const doc = {
      alias: 'privacy', connector: 'file', locator: 'docs/privacy.md', mediaType: 'text/markdown' as const,
      text: '# P\n', sha256: SHA, fetchedAt: '2026-11-04T05:00:00.000Z',
    };
    const textPath = await store.saveSourceText(doc);
    expect(textPath).toBe('sources/privacy.md');
    const entry = { alias: 'privacy', connector: 'file', locator: 'docs/privacy.md', sha256: SHA, fetchedAt: doc.fetchedAt, textPath };
    expect(await store.readSourceText(entry)).toBe('# P\n');
    await expect(store.readSourceText({ ...entry, textPath: '../../etc/passwd' })).rejects.toMatchObject({ code: 'BAD_WORKSPACE_FILE' });
  });

  it('writes runs under local/runs and lists them oldest first', async () => {
    const store = await initWorkspace(repo(), DEFAULT_CONFIG);
    const p2 = await store.writeRun(run('run-2', '2026-11-04T05:02:00.000Z'));
    await store.writeRun(run('run-1', '2026-11-04T05:01:00.000Z'));
    expect(p2).toBe(join(store.dir, 'local', 'runs', 'run-2', 'run.json'));
    expect((await listRuns(store)).map((r) => r.id)).toEqual(['run-1', 'run-2']);
    await expect(store.writeRun(run('../x', '2026-11-04T05:00:00.000Z'))).rejects.toMatchObject({ code: 'BAD_WORKSPACE_WRITE' });
  });

  it('finds the repo root from a subfolder and fails outside git', async () => {
    const root = repo();
    mkdirSync(join(root, 'src', 'deep'), { recursive: true });
    expect(await findRepoRoot(join(root, 'src', 'deep'))).toBe(root);
    const plain = tempDir('kw-plain-');
    dirs.push(plain);
    await expect(findRepoRoot(plain)).rejects.toMatchObject({ code: 'NOT_A_GIT_REPO' });
  });

  it('orders ids naturally', () => {
    expect(['privacy.10', 'privacy.9', 'C-10', 'C-2', 'privacy.02'].sort(compareIds)).toEqual([
      'C-2', 'C-10', 'privacy.02', 'privacy.9', 'privacy.10',
    ]);
  });
});

describe('detect', () => {
  it('finds privacy, security and praesidia in the demo layout', async () => {
    expect(await detectSources(repo())).toEqual([
      { alias: 'privacy', connector: 'file', locator: 'docs/privacy.md' },
      { alias: 'security', connector: 'file', locator: 'docs/security.md' },
      { alias: 'praesidia', connector: 'praesidia', locator: 'policies/praesidia-support-agent.json' },
    ]);
  });

  it('finds policies in real-repo layouts: tpl/help/*.md, monorepo docs .mdx, root SECURITY.md (FX-4)', async () => {
    const root = makeRepo({
      'SECURITY.md': '# Security\n',
      'tpl/help/privacy.md': '# Privacy\n',
      'tpl/help/gdpr.md': '# GDPR\n',
      'tpl/help/sessions.md': '# Sessions\n',
      'apps/docs/content/docs/policies/security.mdx': '# Security\n',
      'apps/docs/content/docs/policies/terms-of-service.mdx': '# Terms\n',
      'node_modules/pkg/privacy.md': '# not ours\n',
      '.github/SECURITY.md': '# hidden folder\n',
      'main.go': 'package main\n',
    });
    dirs.push(root);
    expect(await detectSources(root)).toEqual([
      { alias: 'security', connector: 'file', locator: 'SECURITY.md' },
      { alias: 'security-2', connector: 'file', locator: 'apps/docs/content/docs/policies/security.mdx' },
      { alias: 'gdpr', connector: 'file', locator: 'tpl/help/gdpr.md' },
      { alias: 'privacy', connector: 'file', locator: 'tpl/help/privacy.md' },
    ]);
  });

  it('infers the code scope from the repo layout, keeping the default when src/app/lib hold code (FX-4)', async () => {
    const go = tempDir();
    const mono = tempDir();
    const empty = tempDir();
    dirs.push(go, mono, empty);
    writeFiles(go, {
      'hit.go': 'package goatcounter\n',
      'handlers/count.go': 'package handlers\n',
      'public/count.js': '// tracker\n',
      'docs/example.go': 'package docs\n',
      'vendor/x/y.go': 'package y\n',
      'tpl/help/privacy.md': '# Privacy\n',
    });
    writeFiles(mono, {
      'apps/web/app/page.tsx': 'export {};\n',
      'packages/lib/server/crypto.ts': 'export {};\n',
      'packages/lib/scripts/seed.ts': 'export {};\n',
      'scripts/release.ts': 'export {};\n',
      'tests/e2e.spec.ts': 'export {};\n',
      'node_modules/a/index.js': '',
    });
    const fallback = DEFAULT_CONFIG.codeScope;
    expect(await detectCodeScope(go, fallback)).toEqual(['*.go', 'handlers/**/*.go', 'public/**/*.js']);
    expect(await detectCodeScope(mono, fallback)).toEqual(['apps/**/*.tsx', 'packages/**/*.ts']);
    expect(await detectCodeScope(repo(), fallback)).toEqual([...fallback]);
    expect(await detectCodeScope(empty, fallback)).toEqual([...fallback]);

    const store = await initWorkspace(go, DEFAULT_CONFIG);
    expect((await store.readConfig()).codeScope).toEqual(['*.go', 'handlers/**/*.go', 'public/**/*.js']);
    const custom = await initWorkspace(mono, { ...DEFAULT_CONFIG, codeScope: ['apps/web/**'] });
    expect((await custom.readConfig()).codeScope).toEqual(['apps/web/**']);
  });

  it('makes valid aliases from file names', () => {
    expect(aliasFromName('docs/Privacy Policy.md')).toBe('privacy-policy');
    expect(aliasFromName('2024_terms.md')).toBe('p-2024-terms');
  });

  it('parses --source values', () => {
    expect(parseSourceFlag('terms=file:legal/terms.md', ['file'])).toEqual({ alias: 'terms', connector: 'file', locator: 'legal/terms.md' });
    expect(() => parseSourceFlag('Terms=file:x.md', ['file'])).toThrow(/Alias/u);
    expect(() => parseSourceFlag('terms=ftp:x.md', ['file'])).toThrow(/connector/u);
    expect(() => parseSourceFlag('terms', ['file'])).toThrow(/alias=connector:locator/u);
  });
});
