import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommandContext } from '../../src/cli/context.js';
import accept from '../../src/cli/commands/accept.js';
import add from '../../src/cli/commands/add.js';
import compile from '../../src/cli/commands/compile.js';
import conflicts from '../../src/cli/commands/conflicts.js';
import promises from '../../src/cli/commands/promises.js';
import { promiseSchema } from '../../src/contracts.js';
import { runCompile } from '../../src/policy/flows.js';
import { makeStyle } from '../../src/util/term.js';
import {
  ACME_CODE_FILES,
  ACME_FIXTURES,
  doc,
  MemoryStore,
  NOW,
  PRAESIDIA_JSON,
  PRIVACY_MD,
  scriptedModel,
  SECURITY_MD,
} from './helpers.js';

const state = vi.hoisted(() => ({ store: null as unknown as MemoryStore, docs: [] as unknown[], pulls: 0 }));

vi.mock('../../src/connectors/index.js', async () => {
  const h = await import('./helpers.js');
  return {
    getConnector: (id: string) => (id === 'praesidia' ? h.fakePraesidia : { id, readOnly: true, fetch: async () => { throw new Error('unused'); } }),
    makeConnectorContext: () => ({ repoRoot: '/repo', credential: () => undefined, now: () => h.NOW }),
    pullSources: async () => {
      state.pulls += 1;
      return { docs: state.docs, changed: [] };
    },
  };
});
vi.mock('../../src/workspace/index.js', () => ({
  findRepoRoot: async () => state.store.repoRoot,
  openStore: () => state.store,
}));
vi.mock('../../src/git/index.js', async () => {
  const h = await import('./helpers.js');
  return { openRepo: async () => ({ resolve: async () => 'a'.repeat(40), listFiles: async () => h.ACME_CODE_FILES }) };
});
vi.mock('../../src/model/index.js', async () => {
  const h = await import('./helpers.js');
  return {
    createModel: (o: { scriptedDir?: string }) => h.scriptedModel(o.scriptedDir as string),
    tryCreateModel: () => null,
  };
});

const ACME_DOCS = () => [
  doc('privacy', 'file', 'docs/privacy.md', PRIVACY_MD),
  doc('security', 'file', 'docs/security.md', SECURITY_MD),
  doc('praesidia', 'praesidia', 'policies/praesidia-support-agent.json', PRAESIDIA_JSON),
];

function ctxFor(argv: string[]): CommandContext & { lines: string[]; errors: string[] } {
  const lines: string[] = [];
  const errors: string[] = [];
  return {
    cwd: state.store.repoRoot,
    argv,
    env: {},
    out: (l) => lines.push(l),
    err: (l) => errors.push(l),
    style: makeStyle(false),
    now: () => NOW,
    lines,
    errors,
  };
}

beforeEach(() => {
  state.store = new MemoryStore();
  state.store.config = {
    ...state.store.config,
    sources: [
      { alias: 'privacy', connector: 'file', locator: 'docs/privacy.md' },
      { alias: 'security', connector: 'file', locator: 'docs/security.md' },
      { alias: 'praesidia', connector: 'praesidia', locator: 'policies/praesidia-support-agent.json' },
    ],
  };
  state.docs = ACME_DOCS();
  state.pulls = 0;
});

describe('scripted end-to-end compile of the acme policies', () => {
  it('runCompile writes 11 promises with the expected ids and the C-1 retention conflict', async () => {
    const model = scriptedModel(ACME_FIXTURES);
    const report = await runCompile(
      { store: state.store, model, now: NOW, pull: async () => ({ docs: ACME_DOCS() }), codeFiles: async () => ACME_CODE_FILES },
      { accept: false, force: false },
    );
    const all = await state.store.readPromises();
    expect(all.map((p) => p.id).sort()).toEqual([
      'praesidia.01', 'praesidia.02', 'praesidia.03', 'praesidia.04',
      'privacy.01', 'privacy.02', 'privacy.03', 'privacy.04',
      'security.01', 'security.02', 'security.03',
    ]);
    for (const p of all) promiseSchema.parse(p);
    expect(report.sources.map((s) => [s.alias, s.promises, s.found, s.total, s.structured])).toEqual([
      ['privacy', 4, 4, 5, false],
      ['security', 3, 3, 3, false],
      ['praesidia', 4, 4, 4, true],
    ]);
    expect(report.contradictions).toMatchObject([
      { id: 'C-1', promiseIds: ['praesidia.01', 'privacy.01'], status: 'open', foundBy: 'structured' },
    ]);
    expect(report.contradictions[0]?.example).toBe(
      'A support chat from 1 March must be gone by 31 March under privacy.01 but may stay until 30 May under praesidia.01.',
    );
    expect(state.store.contradictions).toHaveLength(1);
    // C-1 comes from comparing typed facets: every pair is decided by the program, so no contradictions model call.
    expect(model.calls.sort()).toEqual(['compile:privacy', 'compile:security']);
    expect(report.conflictCheck).toEqual({ pairs: 55, decided: 55, undecided: 0, modelChecked: false });
    const byId = new Map(all.map((p) => [p.id, p]));
    expect(byId.get('privacy.01')?.facets).toEqual({
      subject: 'support chats',
      action: 'keep',
      constraint: { name: 'retention', op: '<=', value: '30', unit: 'days' },
    });
    expect(byId.get('praesidia.01')?.facets?.constraint).toEqual({ name: 'retention', op: '<=', value: '90', unit: 'days' });
    expect(report.costUsd).toBe(0);

    // Second run: nothing changed, so no model calls and the same ids.
    const again = scriptedModel(ACME_FIXTURES);
    const second = await runCompile(
      { store: state.store, model: again, now: NOW, pull: async () => ({ docs: ACME_DOCS() }), codeFiles: async () => ACME_CODE_FILES },
      { accept: true, force: false },
    );
    expect(again.calls).toEqual([]);
    expect(second.sources.every((s) => s.skipped)).toBe(true);
    expect(second.accepted).toHaveLength(11);
    expect((await state.store.readPromises()).every((p) => p.status === 'accepted')).toBe(true);
    expect(state.store.contradictions.map((c) => c.id)).toEqual(['C-1']);
  });

  it('jurator compile --accept --scripted prints counts, the dropped quote, the conflict and Next', async () => {
    const ctx = ctxFor(['--accept', '--scripted', ACME_FIXTURES]);
    expect(await compile.run(ctx)).toBe(0);
    const out = ctx.lines.join('\n');
    expect(out).toContain('Compiled 3 policy sources (scripted answers, no network)');
    expect(out).toMatch(/privacy +4 promises · 4\/5 quotes found word for word · docs\/privacy\.md/u);
    expect(out).toMatch(/security +3 promises · 3\/3 quotes found word for word/u);
    expect(out).toMatch(/praesidia +4 promises · from settings \(no AI\)/u);
    expect(out).toContain('dropped "Deleted notes are removed from backups within 30 days.": quote not found word for word in docs/privacy.md');
    expect(out).toContain('C-1  open  privacy.01 vs praesidia.01');
    expect(out).toContain('Found by comparing 30 days with 90 days (no AI).');
    expect(out).toContain('Compared 55 pairs of promises by their typed fields (no AI): 1 conflict.');
    expect(out).toContain('praesidia.01   dataRetentionDays: 90  policies/praesidia-support-agent.json:5#/dataRetentionDays');
    expect(out).toContain('"Support chats are deleted after 30 days."  docs/privacy.md:7');
    expect(out).toContain('policies/praesidia-support-agent.json:5#/dataRetentionDays');
    expect(out).toContain('Accepted 11 draft promises.');
    expect(out).toContain('Cost: $0.00 (scripted)');
    expect(ctx.lines.at(-1)).toBe('Next: jurator conflicts (fix one source, then compile again)');
  });

  it('compile --json prints the report', async () => {
    const ctx = ctxFor(['--json', '--scripted', ACME_FIXTURES]);
    expect(await compile.run(ctx)).toBe(0);
    const report = JSON.parse(ctx.lines.join('\n'));
    expect(report.sources).toHaveLength(3);
    expect(report.contradictions[0].id).toBe('C-1');
  });

  it('compile without a model compiles structured sources and stops with MODEL_KEY_REQUIRED on text ones', async () => {
    state.docs = [doc('praesidia', 'praesidia', 'policies/praesidia-support-agent.json', PRAESIDIA_JSON)];
    const ok = ctxFor([]);
    expect(await compile.run(ok)).toBe(0);
    // Structured promises carry facets, so the program still compares them with no model.
    expect(ok.lines.join('\n')).toContain('Conflicts: none found');
    expect(ok.lines.join('\n')).toContain('Compared 6 pairs of promises by their typed fields (no AI): 0 conflicts.');
    state.docs = ACME_DOCS();
    await expect(compile.run(ctxFor([]))).rejects.toMatchObject({ code: 'MODEL_KEY_REQUIRED' });
  });
});

describe('promises, accept, conflicts, add', () => {
  beforeEach(async () => {
    await compile.run(ctxFor(['--scripted', ACME_FIXTURES]));
  });

  it('promises lists drafts with quote locations; --for filters by scope', async () => {
    const ctx = ctxFor([]);
    expect(await promises.run(ctx)).toBe(0);
    expect(ctx.lines[0]).toMatch(/^privacy\.01 +draft +must +code +Support chats are deleted after 30 days\.$/u);
    expect(ctx.lines.join('\n')).toContain('11 promises: 11 draft');
    expect(ctx.lines.at(-1)).toBe('Next: jurator accept --all');

    const forExport = ctxFor(['--for', 'src/routes/export.ts', '--json']);
    expect(await promises.run(forExport)).toBe(0);
    const ids = (JSON.parse(forExport.lines.join('\n')) as Array<{ id: string }>).map((p) => p.id);
    // Scoped promises that cover the export route, plus promises with an empty scope (whole code scope).
    expect(ids).toEqual(expect.arrayContaining(['privacy.02', 'privacy.03', 'security.01', 'security.03', 'praesidia.01']));
    expect(ids).not.toContain('privacy.01');
    expect(ids).not.toContain('security.02');
  });

  it('accept takes ids or --all and refuses unknown ids', async () => {
    const one = ctxFor(['privacy.01', 'security.01']);
    expect(await accept.run(one)).toBe(0);
    expect(one.lines[0]).toBe('Accepted 2 promises: privacy.01 security.01');
    const all = await state.store.readPromises();
    expect(all.filter((p) => p.status === 'accepted').map((p) => p.id)).toEqual(['privacy.01', 'security.01']);

    await expect(accept.run(ctxFor(['privacy.99']))).rejects.toMatchObject({ code: 'UNKNOWN_PROMISE' });
    const rest = ctxFor(['--all']);
    expect(await accept.run(rest)).toBe(0);
    expect((await state.store.readPromises()).every((p) => p.status === 'accepted')).toBe(true);
    expect(await accept.run(ctxFor([]))).toBe(2);
  });

  it('conflicts shows C-1 with both quotes and the example', async () => {
    const ctx = ctxFor([]);
    expect(await conflicts.run(ctx)).toBe(0);
    const out = ctx.lines.join('\n');
    expect(out).toContain('Conflicts: 1 (1 open)');
    expect(out).toContain('praesidia.01');
    expect(out).toContain('Example: A support chat from 1 March must be gone by 31 March under privacy.01 but may stay until 30 May under praesidia.01.');
    expect(out).toContain('Found by comparing 30 days with 90 days (no AI).');
    expect(ctx.lines.at(-1)).toMatch(/^Next: change one of the sources so they agree, then jurator compile/u);
    const asJson = ctxFor(['--json']);
    await conflicts.run(asJson);
    expect(JSON.parse(asJson.lines.join('\n'))[0].id).toBe('C-1');
  });

  it('conflicts --find needs no model: the program re-finds C-1 from the typed facets', async () => {
    state.store.contradictions = [];
    const ctx = ctxFor(['--find']);
    expect(await conflicts.run(ctx)).toBe(0);
    const out = ctx.lines.join('\n');
    expect(out).toContain('C-1  open  privacy.01 vs praesidia.01');
    expect(out).toContain('Found by comparing 30 days with 90 days (no AI).');
    expect(out).toContain('Compared 55 pairs of promises by their typed fields (no AI): 1 conflict.');
    expect(out).toContain('Cost: $0.00');
    expect(state.store.contradictions).toMatchObject([{ id: 'C-1', foundBy: 'structured' }]);
  });

  it('conflicts --rule records a ruling that survives the next compile', async () => {
    const ruled = ctxFor(['--rule', 'C-1', '--as', 'real', '--why', 'Privacy page wins; asked the Praesidia admin for 30 days', '--by', 'reviewer@acme.dev']);
    expect(await conflicts.run(ruled)).toBe(0);
    expect(ruled.lines[0]).toBe('C-1 ruled real by reviewer@acme.dev: Privacy page wins; asked the Praesidia admin for 30 days');
    expect(state.store.contradictions[0]).toMatchObject({ status: 'real', ruling: { by: 'reviewer@acme.dev', at: NOW.toISOString() } });
    await compile.run(ctxFor(['--force', '--scripted', ACME_FIXTURES]));
    expect(state.store.contradictions).toMatchObject([{ id: 'C-1', status: 'real' }]);
    expect(await conflicts.run(ctxFor(['--rule', 'C-1', '--as', 'maybe', '--why', 'x']))).toBe(2);
    await expect(conflicts.run(ctxFor(['--rule', 'C-9', '--as', 'real', '--why', 'because']))).rejects.toMatchObject({ code: 'UNKNOWN_CONFLICT' });
  });

  it('add <file> adds a source; add --promise appends to .jurator/sources/local.md', async () => {
    const root = state.store.repoRoot;
    mkdirSync(join(root, 'docs'), { recursive: true });
    mkdirSync(join(root, 'policies'), { recursive: true });
    writeFileSync(join(root, 'docs', 'Terms of Service.md'), '# Terms\n\n- We keep backups for 7 days.\n');
    writeFileSync(join(root, 'policies', 'agent.json'), PRAESIDIA_JSON);

    const a = ctxFor(['docs/Terms of Service.md']);
    expect(await add.run(a)).toBe(0);
    expect(a.lines[0]).toBe('Added terms-of-service (file: docs/Terms of Service.md).');
    const b = ctxFor(['policies/agent.json', '--alias', 'agent']);
    expect(await add.run(b)).toBe(0);
    expect(state.store.config.sources.at(-1)).toEqual({ alias: 'agent', connector: 'praesidia', locator: 'policies/agent.json' });
    await expect(add.run(ctxFor(['docs/missing.md']))).rejects.toMatchObject({ code: 'BAD_INPUT' });
    await expect(add.run(ctxFor(['policies/agent.json', '--alias', 'privacy']))).resolves.toBe(0); // same file: already a source

    const c = ctxFor(['--promise', 'We never log access tokens.']);
    expect(await add.run(c)).toBe(0);
    expect(await add.run(ctxFor(['--promise', 'We never log access tokens.']))).toBe(0);
    const local = readFileSync(join(root, '.jurator', 'sources', 'local.md'), 'utf8');
    expect(local.match(/We never log access tokens\./gu)).toHaveLength(1);
    expect(state.store.config.sources.find((s) => s.alias === 'local')).toEqual({ alias: 'local', connector: 'file', locator: '.jurator/sources/local.md' });
    expect(await add.run(ctxFor([]))).toBe(2);
  });
});
