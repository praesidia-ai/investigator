// R5-A item 1: in a workspace the compiler sees every repo (not the first 400 sorted files, which were all extension in
// the live run), and every code promise's scope names an existing repo (repaired by the program when it does not).
import { describe, expect, it, vi } from 'vitest';
import type { ModelClient, ModelJsonRequest, ModelJsonResult } from '../../src/contracts.js';
import { compilePolicy, repoFromWording } from '../../src/policy/compile.js';
import { compileInput, repoOverview } from '../../src/policy/prompts.js';
import { doc, NOW } from './helpers.js';

vi.mock('../../src/connectors/index.js', () => ({
  getConnector: (id: string) => ({ id, readOnly: true, fetch: async () => { throw new Error('unused'); } }),
}));

const POLICY = `# Document handling policy

1. The extension may send a clipboard document to the backend for extraction.
2. The backend keeps clipboard documents and their extracted text only in memory.
3. The backend never writes a clipboard document or its extracted text to disk, to a database, to a cache, or to cloud storage such as an S3 bucket.
4. The extension keeps clipboard documents only in memory and never writes them to chrome.storage, IndexedDB or localStorage.
9. Every backend API request must carry a valid signed access token.
`;
const REPOS = ['chrome-extension', 'backend-api'];
const CODE_SCOPE = ['chrome-extension/ai-mode/src/**', 'chrome-extension/src/**', 'backend-api/src/**', 'backend-api/workers/**'];
const CODE_FILES = [
  ...Array.from({ length: 500 }, (_, i) => `chrome-extension/ai-mode/src/client/m${String(i).padStart(3, '0')}.ts`),
  'chrome-extension/src/api/http.ts',
  'chrome-extension/src/clipboard/ClipboardHistoryService.ts',
  'backend-api/src/api/routes/clipboard.py',
  'backend-api/src/services/document_cache.py',
  'backend-api/src/auth/tokens.py',
  'backend-api/workers/extract.py',
].sort();

function capture(answer: unknown): ModelClient & { inputs: string[] } {
  const inputs: string[] = [];
  return {
    id: 'capture',
    mode: 'scripted',
    inputs,
    async json<T>(req: ModelJsonRequest<T>): Promise<ModelJsonResult<T>> {
      inputs.push(req.input);
      return { value: req.schema.parse(answer), usage: { id: 'capture', mode: 'scripted', inputTokens: 0, outputTokens: 0, usd: 0 } };
    },
  };
}
const draft = (quote: string, wording: string, scope: string[]) => ({
  quote, wording, kind: 'must-not', checkable: 'code', scope, params: [], sameAs: null, facets: null,
});

describe('compile in a workspace', () => {
  it('the prompt shows one overview per repo, with the backend, instead of the first 400 sorted files', () => {
    const input = compileInput({ alias: 'documents', locator: 'policies/d.md', text: POLICY, codeFiles: CODE_FILES, existing: [], repos: REPOS });
    expect(input).toContain('Code repos in this workspace');
    expect(input).toMatch(/- backend-api: 4 code files; languages: Python 4/u);
    expect(input).toMatch(/- chrome-extension: 502 code files; languages: TypeScript 502/u);
    expect(input).toContain('backend-api/src/api/routes/clipboard.py');
    expect(input).toContain('chrome-extension/src/clipboard/ClipboardHistoryService.ts');
    expect(input).toContain('chrome-extension/ai-mode/src/ (500)');
    // Single repo: unchanged file list.
    const single = compileInput({ alias: 'documents', locator: 'p.md', text: POLICY, codeFiles: ['src/a.ts'], existing: [] });
    expect(single).toContain('Code files (choose scope globs from these):\nsrc/a.ts');
  });
  it('the overview is short even for a big repo', () => {
    const big = Array.from({ length: 5000 }, (_, i) => `r/src/f${i}.ts`);
    expect(repoOverview(big, ['r'], POLICY).split('\n').length).toBeLessThan(50);
  });
  it('repoFromWording: "the backend" and "the extension" pick their repo; both or neither pick none', () => {
    expect(repoFromWording('The backend must not write extracted text to disk.', REPOS)).toBe('backend-api');
    expect(repoFromWording('The extension must not write clipboard documents to IndexedDB.', REPOS)).toBe('chrome-extension');
    expect(repoFromWording('The extension may send a clipboard document to the backend.', REPOS)).toBeNull();
    expect(repoFromWording('Passwords must not be written to logs.', REPOS)).toBeNull();
  });
  it('scopes that name no repo are repaired; an empty backend scope gets the backend code scope (R4-I .02-.11)', async () => {
    const q2 = 'The backend keeps clipboard documents and their extracted text only in memory.';
    const q3 = 'The backend never writes a clipboard document or its extracted text to disk, to a database, to a cache, or to cloud storage such as an S3 bucket.';
    const q4 = 'The extension keeps clipboard documents only in memory and never writes them to chrome.storage, IndexedDB or localStorage.';
    const q9 = 'Every backend API request must carry a valid signed access token.';
    const model = capture({
      promises: [
        draft(q2, 'The backend must keep clipboard documents only in memory.', []),
        draft(q3, 'The backend must not write a clipboard document to disk.', ['src/services/**']),
        draft(q4, 'The extension must not write clipboard documents to IndexedDB.', ['src/**']),
        draft(q9, 'Every backend API request must carry a valid signed access token.', ['backend-api/src/auth/**', 'nope/**']),
        draft(q4, 'The extension must keep clipboard documents only in memory.', ['chrome-extension/src/clipboard/**']),
      ],
    });
    const r = await compilePolicy(doc('documents', 'file', 'policies/d.md', POLICY), [], model, NOW, {
      codeFiles: CODE_FILES,
      workspace: { repos: REPOS, codeScope: CODE_SCOPE },
    });
    expect(model.inputs[0]).toContain('- backend-api:');
    const scopes = r.promises.map((p) => p.scope);
    expect(scopes[0]).toEqual(['backend-api/src/**', 'backend-api/workers/**']);
    // AC-C: "The backend ..." covers every backend code folder; src/services/** sits inside src/** and is dropped.
    expect(scopes[1]).toEqual(['backend-api/src/**', 'backend-api/workers/**']);
    // src/** fits both repos; "the extension" breaks the tie; AC-C adds the extension's other code folder.
    expect(scopes[2]).toEqual(['chrome-extension/src/**', 'chrome-extension/ai-mode/src/**']);
    expect(scopes[3]).toEqual(['backend-api/src/auth/**']); // "Every backend API request": narrow scope kept
    expect(scopes[4]).toEqual(['chrome-extension/ai-mode/src/**', 'chrome-extension/src/**']);
    for (const s of scopes) for (const g of s) expect(REPOS.some((repo) => g.startsWith(`${repo}/`)), g).toBe(true);
    expect(r.notes?.some((n) => n.includes('scope repaired to name its repo'))).toBe(true);
  });
  it('a single repo keeps the old behaviour (no repair, no overview)', async () => {
    const model = capture({ promises: [draft(POLICY.split('\n')[3]!.slice(3), 'The backend must keep documents in memory.', [])] });
    const r = await compilePolicy(doc('documents', 'file', 'p.md', POLICY), [], model, NOW, { codeFiles: ['src/a.ts'] });
    expect(r.promises[0]?.scope).toEqual([]);
    expect(model.inputs[0]).toContain('Code files (choose scope globs from these)');
  });
});
