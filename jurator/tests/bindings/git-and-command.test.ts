import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runBindCommand } from '../../src/cli/commands/bind.js';
import { runRuleCommand } from '../../src/cli/commands/rule.js';
import { DEFAULT_CONFIG, type Binding } from '../../src/contracts.js';
import { anchorAll, bindingsFromRule, changedLines, readBindings, reanchor, touchedBindings, writeBindings } from '../../src/bindings/index.js';
import { openRepo } from '../../src/git/index.js';
import { runRule } from '../../src/rules/index.js';
import { BRAND } from '../../src/brand.js';
import { makeCtx } from '../command-context.js';

import { initWorkspace, openStore } from '../../src/workspace/index.js';
import { ACME_FILES, CHATS, EXPORT_ROUTE, P, R, SCRIPTED_ACME, cleanup, commitAll, files, git, makeRepo } from './helpers.js';

const dirs: string[] = [];
afterEach(() => cleanup(...dirs.splice(0)));

const ctx = makeCtx;

describe('changedLines and reanchor on a real git repo', () => {
  it('reads the agent/retention change as line 2 and finds the binding it touches', async () => {
    const root = makeRepo();
    dirs.push(root);
    const repo = await openRepo(root);
    const base = await repo.resolve('HEAD');
    const [ttl] = bindingsFromRule(P.privacy01, R.privacy01, runRule(R.privacy01, files(), base));
    git(root, 'checkout', '-q', '-b', 'agent/retention');
    const head = commitAll(root, { 'src/agent/chats.ts': CHATS.replace('= 30', '= 90') });
    const changes = await changedLines(repo, 'main', head);
    expect(changes).toEqual([{ path: 'src/agent/chats.ts', oldStart: 2, oldLines: 1, newStart: 2, newLines: 1 }]);
    expect(touchedBindings([ttl as Binding], changes).map((t) => t.reason)).toEqual([
      'touched CHAT_TTL_DAYS = 30 at src/agent/chats.ts:2 (bound to privacy.01)',
    ]);
    expect(await reanchor(ttl as Binding, repo, head)).toEqual({ startLine: 2, endLine: 2, quote: 'export const CHAT_TTL_DAYS = 90;', status: 'changed' });
    expect(await reanchor(ttl as Binding, repo, base)).toMatchObject({ status: 'same' });
  });
  it('a new route below the guarded one touches no binding; moving and deleting are moved and lost', async () => {
    const root = makeRepo();
    dirs.push(root);
    const repo = await openRepo(root);
    const base = await repo.resolve('HEAD');
    const [guard] = bindingsFromRule(P.security01, R.security01, runRule(R.security01, files(), base));
    const csv = `${EXPORT_ROUTE}router.get('/export.csv', async (req, res) => {\n  res.send('');\n});\n`;
    const head = commitAll(root, { 'src/routes/export.ts': csv });
    expect(touchedBindings([guard as Binding], await changedLines(repo, base, head))).toEqual([]);
    const moved = commitAll(root, { 'src/routes/export.ts': `// moved down\n\n${csv}` });
    expect(await reanchor(guard as Binding, repo, moved)).toMatchObject({ startLine: 10, endLine: 11, status: 'moved' });
    git(root, 'rm', '-q', 'src/routes/export.ts');
    git(root, 'commit', '-q', '-m', 'rm');
    const gone = git(root, 'rev-parse', 'HEAD');
    expect(await reanchor(guard as Binding, repo, gone)).toBeNull();
    const deleted = await changedLines(repo, moved, gone);
    expect(deleted[0]).toMatchObject({ path: 'src/routes/export.ts', newLines: 0 });
    expect((await anchorAll([guard as Binding], repo, gone))[0]?.status).toBe('lost');
  });
});

describe('bindings.json', () => {
  it('round-trips sorted by id, refuses duplicates and bad shapes', async () => {
    const root = makeRepo();
    dirs.push(root);
    const store = openStore(root);
    expect(await readBindings(store)).toEqual([]);
    const [a] = bindingsFromRule(P.privacy01, R.privacy01, runRule(R.privacy01, files(), 'a'.repeat(40)));
    const b = { ...(a as Binding), id: 'B-privacy.01-10' };
    const c = { ...(a as Binding), id: 'B-privacy.01-2' };
    await writeBindings(store, [b, a as Binding, c]);
    expect((await readBindings(store)).map((x) => x.id)).toEqual(['B-privacy.01-1', 'B-privacy.01-2', 'B-privacy.01-10']);
    const text = readFileSync(join(store.dir, 'bindings.json'), 'utf8');
    expect(JSON.parse(text).schemaVersion).toBe(1);
    await expect(writeBindings(store, [a as Binding, a as Binding])).rejects.toThrow(/appears twice/u);
    writeFileSync(join(store.dir, 'bindings.json'), '{"schemaVersion":1,"items":[{"id":"nope"}]}');
    await expect(readBindings(store)).rejects.toThrow(/does not match the expected shape/u);
  });
});

async function workspace(): Promise<string> {
  const root = makeRepo();
  dirs.push(root);
  const store = await initWorkspace(root, DEFAULT_CONFIG);
  await store.writePromises('privacy', [P.privacy01, P.privacy03]);
  await store.writePromises('security', [P.security01, P.security03]);
  await store.writePromises('praesidia', [P.praesidia02, P.praesidia03]);
  await store.writeRules([R.privacy01, R.security01, R.security03, R.praesidia03]);
  return root;
}

describe('jurator bind', () => {
  it('binds from rules first (no AI), then asks the model only for the rest', async () => {
    const root = await workspace();
    const { c, out } = ctx(root, ['--all', '--scripted', SCRIPTED_ACME]);
    expect(await runBindCommand(c)).toBe(0);
    const text = out.join('\n');
    expect(text).toContain('privacy.01   -> src/agent/chats.ts:2 CHAT_TTL_DAYS (expects <= 30 days)  constant, from its rule, no AI');
    expect(text).toContain('security.01  -> src/routes/export.ts:8-9 requireAdmin  guard, from its rule, no AI');
    expect(text).toContain('praesidia.02 -> src/agent/tools.ts:5 search_notes  allowlist, from the model, checked by the program');
    expect(text).toContain('security.03  -> src/log.ts:1 SECRET_KEYS  allowlist, from the model, checked by the program');
    expect(text).toContain('6 of 6 code promises bound: 3 from rules (no AI), 3 from the model');
    expect(text).toMatch(/Next: review \S+\/bindings\.json and commit it/u);
    const saved = await readBindings(openStore(root));
    expect(saved.map((b) => `${b.id} ${b.foundBy}`)).toEqual([
      'B-praesidia.02-1 model',
      'B-praesidia.02-2 model',
      'B-praesidia.03-1 rule',
      'B-privacy.01-1 rule',
      'B-privacy.03-1 model',
      'B-security.01-1 rule',
      'B-security.03-1 model',
      'B-security.03-2 model',
    ]);
    // Again with --all: model bindings that still anchor are kept, so no model call and nothing changes.
    const again = ctx(root, ['--all', '--no-model']);
    expect(await runBindCommand(again.c)).toBe(0);
    expect(again.out.join('\n')).toContain('Nothing changed');
  });
  it('--no-model binds only from rules and says why the rest are not bound', async () => {
    const root = await workspace();
    const { c, out } = ctx(root, ['--no-model', '--json']);
    expect(await runBindCommand(c)).toBe(0);
    const res = JSON.parse(out.join('\n'));
    expect(res.results.map((r: { promiseId: string; from: string }) => `${r.promiseId} ${r.from}`)).toEqual([
      'praesidia.02 skipped',
      'praesidia.03 rule',
      'privacy.01 rule',
      'privacy.03 skipped',
      'security.01 rule',
      'security.03 skipped',
    ]);
  });
  it('bind list shows where each binding is now: unchanged, or changed on the agent branch', async () => {
    const root = await workspace();
    expect(await runBindCommand(ctx(root, ['--no-model']).c)).toBe(0);
    git(root, 'checkout', '-q', '-b', 'agent/retention');
    commitAll(root, { 'src/agent/chats.ts': CHATS.replace('= 30', '= 90') });
    const { c, out } = ctx(root, ['list']);
    expect(await runBindCommand(c)).toBe(0);
    const text = out.join('\n');
    expect(text).toContain('privacy.01   -> src/agent/chats.ts:2 CHAT_TTL_DAYS (expects <= 30 days)  constant, rule  changed: now CHAT_TTL_DAYS = 90 at line 2');
    expect(text).toContain('security.01  -> src/routes/export.ts:8-9 requireAdmin  guard, rule  unchanged');
    expect(text).toContain(`Next: ${BRAND.command} check`);
  });
  it('one promise by id, and plain errors for unknown or process promises', async () => {
    const root = await workspace();
    const one = ctx(root, ['privacy.03', '--scripted', SCRIPTED_ACME]);
    expect(await runBindCommand(one.c)).toBe(0);
    expect(one.out.join('\n')).toContain('privacy.03 -> src/routes/export.ts:12 send  call, from the model');
    await expect(runBindCommand(ctx(root, ['nope.01']).c)).rejects.toThrow(/there is no promise nope\.01/u);
  });
});

describe('rule propose --accept saves bindings from the accepted rules', () => {
  it('writes bindings.json next to rules.json (one call in rule.ts)', async () => {
    const root = makeRepo(ACME_FILES);
    dirs.push(root);
    const store = await initWorkspace(root, DEFAULT_CONFIG);
    await store.writePromises('privacy', [P.privacy01]);
    const { c } = ctx(root, ['propose', 'privacy.01', '--accept', '--scripted', SCRIPTED_ACME]);
    expect(await runRuleCommand(c)).toBe(0);
    expect((await readBindings(store)).map((b) => `${b.id} ${b.symbol} ${b.foundBy}`)).toEqual(['B-privacy.01-1 CHAT_TTL_DAYS rule']);
  });
});

describe('R5-B: bind live counts agree with the table', () => {
  it('the live summary counts only promises that end with a checked location', async () => {
    const root = await workspace();
    const { c: c0, out, err } = ctx(root, ['--all', '--scripted', SCRIPTED_ACME]);
    const c = { ...c0, env: { JURATOR_PLAIN: '1' } };
    expect(await runBindCommand(c)).toBe(0);
    const summary = err.find((l) => /^\S+ bind {2}\d+\/\d+ promises/u.test(l)) ?? '';
    expect(summary).toMatch(/3\/3 promises · 3 bound by the model/u);
    expect(out.join('\n')).toContain('6 of 6 code promises bound: 3 from rules (no AI), 3 from the model');
  });
});
