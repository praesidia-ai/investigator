// Fakes for tests/check: Store, GitRepo, ModelClient and runRule. No network, no disk.
import type {
  CheckRun,
  Citation,
  Config,
  GitRepo,
  ModelClient,
  ModelJsonRequest,
  ModelJsonResult,
  PromiseRecord,
  Rule,
  RuleRunResult,
  SourceFile,
  Store,
} from '../../src/contracts.js';
import { DEFAULT_CONFIG } from '../../src/contracts.js';
import { matchesAny } from '../../src/util/glob.js';

export const BASE = 'a'.repeat(40);
export const HEAD = 'b'.repeat(40);
const SHA = '0'.repeat(64);

export const FILES: Record<string, string> = {
  'src/routes/export.ts': [
    "import { requireAdmin } from '../auth/require-admin.js';",
    "import { router } from '../http.js';",
    '',
    "router.get('/export', async (req, res) => {",
    '  requireAdmin(req);',
    "  res.send('ok');",
    '});',
    '',
    "router.get('/export.csv', async (req, res) => {",
    "  res.send('csv');",
    '});',
    '',
  ].join('\n'),
  'src/export/query.ts': [
    'export function exportableNotes(all, ws) {',
    '  return all.filter((n) => n.workspaceId === ws && n.deletedAt === null && n.archivedAt === null);',
    '}',
    '',
  ].join('\n'),
  'src/agent/chats.ts': ['export const CHAT_TTL_DAYS = 30;', ''].join('\n'),
  'src/log.ts': ["const SECRET_KEYS = ['password', 'cardNumber'];", 'export function log() {}', ''].join('\n'),
  'docs/privacy.md': '# Privacy\n',
};

export class FakeRepo implements GitRepo {
  readonly root = '/work/acme-notes';
  readonly reads: string[] = [];
  constructor(
    readonly files: Record<string, Record<string, string>> = { [HEAD]: { ...FILES }, [BASE]: { ...FILES } },
    readonly changed: string[] = [],
  ) {}
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
    this.reads.push(`${commit.slice(0, 7)}:${path}`);
    const text = this.files[commit]?.[path];
    if (text === undefined) throw new Error(`no ${path} at ${commit}`);
    return text;
  }
  async changedFiles() {
    return [...this.changed];
  }
}

export class FakeStore implements Store {
  readonly dir = '/work/acme-notes/.jurator';
  readonly repoRoot = '/work/acme-notes';
  runs: CheckRun[] = [];
  constructor(
    public promises: PromiseRecord[],
    public rules: Rule[] = [],
    public config: Config = { ...DEFAULT_CONFIG, codeScope: ['src/**'] },
  ) {}
  async exists() {
    return true;
  }
  async readConfig() {
    return this.config;
  }
  async writeConfig() {}
  async readLock() {
    return [];
  }
  async writeLock() {}
  async saveSourceText() {
    return '';
  }
  async readSourceText() {
    return '';
  }
  async readPromises() {
    return this.promises;
  }
  async writePromises() {}
  async readContradictions() {
    return [];
  }
  async writeContradictions() {}
  async readRules() {
    return this.rules;
  }
  async writeRules() {}
  async writeRun(run: CheckRun) {
    this.runs.push(run);
    return `${this.dir}/local/runs/${run.id}/run.json`;
  }
}

/** Answers by task key; an Error value makes that call fail. */
export class FakeModel implements ModelClient {
  readonly id = 'fake-model';
  readonly mode = 'scripted' as const;
  readonly requests: Array<ModelJsonRequest<unknown>> = [];
  constructor(readonly answers: Record<string, unknown>, readonly usd = 0.01) {}
  async json<T>(request: ModelJsonRequest<T>): Promise<ModelJsonResult<T>> {
    this.requests.push(request as ModelJsonRequest<unknown>);
    const answer = this.answers[request.task];
    if (answer === undefined) throw new Error(`No scripted answer for ${request.task}`);
    if (answer instanceof Error) throw answer;
    return {
      value: request.schema.parse(answer),
      usage: { id: this.id, mode: 'scripted', inputTokens: 100, outputTokens: 20, usd: this.usd },
    };
  }
}

export function promise(id: string, over: Partial<PromiseRecord> = {}): PromiseRecord {
  const alias = id.split('.')[0] as string;
  return {
    id,
    status: 'accepted',
    wording: `Wording of ${id}.`,
    quote: { alias, policySha256: SHA, text: `Policy text of ${id}.`, line: 3 },
    kind: 'must',
    checkable: 'code',
    scope: [],
    foundBy: 'model',
    firstSeen: '2026-11-04T03:00:00.000Z',
    ...over,
  };
}

export function rule(id: string, promiseId: string, globs: string[], over: Partial<Rule> = {}): Rule {
  return {
    id,
    promiseId,
    description: `Rule ${id}`,
    mode: 'each-near',
    pattern: 'requireAdmin\\(',
    anchor: 'router\\.get\\(',
    within: 3,
    globs,
    provenBy: { mutation: 'removed requireAdmin', failedAsExpected: true, at: '2026-11-04T03:00:00.000Z' },
    status: 'accepted',
    author: 'model',
    createdAt: '2026-11-04T03:00:00.000Z',
    ...over,
  };
}

/** A fake runRule: outcome per rule id; hits point at real lines of FILES. */
export function fakeRunRule(outcomes: Record<string, { outcome: RuleRunResult['outcome']; hits?: Array<[string, number]> }>) {
  const calls: Array<{ ruleId: string; files: string[]; commit: string }> = [];
  const fn = (r: Rule, files: readonly SourceFile[], commit: string): RuleRunResult => {
    calls.push({ ruleId: r.id, files: files.map((f) => f.path), commit });
    const o = outcomes[r.id] ?? { outcome: 'pass' };
    const hits: Citation[] = (o.hits ?? []).map(([path, line]) => ({
      path,
      commit,
      startLine: line,
      endLine: line,
      quote: 'whatever the rule engine copied',
    }));
    return { ruleId: r.id, promiseId: r.promiseId, outcome: o.outcome, hits, message: `${r.id}: ${o.outcome}` };
  };
  return { fn, calls };
}

export const fixedNow = () => new Date('2026-11-04T03:30:00.000Z');
