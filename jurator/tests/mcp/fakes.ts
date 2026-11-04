// Fakes for tests/mcp: an in-memory store and git with a small acme-like app. No disk, no network.
import type {
  CheckRun,
  Config,
  Contradiction,
  GitRepo,
  PromiseRecord,
  Rule,
  Store,
} from '../../src/contracts.js';
import { DEFAULT_CONFIG } from '../../src/contracts.js';
import { matchesAny } from '../../src/util/glob.js';

export const BASE = 'a'.repeat(40);
export const HEAD = 'b'.repeat(40);
const POLICY_SHA = 'c'.repeat(64);
const AT = '2026-11-04T03:00:00.000Z';

const EXPORT_MAIN = [
  "import { requireAdmin } from '../auth/require-admin.js';",
  "import { router } from '../http.js';",
  '',
  "router.get('/export', async (req, res) => {",
  '  requireAdmin(req);',
  "  res.send('ok');",
  '});',
  '',
].join('\n');
const EXPORT_FEATURE = `${EXPORT_MAIN}\nrouter.get('/export.csv', async (req, res) => {\n  res.send('csv');\n});\n`;

export const FILES_BASE: Record<string, string> = {
  'src/routes/export.ts': EXPORT_MAIN,
  'src/agent/chats.ts': 'export const CHAT_TTL_DAYS = 30;\n',
  'docs/security.md': '# Security\n\n1. Only workspace admins can export customer data.\n',
};
export const FILES_HEAD: Record<string, string> = { ...FILES_BASE, 'src/routes/export.ts': EXPORT_FEATURE };

// No parameter properties here: the spawned server runs this file with Node's type stripping, which forbids them.
export class FakeRepo implements GitRepo {
  readonly root = '/work/acme-notes';
  readonly files: Record<string, Record<string, string>> = { [HEAD]: FILES_HEAD, [BASE]: FILES_BASE };
  readonly changed: string[] = ['src/routes/export.ts'];
  async snapshot() {
    return { repo: this.root, branch: 'feature/csv-export', commit: HEAD, dirty: false };
  }
  async resolve(ref: string) {
    if (ref === 'HEAD' || ref === HEAD) return HEAD;
    if (ref === 'main' || ref === BASE) return BASE;
    throw new Error(`unknown ref ${ref}`);
  }
  async listFiles(commit: string, globs: readonly string[]) {
    return Object.keys(this.files[commit] ?? {})
      .filter((p) => matchesAny(p, globs))
      .sort();
  }
  async readFile(commit: string, path: string) {
    const text = this.files[commit]?.[path];
    if (text === undefined) throw new Error(`no ${path} at ${commit}`);
    return text;
  }
  async changedFiles(base: string) {
    await this.resolve(base);
    return [...this.changed];
  }
}

export class FakeStore implements Store {
  readonly repoRoot = '/work/acme-notes';
  readonly dir = '/work/acme-notes/.jurator';
  readonly runs: CheckRun[] = [];
  promises: PromiseRecord[] = PROMISES;
  rules: Rule[] = RULES;
  contradictions: Contradiction[] = CONTRADICTIONS;
  config: Config = CONFIG;
  present = true;
  async exists() {
    return this.present;
  }
  async readConfig() {
    return this.config;
  }
  async readPromises() {
    return this.promises;
  }
  async readRules() {
    return this.rules;
  }
  async readContradictions() {
    return this.contradictions;
  }
  async writeRun(run: CheckRun) {
    this.runs.push(run);
    return `${this.dir}/local/runs/${run.id}/run.json`;
  }
  // The MCP tools never write promises, rules, config or sources: these throw so a test would catch it.
  async writeConfig(): Promise<void> {
    throw new Error('MCP must not write config');
  }
  async readLock() {
    return [];
  }
  async writeLock(): Promise<void> {
    throw new Error('MCP must not write the lock');
  }
  async saveSourceText(): Promise<string> {
    throw new Error('MCP must not save sources');
  }
  async readSourceText() {
    return '';
  }
  async writePromises(): Promise<void> {
    throw new Error('MCP must not write promises');
  }
  async writeContradictions(): Promise<void> {
    throw new Error('MCP must not write contradictions');
  }
  async writeRules(): Promise<void> {
    throw new Error('MCP must not write rules');
  }
}

export const CONFIG: Config = {
  ...DEFAULT_CONFIG,
  codeScope: ['src/**'],
  sources: [
    { alias: 'privacy', connector: 'file', locator: 'docs/privacy.md' },
    { alias: 'security', connector: 'file', locator: 'docs/security.md' },
    { alias: 'praesidia', connector: 'praesidia', locator: 'policies/praesidia-support-agent.json' },
  ],
};

export function promise(id: string, over: Partial<PromiseRecord> = {}): PromiseRecord {
  const alias = id.split('.')[0] as string;
  return {
    id,
    status: 'accepted',
    wording: `Wording of ${id}.`,
    quote: { alias, policySha256: POLICY_SHA, text: `Policy text of ${id}.`, line: 3 },
    kind: 'must',
    checkable: 'code',
    scope: [],
    foundBy: 'model',
    firstSeen: AT,
    ...over,
  };
}

export const PROMISES: PromiseRecord[] = [
  promise('privacy.01', {
    wording: 'Support chats are deleted after 30 days.',
    quote: { alias: 'privacy', policySha256: POLICY_SHA, text: 'We delete support chats after 30 days.', line: 5 },
    scope: ['src/agent/**'],
  }),
  promise('privacy.02', { wording: 'Exports leave out deleted notes.' }),
  promise('privacy.03', { status: 'draft', wording: 'A draft the agent must not see.' }),
  promise('security.01', {
    wording: 'Only workspace admins can export customer data.',
    quote: { alias: 'security', policySha256: POLICY_SHA, text: 'Only workspace admins can export customer data.', line: 3 },
    scope: ['src/routes/**'],
  }),
  promise('security.02', { checkable: 'process', wording: 'A second engineer reviews every export change.', scope: ['src/routes/**'] }),
  promise('praesidia.01', {
    checkable: 'runtime',
    wording: 'The support agent keeps data for at most 90 days.',
    quote: { alias: 'praesidia', policySha256: POLICY_SHA, text: '90', jsonPointer: '/dataRetentionDays' },
    foundBy: 'structured',
  }),
];

export const RULES: Rule[] = [
  {
    id: 'R-security.01-1',
    promiseId: 'security.01',
    description: 'Every route definition calls requireAdmin( within 3 lines.',
    mode: 'each-near',
    anchor: 'router\\.get\\(',
    pattern: 'requireAdmin\\(',
    within: 3,
    globs: ['src/routes/**'],
    provenBy: { mutation: 'removed the requireAdmin( lines', failedAsExpected: true, at: AT },
    status: 'accepted',
    author: 'model',
    createdAt: AT,
  },
  {
    id: 'R-privacy.01-1',
    promiseId: 'privacy.01',
    description: 'CHAT_TTL_DAYS is 30.',
    mode: 'must-match',
    pattern: 'CHAT_TTL_DAYS\\s*=\\s*30\\b',
    globs: ['src/agent/**'],
    provenBy: { mutation: 'set CHAT_TTL_DAYS to 31', failedAsExpected: true, at: AT },
    status: 'accepted',
    author: 'model',
    createdAt: AT,
  },
];

export const CONTRADICTIONS: Contradiction[] = [
  {
    id: 'C-1',
    promiseIds: ['privacy.01', 'praesidia.01'],
    example: 'A chat from 1 Mar must be gone by 31 Mar but may stay until 30 May.',
    status: 'open',
    foundBy: 'structured',
  },
];
