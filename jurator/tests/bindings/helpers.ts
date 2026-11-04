// Test helpers for tests/bindings: acme-like files, promise and rule records, a scripted model, temp git repos.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ModelClient, ModelJsonRequest, ModelJsonResult, PromiseRecord, Rule, SourceFile } from '../../src/contracts.js';
import { JuratorError } from '../../src/util/errors.js';

export const SCRIPTED_ACME = join(import.meta.dirname, '../../fixtures/scripted/acme');
export const COMMIT = 'abc1234abc1234abc1234abc1234abc1234abc12';

export const CHATS = [
  '/** Support chats older than this are deleted by the nightly job. */',
  'export const CHAT_TTL_DAYS = 30;',
  '',
  'export function isExpired(createdAt: Date, now: Date): boolean {',
  '  return now.getTime() - createdAt.getTime() > CHAT_TTL_DAYS * 24 * 60 * 60 * 1000;',
  '}',
  '',
].join('\n');
export const EXPORT_ROUTE = [
  "import { requireAdmin } from '../auth/require-admin.js';",
  "import { exportableNotes, type Note } from '../export/query.js';",
  "import { router } from '../http.js';",
  "import { log } from '../log.js';",
  '',
  'const db: { notes: Note[] } = { notes: [] };',
  '',
  "router.get('/export', async (req, res) => {",
  '  requireAdmin(req);',
  '  const notes = exportableNotes(db.notes, req.workspaceId);',
  "  log('export', { workspaceId: req.workspaceId, count: notes.length });",
  '  res.send(JSON.stringify(notes));',
  '});',
  '',
].join('\n');
export const TOOLS = [
  "import { approvalGate } from './praesidia.js';",
  '',
  '/** Tools the support agent may call. export_notes goes through Praesidia approval. */',
  'export const tools = {',
  '  search_notes: async (query: string) => ({ query, results: [] as string[] }),',
  '  export_notes: async (workspaceId: string) => {',
  "    await approvalGate('export_notes', { workspaceId });",
  "    return { workspaceId, status: 'queued' };",
  '  },',
  '};',
  '',
].join('\n');
export const PRAESIDIA = [
  '// Stand-in for the Praesidia SDK: asks for human approval before a risky tool runs.',
  'export async function approvalGate(tool: string, args: Record<string, unknown>): Promise<void> {',
  '  void tool; void args;',
  '}',
  '',
].join('\n');
export const LOG = [
  "const SECRET_KEYS = ['password', 'cardNumber', 'cvc'];",
  '',
  '/** Structured logger that drops secret fields before writing. */',
  'export function log(event: string, fields: Record<string, unknown> = {}): void {',
  '  const safe = Object.fromEntries(Object.entries(fields).filter(([key]) => !SECRET_KEYS.includes(key)));',
  '  process.stdout.write(`${JSON.stringify({ event, ...safe })}\\n`);',
  '}',
  '',
].join('\n');

export const ACME_FILES: Record<string, string> = {
  'src/agent/chats.ts': CHATS,
  'src/agent/tools.ts': TOOLS,
  'src/agent/praesidia.ts': PRAESIDIA,
  'src/routes/export.ts': EXPORT_ROUTE,
  'src/log.ts': LOG,
};
export const files = (map: Record<string, string> = ACME_FILES): SourceFile[] =>
  Object.entries(map)
    .map(([path, text]) => ({ path, text }))
    .sort((a, b) => (a.path < b.path ? -1 : 1));

const SHA = 'a'.repeat(64);
export function promise(id: string, wording: string, scope: string[] = [], extra: Partial<PromiseRecord> = {}): PromiseRecord {
  return {
    id,
    status: 'accepted',
    wording,
    quote: { alias: id.split('.')[0] as string, policySha256: SHA, text: wording },
    kind: 'must',
    checkable: 'code',
    scope,
    foundBy: 'model',
    firstSeen: '2026-11-04T03:00:00.000Z',
    ...extra,
  };
}
export const P = {
  privacy01: promise('privacy.01', 'Support chats are deleted after 30 days.', ['src/agent/**'], {
    facets: { subject: 'support chats', action: 'keep', constraint: { name: 'retention', op: '<=', value: '30', unit: 'days' } },
  }),
  security01: promise('security.01', 'Only workspace admins can export customer data.', ['src/routes/**'], {
    facets: { subject: 'customer data', action: 'export', constraint: { name: 'role', op: '==', value: 'admin', unit: null } },
  }),
  security03: promise('security.03', 'Card numbers and passwords are never written to logs.', ['src/**'], { kind: 'must-not' }),
  praesidia02: promise('praesidia.02', 'search_notes needs approval before it runs.', [], {
    facets: { subject: 'search_notes', action: 'require approval', constraint: { name: 'before it runs', op: 'always', value: null, unit: null } },
  }),
  praesidia03: promise('praesidia.03', 'export_notes needs approval before it runs.', []),
  privacy03: promise('privacy.03', 'Notes are never sold or shared with advertisers.', ['src/routes/**'], { kind: 'must-not' }),
};

export function rule(over: Partial<Rule> & Pick<Rule, 'id' | 'promiseId' | 'mode' | 'pattern'>): Rule {
  return {
    description: 'test rule',
    globs: ['src/**'],
    provenBy: { mutation: 'test', failedAsExpected: true, at: '2026-11-04T03:00:00.000Z' },
    status: 'accepted',
    author: 'model',
    createdAt: '2026-11-04T03:00:00.000Z',
    ...over,
  };
}
export const R = {
  privacy01: rule({ id: 'R-privacy.01-1', promiseId: 'privacy.01', mode: 'must-match', pattern: 'CHAT_TTL_DAYS\\s*=\\s*(?:[0-9]|[12][0-9]|30)\\b', globs: ['src/agent/**'] }),
  security01: rule({
    id: 'R-security.01-1',
    promiseId: 'security.01',
    mode: 'each-near',
    pattern: 'requireAdmin\\(',
    anchor: "router\\.(?:get|post)\\(\\s*['\"]/export",
    within: 3,
    globs: ['src/routes/**'],
  }),
  security03: rule({ id: 'R-security.03-1', promiseId: 'security.03', mode: 'must-not-match', pattern: '\\blog\\([^)]*\\bpassword\\b', globs: ['src/**'] }),
  praesidia03: rule({ id: 'R-praesidia.03-1', promiseId: 'praesidia.03', mode: 'must-match', pattern: "approvalGate\\(\\s*['\"]export_notes['\"]", globs: ['src/agent/**'] }),
};

/** Reads `<dir>/<task with ':' -> '__'>.json`, like the scripted client; records the tasks it answered. */
export function scriptedModel(dir: string, calls: string[] = []): ModelClient {
  return {
    id: 'scripted',
    mode: 'scripted',
    async json<T>(request: ModelJsonRequest<T>): Promise<ModelJsonResult<T>> {
      calls.push(request.task);
      const file = join(dir, `${request.task.replaceAll(':', '__')}.json`);
      if (!existsSync(file)) throw new JuratorError('NO_SCRIPTED_ANSWER', `no scripted answer ${file}`);
      return { value: request.schema.parse(JSON.parse(readFileSync(file, 'utf8'))), usage: { id: 'scripted', mode: 'scripted', inputTokens: 0, outputTokens: 0, usd: 0 } };
    },
  };
}
/** A model that answers every task with `answer`. */
export function fixedModel(answer: unknown, calls: string[] = []): ModelClient {
  return {
    id: 'fixed',
    mode: 'scripted',
    async json<T>(request: ModelJsonRequest<T>): Promise<ModelJsonResult<T>> {
      calls.push(request.task);
      return { value: request.schema.parse(answer), usage: { id: 'fixed', mode: 'scripted', inputTokens: 1, outputTokens: 1, usd: 0.001 } };
    },
  };
}

export function tempDir(prefix = 'kw-bind-'): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}
export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
export function writeFiles(root: string, map: Record<string, string>): void {
  for (const [path, text] of Object.entries(map)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
}
/** A temp repo with one commit on main; returns the root. */
export function makeRepo(map: Record<string, string> = ACME_FILES): string {
  const root = tempDir();
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'commit.gpgsign', 'false');
  writeFiles(root, map);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'init');
  return root;
}
export function commitAll(root: string, map: Record<string, string>, message = 'change'): string {
  writeFiles(root, map);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', message);
  return git(root, 'rev-parse', 'HEAD');
}
export function cleanup(...dirs: string[]): void {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
}
