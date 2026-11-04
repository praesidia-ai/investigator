import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import init from '../../src/cli/commands/init.js';
import pull from '../../src/cli/commands/pull.js';
import status from '../../src/cli/commands/status.js';
import { DEFAULT_CONFIG, type ConnectorContext } from '../../src/contracts.js';
import { getConnector, makeConnectorContext, pullSources, retentionSubject } from '../../src/connectors/index.js';
import { sha256 } from '../../src/util/json.js';
import { initWorkspace, openStore } from '../../src/workspace/index.js';
import { ACME_FILES, cleanup, fakeCtx, makeRepo, tempDir, writeFiles } from '../git/helpers.js';

const dirs: string[] = [];
afterAll(() => cleanup(...dirs));
function repo(): string {
  const r = makeRepo(ACME_FILES);
  dirs.push(r);
  return r;
}
const NOW = new Date('2026-11-04T05:00:00.000Z');
function cctx(root: string, env: NodeJS.ProcessEnv = {}): ConnectorContext {
  return makeConnectorContext(root, env, () => NOW);
}
const PRAESIDIA = { alias: 'praesidia', connector: 'praesidia', locator: 'policies/praesidia-support-agent.json' };

describe('file connector', () => {
  it('reads a repo file with sha256 and media type', async () => {
    const root = repo();
    const doc = await getConnector('file').fetch({ alias: 'privacy', connector: 'file', locator: 'docs/privacy.md' }, cctx(root));
    expect(doc).toEqual({
      alias: 'privacy',
      connector: 'file',
      locator: 'docs/privacy.md',
      mediaType: 'text/markdown',
      text: ACME_FILES['docs/privacy.md'],
      sha256: sha256(ACME_FILES['docs/privacy.md'] as string),
      fetchedAt: NOW.toISOString(),
    });
    expect(getConnector('file').readOnly).toBe(true);
  });

  it('reads .mdx docs pages as Markdown (FX-4: monorepo docs sites)', async () => {
    const root = repo();
    writeFiles(root, { 'apps/docs/policies/security.mdx': '# Security\n\nPasswords are hashed using bcrypt.\n' });
    const doc = await getConnector('file').fetch({ alias: 'security', connector: 'file', locator: 'apps/docs/policies/security.mdx' }, cctx(root));
    expect(doc.mediaType).toBe('text/markdown');
  });

  it('refuses paths outside the repo and reports missing files', async () => {
    const root = repo();
    const file = getConnector('file');
    await expect(file.fetch({ alias: 'x', connector: 'file', locator: '../secret.md' }, cctx(root))).rejects.toMatchObject({
      code: 'SOURCE_OUTSIDE_REPO',
    });
    await expect(file.fetch({ alias: 'x', connector: 'file', locator: '/etc/hosts' }, cctx(root))).rejects.toMatchObject({
      code: 'SOURCE_OUTSIDE_REPO',
    });
    await expect(file.fetch({ alias: 'x', connector: 'file', locator: 'docs/none.md' }, cctx(root))).rejects.toMatchObject({
      code: 'SOURCE_NOT_FOUND',
    });
  });

  it('rejects unknown connectors', () => {
    expect(() => getConnector('ftp')).toThrow(/No connector "ftp"/u);
  });
});

describe('praesidia connector', () => {
  it('reads the recorded export with its upstream version', async () => {
    const doc = await getConnector('praesidia').fetch(PRAESIDIA, cctx(repo()));
    expect(doc.mediaType).toBe('application/json');
    expect(doc.upstreamVersion).toBe('7');
    expect(doc.sha256).toBe(sha256(doc.text));
  });

  it('turns settings into structured promises with no AI', async () => {
    const connector = getConnector('praesidia');
    const doc = await connector.fetch(PRAESIDIA, cctx(repo()));
    const drafts = connector.toPromises?.(doc) ?? [];
    expect(drafts.map((d) => [d.wording, d.kind, d.checkable, d.quote.jsonPointer, d.quote.text])).toEqual([
      ['Data is kept for at most 90 days.', 'must', 'code', '/dataRetentionDays', '90'],
      ['search_notes needs approval before it runs.', 'must', 'code', '/allowedTools/0', '"search_notes"'],
      ['export_notes needs approval before it runs.', 'must', 'code', '/allowedTools/1', '"export_notes"'],
      ['Personal data is blocked from agent output.', 'must', 'runtime', '/blockPii', 'true'],
    ]);
    expect(drafts[0]?.params).toEqual([{ name: 'dataRetentionDays', value: '90', unit: 'days' }]);
    expect(drafts.every((d) => d.foundBy === 'structured' && d.scope.length === 0 && d.quote.policySha256 === doc.sha256)).toBe(true);
    expect(drafts[0]?.quote.line).toBe(5);
  });

  it('fills typed facets from the settings (no AI): retention is keep <= N days', async () => {
    const connector = getConnector('praesidia');
    const doc = await connector.fetch(PRAESIDIA, cctx(repo()));
    const drafts = connector.toPromises?.(doc) ?? [];
    expect(drafts.map((d) => d.facets)).toEqual([
      { subject: 'support chats', action: 'keep', constraint: { name: 'retention', op: '<=', value: '90', unit: 'days' } },
      { subject: 'search_notes', action: 'require approval', constraint: { name: 'before it runs', op: 'always', value: null, unit: null } },
      { subject: 'export_notes', action: 'require approval', constraint: { name: 'before it runs', op: 'always', value: null, unit: null } },
      { subject: 'personal data', action: 'show in agent output', constraint: { name: 'allowed', op: 'never', value: null, unit: null } },
    ]);
    expect(retentionSubject({ name: 'Billing agent', dataRetentionDays: 30 })).toBe('customer data');
    expect(retentionSubject({ name: 'Agent', dataKind: 'chat transcripts' })).toBe('support chats');
  });

  it('does not call any API for live locators', async () => {
    await expect(
      getConnector('praesidia').fetch({ alias: 'praesidia', connector: 'praesidia', locator: 'praesidia:support-agent' }, cctx(repo())),
    ).rejects.toMatchObject({ code: 'NOT_IMPLEMENTED' });
  });

  it('reports a broken export plainly', async () => {
    const root = repo();
    writeFiles(root, { 'policies/bad.json': '{"dataRetentionDays": "ninety"}' });
    await expect(
      getConnector('praesidia').fetch({ alias: 'bad', connector: 'praesidia', locator: 'policies/bad.json' }, cctx(root)),
    ).rejects.toMatchObject({ code: 'BAD_SOURCE' });
  });
});

describe('credentials', () => {
  it('reads the environment first, then JURATOR_HOME/credentials.json', () => {
    const home = tempDir('kw-home-');
    dirs.push(home);
    writeFileSync(join(home, 'credentials.json'), JSON.stringify({ PRAESIDIA_API_KEY: 'from-file', PRAESIDIA_ORG: 'acme' }));
    const ctx = makeConnectorContext('/x', { JURATOR_HOME: home, PRAESIDIA_API_KEY: 'from-env' });
    expect(ctx.credential('PRAESIDIA_API_KEY')).toBe('from-env');
    expect(ctx.credential('PRAESIDIA_ORG')).toBe('acme');
    expect(ctx.credential('MISSING')).toBeUndefined();
    expect(makeConnectorContext('/x', { JURATOR_HOME: join(home, 'nowhere') }).credential('PRAESIDIA_ORG')).toBeUndefined();
  });
});

describe('pullSources', () => {
  it('compares without writing, writes the lock, and a second pull changes nothing', async () => {
    const root = repo();
    const store = await initWorkspace(root, {
      ...DEFAULT_CONFIG,
      sources: [{ alias: 'privacy', connector: 'file', locator: 'docs/privacy.md' }, PRAESIDIA],
    });
    const dry = await pullSources(store, cctx(root), false);
    expect(dry.changed).toEqual(['privacy', 'praesidia']);
    expect(await store.readLock()).toEqual([]);

    await pullSources(store, cctx(root), true);
    const lock = await store.readLock();
    expect(lock.map((e) => [e.alias, e.textPath, e.upstreamVersion])).toEqual([
      ['praesidia', 'sources/praesidia.json', '7'],
      ['privacy', 'sources/privacy.md', undefined],
    ]);
    expect(await store.readSourceText(lock[1]!)).toBe(ACME_FILES['docs/privacy.md']);
    const lockText = readFileSync(join(store.dir, 'sources.lock.json'), 'utf8');

    const later = () => new Date('2026-11-04T06:00:00.000Z');
    expect((await pullSources(store, makeConnectorContext(root, {}, later), true)).changed).toEqual([]);
    expect(readFileSync(join(store.dir, 'sources.lock.json'), 'utf8')).toBe(lockText);

    writeFiles(root, { 'docs/privacy.md': '# Privacy\n\n1. Support chats are deleted after 14 days.\n' });
    expect((await pullSources(store, cctx(root), false)).changed).toEqual(['privacy']);
  });
});

describe('commands', () => {
  it('init finds the demo policies, writes config, and refuses a second time', async () => {
    const root = repo();
    const first = fakeCtx(root);
    expect(await init.run(first.ctx)).toBe(0);
    expect(first.out.join('\n')).toMatch(/privacy[\s\S]*security[\s\S]*praesidia/u);
    expect(first.out.at(-1)).toBe('Next: jurator compile');
    expect((await openStore(root).readConfig()).sources.map((s) => s.alias)).toEqual(['privacy', 'security', 'praesidia']);
    await expect(init.run(fakeCtx(root).ctx)).rejects.toMatchObject({ code: 'WORKSPACE_EXISTS' });
  });

  it('init --source overrides detection', async () => {
    const root = repo();
    const { ctx, out } = fakeCtx(root, ['--source', 'terms=file:docs/privacy.md', '--json']);
    expect(await init.run(ctx)).toBe(0);
    expect(JSON.parse(out.join('\n')).sources).toEqual([{ alias: 'terms', connector: 'file', locator: 'docs/privacy.md' }]);
    await expect(init.run(fakeCtx(repo(), ['--bogus']).ctx)).rejects.toMatchObject({ code: 'BAD_ARGS' });
  });

  it('pull --check exits 1 on drift and 0 after a pull; status reports it', async () => {
    const root = repo();
    await init.run(fakeCtx(root).ctx);
    expect(await pull.run(fakeCtx(root, ['--check']).ctx)).toBe(1);
    const pulled = fakeCtx(root);
    expect(await pull.run(pulled.ctx)).toBe(0);
    expect(pulled.out.at(-1)).toBe('Next: jurator compile');
    expect(await pull.run(fakeCtx(root, ['--check']).ctx)).toBe(0);

    const s = fakeCtx(root, ['--json']);
    expect(await status.run(s.ctx)).toBe(0);
    const report = JSON.parse(s.out.join('\n'));
    expect(report.sources.map((x: { alias: string; sha256: string | null }) => [x.alias, x.sha256 !== null])).toEqual([
      ['privacy', true],
      ['security', true],
      ['praesidia', true],
    ]);
    expect(report.coverage).toEqual({ covered: 0, codePromises: 0 });
    expect(report.next).toBe('jurator compile');

    const text = fakeCtx(root);
    expect(await status.run(text.ctx)).toBe(0);
    expect(text.out.join('\n')).toContain('0 of 0 code promises covered by rules');
    expect(text.out.at(-1)).toBe('Next: jurator compile');
  });

  it('status counts promises, rules, coverage and the last run', async () => {
    const root = repo();
    await init.run(fakeCtx(root).ctx);
    const store = openStore(root);
    const sha = 'a'.repeat(64);
    const base = {
      wording: 'Only admins can export notes.', kind: 'must' as const, checkable: 'code' as const, scope: [],
      foundBy: 'model' as const, firstSeen: NOW.toISOString(),
      quote: { alias: 'security', policySha256: sha, text: 'Only admins can export notes.' },
    };
    await store.writePromises('security', [
      { ...base, id: 'security.01', status: 'accepted' },
      { ...base, id: 'security.02', status: 'accepted' },
      { ...base, id: 'security.03', status: 'draft' },
    ]);
    await store.writeRules([
      {
        id: 'R-security.01', promiseId: 'security.01', description: 'export routes call requireAdmin', mode: 'each-near',
        pattern: 'requireAdmin', anchor: 'router\\.get', within: 5, globs: ['src/routes/**'], provenBy: null,
        status: 'accepted', author: 'model', createdAt: NOW.toISOString(),
      },
    ]);
    const s = fakeCtx(root, ['--json']);
    await status.run(s.ctx);
    const report = JSON.parse(s.out.join('\n'));
    expect(report.promises).toEqual({ total: 3, accepted: 2, draft: 1, retired: 0 });
    expect(report.rules).toEqual({ total: 1, accepted: 1, proposed: 0 });
    expect(report.coverage).toEqual({ covered: 1, codePromises: 2 });
    expect(report.lastRun).toBeNull();
    expect(report.next).toMatch(/jurator accept/u);
  });

  it('pull and status need a workspace', async () => {
    const root = repo();
    await expect(pull.run(fakeCtx(root).ctx)).rejects.toMatchObject({ code: 'NO_WORKSPACE' });
    await expect(status.run(fakeCtx(root).ctx)).rejects.toMatchObject({ code: 'NO_WORKSPACE' });
  });
});
