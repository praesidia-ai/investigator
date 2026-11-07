// AC-C (SC-3 fix 7): a promise about "the backend" or "the extension" covers every code folder of that repo. In
// a real run every backend promise was scoped to src/** (the cache write is in workers/**) and every extension promise
// to src/** (the Anthropic calls are in ai-mode/src/**), because the compiler allowed 3 globs and never saw the folders.
import { describe, expect, it, vi } from 'vitest';
import type { PromiseRecord } from '../../src/contracts.js';
import { compilePolicy, MAX_SCOPE_GLOBS, wholePartRepo, widenToRepoFolders } from '../../src/policy/compile.js';
import { COMPILE_INSTRUCTIONS, compileInput, repoCodeFolders } from '../../src/policy/prompts.js';
import { capture, doc, NOW } from './helpers.js';

vi.mock('../../src/connectors/index.js', () => ({
  getConnector: (id: string) => ({ id, readOnly: true, fetch: async () => { throw new Error('unused'); } }),
}));

const BACKEND = 'backend-api';
const EXT = 'chrome-extension';
const REPOS = [EXT, BACKEND];
// The investigator workspace's codeScope (.jurator/config.json).
const CODE_SCOPE = [`${EXT}/ai-mode/src/**`, `${EXT}/src/**`, `${BACKEND}/pipeline/**`, `${BACKEND}/src/**`, `${BACKEND}/workers/**`];
const CODE_FILES = [
  `${EXT}/ai-mode/src/agent/model/claude.ts`,
  `${EXT}/ai-mode/src/agent/record.ts`,
  `${EXT}/src/contentScript/services/BaseActionService.ts`,
  `${EXT}/src/screens/ClipboardScreen.tsx`,
  `${EXT}/src/utils/storage.ts`,
  `${BACKEND}/pipeline/ocr/run.py`,
  `${BACKEND}/src/api/__init__.py`,
  `${BACKEND}/src/api/routes/clipboard.py`,
  `${BACKEND}/src/config.py`,
  `${BACKEND}/src/services/result_cache.py`,
  `${BACKEND}/workers/extraction/general/worker.py`,
].sort();
const HINTS = { repos: REPOS, codeScope: CODE_SCOPE };
const ALL_BACKEND = [`${BACKEND}/pipeline/**`, `${BACKEND}/src/**`, `${BACKEND}/workers/**`];
const ALL_EXT = [`${EXT}/ai-mode/src/**`, `${EXT}/src/**`];
const sorted = (xs: readonly string[]): string[] => [...xs].sort();

const POLICY = `# Document handling policy

2. The backend keeps clipboard documents and their extracted text only in memory.
4. The extension keeps clipboard documents only in memory and never writes them to chrome.storage, IndexedDB or localStorage.
9. Every backend API request must carry a valid signed access token.
11. Document text is only sent to approved AI providers: OpenAI.
13. Document contents and extracted text are never written to logs.
`;
const Q2 = 'The backend keeps clipboard documents and their extracted text only in memory.';
const Q4 = 'The extension keeps clipboard documents only in memory and never writes them to chrome.storage, IndexedDB or localStorage.';
const Q9 = 'Every backend API request must carry a valid signed access token.';
const Q13 = 'Document contents and extracted text are never written to logs.';

const draft = (quote: string, wording: string, scope: string[], kind = 'must-not') => ({
  quote, wording, kind, checkable: 'code', scope, params: [], sameAs: null, facets: null,
});

describe('the compile prompt (AC-C)', () => {
  it('asks for up to 6 globs and every code folder of a whole part', () => {
    expect(MAX_SCOPE_GLOBS).toBe(6);
    expect(COMPILE_INSTRUCTIONS).toContain('- scope: 0 to 6 globs over the listed code files');
    expect(COMPILE_INSTRUCTIONS).not.toContain('0 to 3 globs');
    expect(COMPILE_INSTRUCTIONS.replace(/\s+/gu, ' ')).toContain(
      'When the promise names a whole part of the product ("the backend", "the extension"), cover every code folder of that repo (each glob on its "code folders" line, such as src, workers, pipeline), not only src.',
    );
    expect(COMPILE_INSTRUCTIONS.replace(/\s+/gu, ' ')).toContain('or names no part of the product, give globs for each repo whose code could break it.');
  });

  it('the workspace overview lists each repo\'s code folders from the code scope', () => {
    const input = compileInput({ alias: 'd', locator: 'p.md', text: POLICY, codeFiles: CODE_FILES, existing: [], repos: REPOS, codeScope: CODE_SCOPE });
    expect(input).toContain(`  code folders: ${BACKEND}/pipeline/**, ${BACKEND}/src/**, ${BACKEND}/workers/**`);
    expect(input).toContain(`  code folders: ${EXT}/ai-mode/src/**, ${EXT}/src/**`);
    // Without the code scope (older callers): no such line; single repo: the plain file list.
    expect(compileInput({ alias: 'd', locator: 'p.md', text: POLICY, codeFiles: CODE_FILES, existing: [], repos: REPOS })).not.toContain('code folders:');
    expect(compileInput({ alias: 'd', locator: 'p.md', text: POLICY, codeFiles: ['src/a.ts'], existing: [], codeScope: ['src/**'] })).not.toContain('code folders:');
  });

  it('repoCodeFolders: the repo\'s own code-scope globs that hold code, sorted', () => {
    expect(repoCodeFolders(BACKEND, CODE_SCOPE, CODE_FILES)).toEqual(ALL_BACKEND);
    expect(repoCodeFolders(EXT, CODE_SCOPE, CODE_FILES)).toEqual(ALL_EXT);
    // A folder with no code is left out; a glob naming no repo is not any repo's folder.
    const noPipeline = CODE_FILES.filter((f) => !f.includes('/pipeline/'));
    expect(repoCodeFolders(BACKEND, [...CODE_SCOPE, '**/*.py'], noPipeline)).toEqual([`${BACKEND}/src/**`, `${BACKEND}/workers/**`]);
    expect(repoCodeFolders(BACKEND, CODE_SCOPE, [])).toEqual(ALL_BACKEND);
  });
});

describe('wholePartRepo: the subject is the part itself', () => {
  it.each([
    ['The backend must keep extracted text of clipboard documents only in memory.', BACKEND],
    ['The backend never writes clipboard documents to disk.', BACKEND],
    ['The extension must not write clipboard documents to chrome.storage.', EXT],
    ['The browser extension keeps clipboard documents only in memory.', EXT],
    ['The Chrome extension must ask the backend to delete clipboard documents.', EXT],
    ['The backend API must reject requests without a signed token.', BACKEND],
  ])('%s -> %s', (wording, repo) => expect(wholePartRepo(wording, REPOS)).toBe(repo));

  it.each([
    'Every backend API request must carry a valid signed access token.',
    'Extraction results for a clipboard document must be kept for at most 24 hours.',
    'Document text must be sent only to OpenAI among approved AI providers.',
    'Backend logs must not contain passwords.',
    'The extension and the backend must not log access tokens.',
    'A user must access only documents belonging to an agency of the user.',
  ])('%s -> none', (wording) => expect(wholePartRepo(wording, REPOS)).toBeNull());
});

describe('widenToRepoFolders on the SC-1/SC-2 promises', () => {
  const widen = (wording: string, scope: string[]) => widenToRepoFolders(scope, wording, HINTS, CODE_FILES);

  it('.03 "The backend ..." scoped to src/** reaches workers/** (the result_cache write at worker.py:2383) and pipeline/**', () => {
    const r = widen('The backend must keep extracted text of clipboard documents only in memory.', [`${BACKEND}/src/**`]);
    expect(r.scope).toEqual([`${BACKEND}/src/**`, `${BACKEND}/pipeline/**`, `${BACKEND}/workers/**`]);
    expect(r.added).toEqual([`${BACKEND}/pipeline/**`, `${BACKEND}/workers/**`]);
  });

  it('.13 "The extension ..." scoped to src/** reaches ai-mode/src/**', () => {
    expect(sorted(widen('The extension must not write clipboard documents to chrome.storage.', [`${EXT}/src/**`]).scope)).toEqual(ALL_EXT);
  });

  it('a whole-part promise with a narrow scope covers the whole repo; the narrow glob inside src/** goes', () => {
    const r = widen('The backend must not write a clipboard document to disk.', [`${BACKEND}/src/services/**`, `${BACKEND}/src/config.py`]);
    expect(sorted(r.scope)).toEqual(ALL_BACKEND);
  });

  it('.26/.27 (no part named, both src/**) reach ai-mode, pipeline and workers', () => {
    const r = widen('Extracted text must not be written to logs.', [`${EXT}/src/**`, `${BACKEND}/src/**`]);
    expect(sorted(r.scope)).toEqual(sorted([...ALL_EXT, ...ALL_BACKEND]));
    expect(r.scope.length).toBeLessThanOrEqual(CODE_SCOPE.length);
  });

  it('.16 (the extension asks the backend) covers both repos', () => {
    const r = widen('The extension must ask the backend to delete clipboard documents when a user clears a clipboard.', [`${EXT}/src/**`, `${BACKEND}/src/**`]);
    expect(sorted(r.scope)).toEqual(sorted([...ALL_EXT, ...ALL_BACKEND]));
  });

  it('.24 (backend src/** only) gets the backend folders; reaching ai-mode is the prompt\'s job', () => {
    const r = widen('Document text must be sent only to OpenAI among approved AI providers.', [`${BACKEND}/src/**`]);
    expect(sorted(r.scope)).toEqual(ALL_BACKEND);
  });

  it('.21 "Every backend API request" keeps its narrow scope', () => {
    const r = widen('Every backend API request must carry a valid signed access token.', [`${BACKEND}/src/api/**`]);
    expect(r).toEqual({ scope: [`${BACKEND}/src/api/**`], added: [] });
  });

  it('a repo-wide glob already covers every folder; a single repo changes nothing', () => {
    expect(widen('The backend must keep documents in memory.', [`${BACKEND}/**`])).toEqual({ scope: [`${BACKEND}/**`], added: [] });
    expect(widenToRepoFolders(['src/**'], 'The backend must keep documents in memory.', { repos: ['api'], codeScope: ['src/**', 'workers/**'] }, [])).toEqual({ scope: ['src/**'], added: [] });
  });
});

describe('compilePolicy in a workspace (AC-C)', () => {
  const policy = () => doc('documents', 'file', 'policies/d.md', POLICY);

  it('adds the missing code folders, keeps narrow scopes, shows the code folders to the model, and says so', async () => {
    const model = capture({
      promises: [
        draft(Q2, 'The backend must keep clipboard documents only in memory.', [`${BACKEND}/src/**`], 'must'),
        draft(Q4, 'The extension must not write clipboard documents to IndexedDB.', [`${EXT}/src/**`]),
        draft(Q9, 'Every backend API request must carry a valid signed access token.', [`${BACKEND}/src/api/**`], 'must'),
        draft(Q13, 'Extracted text must not be written to logs.', [`${EXT}/src/**`, `${BACKEND}/src/**`]),
        draft(Q2, 'The backend must keep extracted text only in memory.', [], 'must'),
      ],
    });
    const r = await compilePolicy(policy(), [], model, NOW, { codeFiles: CODE_FILES, workspace: HINTS });
    expect(model.inputs[0]).toContain(`  code folders: ${BACKEND}/pipeline/**, ${BACKEND}/src/**, ${BACKEND}/workers/**`);
    const scopes = r.promises.map((p) => sorted(p.scope));
    expect(scopes[0]).toEqual(ALL_BACKEND);
    expect(scopes[1]).toEqual(ALL_EXT);
    expect(scopes[2]).toEqual([`${BACKEND}/src/api/**`]);
    expect(scopes[3]).toEqual(sorted([...ALL_EXT, ...ALL_BACKEND]));
    // Empty scope: every code folder of the named repo (was the first 3 of the code scope).
    expect(scopes[4]).toEqual(ALL_BACKEND);
    expect(r.notes?.filter((n) => n.includes('scope covers every code folder of the repo: added')).length).toBe(3);
    expect(r.notes?.some((n) => n.includes('no scope -> '))).toBe(true);
  });

  it('keeps at most 6 of the model\'s globs, then adds the folders', async () => {
    const many = [`${EXT}/src/screens/**`, `${EXT}/src/utils/**`, `${EXT}/src/contentScript/**`, `${BACKEND}/src/api/**`, `${BACKEND}/src/services/**`, `${BACKEND}/src/config.py`, `${BACKEND}/workers/extraction/**`];
    const model = capture({ promises: [draft(Q13, 'Document contents must not be written to logs.', many)] });
    const r = await compilePolicy(policy(), [], model, NOW, { codeFiles: CODE_FILES, workspace: HINTS });
    expect(r.promises[0]?.scope).toEqual(many.slice(0, 6));
  });

  it('an accepted promise keeps its scope but gains the missing folders on recompile, with a note', async () => {
    const answer = { promises: [draft(Q2, 'The backend must keep clipboard documents only in memory.', [`${BACKEND}/src/**`], 'must')] };
    const first = await compilePolicy(policy(), [], capture(answer), NOW, { codeFiles: CODE_FILES });
    // Accepted under the old cap: src/** only (no workspace hints then, so nothing was added).
    const before: PromiseRecord[] = first.promises.map((p) => ({ ...p, status: 'accepted' as const, scope: [`${BACKEND}/src/**`] }));
    expect(before[0]?.scope).toEqual([`${BACKEND}/src/**`]);
    const again = await compilePolicy(policy(), before, capture({ promises: [draft(Q2, 'The backend must keep clipboard documents only in memory.', [`${BACKEND}/src/api/**`], 'must')] }), NOW, {
      codeFiles: CODE_FILES,
      workspace: HINTS,
    });
    const p = again.promises[0] as PromiseRecord;
    expect(p.id).toBe(before[0]?.id);
    expect(p.status).toBe('accepted');
    expect(p.scope).toEqual([`${BACKEND}/src/**`, `${BACKEND}/pipeline/**`, `${BACKEND}/workers/**`]);
    expect(again.notes?.some((n) => n.includes(`(${p.id}, accepted): scope covers every code folder of the repo: added ${BACKEND}/pipeline/**, ${BACKEND}/workers/**`))).toBe(true);
    // A narrow accepted scope of something that is not a whole part stays as reviewed.
    const narrow = before.map((x) => ({ ...x, wording: 'Every backend API request must carry a valid signed access token.', scope: [`${BACKEND}/src/api/**`] }));
    const kept = await compilePolicy(policy(), narrow, capture(answer), NOW, { codeFiles: CODE_FILES, workspace: HINTS });
    expect(kept.promises[0]?.scope).toEqual([`${BACKEND}/src/api/**`]);
  });
});
