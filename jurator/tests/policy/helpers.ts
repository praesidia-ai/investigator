import { readFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type {
  CheckRun,
  Config,
  Connector,
  Contradiction,
  LockEntry,
  ModelClient,
  ModelJsonRequest,
  ModelJsonResult,
  PolicyDocument,
  PromiseDraft,
  PromiseRecord,
  Rule,
  Store,
} from '../../src/contracts.js';
import { DEFAULT_CONFIG } from '../../src/contracts.js';
import { sha256 } from '../../src/util/json.js';

export const ACME_FIXTURES = resolve(import.meta.dirname, '../../fixtures/scripted/acme');
export const NOW = new Date('2026-11-04T05:00:00.000Z');

/** Copies of acme-notes main (docs/privacy.md, docs/security.md, policies/praesidia-support-agent.json). */
export const PRIVACY_MD = `# Acme Notes privacy policy

Last updated: 2 September 2026.

## What we keep

1. Support chats are deleted after 30 days.
2. Exports never include deleted or archived notes.
3. We never sell your notes or share them with advertisers.

## If something goes wrong

4. We tell you within 72 hours of a breach that affects your data.
`;
export const SECURITY_MD = `# Acme Notes security policy

- Only workspace admins can export customer data.
- Passwords are hashed with argon2 and are never stored in plain text.
- We never write card numbers or passwords to logs.
`;
export const PRAESIDIA_JSON = `{
  "name": "Support agent policy",
  "version": 7,
  "enforcementMode": "enforce",
  "dataRetentionDays": 90,
  "allowedTools": ["search_notes", "export_notes"],
  "requireApproval": true,
  "blockPii": true
}
`;
export const ACME_CODE_FILES = [
  'src/agent/chats.ts',
  'src/agent/praesidia.ts',
  'src/agent/tools.ts',
  'src/auth/argon2.ts',
  'src/auth/passwords.ts',
  'src/auth/require-admin.ts',
  'src/export/query.ts',
  'src/http.ts',
  'src/log.ts',
  'src/routes/export.ts',
  'src/routes/notes.ts',
];

export function doc(alias: string, connector: string, locator: string, text: string): PolicyDocument {
  return {
    alias,
    connector,
    locator,
    mediaType: locator.endsWith('.json') ? 'application/json' : 'text/markdown',
    text,
    sha256: sha256(text),
    fetchedAt: NOW.toISOString(),
  };
}

/** Fake Praesidia connector following WP-W's spec order: retention, one per approved tool, blockPii (with facets). */
export const fakePraesidia: Connector = {
  id: 'praesidia',
  readOnly: true,
  async fetch() {
    throw new Error('not used in tests');
  },
  toPromises(d: PolicyDocument): PromiseDraft[] {
    const s = JSON.parse(d.text) as { dataRetentionDays?: number; allowedTools?: string[]; requireApproval?: boolean; blockPii?: boolean };
    // Like WP-W's connector: the quote text is the setting's JSON value.
    const q = (jsonPointer: string, value: unknown) => ({ alias: d.alias, policySha256: d.sha256, text: JSON.stringify(value), jsonPointer });
    const out: PromiseDraft[] = [];
    if (s.dataRetentionDays !== undefined) {
      out.push({
        wording: `Data is kept for at most ${s.dataRetentionDays} days.`,
        quote: q('/dataRetentionDays', s.dataRetentionDays),
        kind: 'must',
        checkable: 'code',
        scope: [],
        params: [{ name: 'dataRetentionDays', value: String(s.dataRetentionDays), unit: 'days' }],
        foundBy: 'structured',
        facets: {
          subject: 'support chats',
          action: 'keep',
          constraint: { name: 'retention', op: '==', value: String(s.dataRetentionDays), unit: 'days' },
        },
        obligation: { statement: 'configuration', interpretation: 'configured-value', tenant: null, resource: null, applicability: 'stated', exceptions: [] },
      });
    }
    if (s.requireApproval) {
      (s.allowedTools ?? []).forEach((tool, i) =>
        out.push({
          wording: `${tool} needs approval before it runs.`,
          quote: q(`/allowedTools/${i}`, tool),
          kind: 'must',
          checkable: 'code',
          scope: [],
          params: [{ name: 'tool', value: tool }],
          foundBy: 'structured',
          facets: { subject: tool, action: 'require approval', constraint: { name: 'before it runs', op: 'always', value: null, unit: null } },
        }),
      );
    }
    if (s.blockPii) {
      out.push({
        wording: 'Personal data is blocked from agent output.',
        quote: q('/blockPii', true),
        kind: 'must',
        checkable: 'runtime',
        scope: [],
        foundBy: 'structured',
        facets: { subject: 'personal data', action: 'show in agent output', constraint: { name: 'allowed', op: 'never', value: null, unit: null } },
      });
    }
    return out;
  },
};

/** Scripted model over a directory of answers, or an in-memory map of task -> value. */
export function scriptedModel(source: string | Record<string, unknown>): ModelClient & { calls: string[] } {
  const calls: string[] = [];
  return {
    id: 'scripted-test',
    mode: 'scripted',
    calls,
    async json<T>(req: ModelJsonRequest<T>): Promise<ModelJsonResult<T>> {
      calls.push(req.task);
      const raw =
        typeof source === 'string'
          ? JSON.parse(readFileSync(join(source, `${req.task.replace(/:/gu, '__')}.json`), 'utf8'))
          : source[req.task];
      if (raw === undefined) throw new Error(`no scripted answer for ${req.task}`);
      return { value: req.schema.parse(raw), usage: { id: 'scripted-test', mode: 'scripted', inputTokens: 0, outputTokens: 0, usd: 0 } };
    },
  };
}

export class MemoryStore implements Store {
  readonly dir: string;
  readonly repoRoot: string;
  config: Config = { ...DEFAULT_CONFIG, sources: [] };
  promises = new Map<string, PromiseRecord[]>();
  contradictions: Contradiction[] = [];
  writes: string[] = [];
  constructor(repoRoot = mkdtempSync(join(tmpdir(), 'kw-policy-'))) {
    this.repoRoot = repoRoot;
    this.dir = join(repoRoot, '.jurator');
  }
  async exists() {
    return true;
  }
  async readConfig() {
    return this.config;
  }
  async writeConfig(config: Config) {
    this.config = config;
  }
  async readLock(): Promise<LockEntry[]> {
    return [];
  }
  async writeLock() {}
  async saveSourceText(d: PolicyDocument) {
    return `sources/${d.alias}`;
  }
  async readSourceText() {
    return '';
  }
  async readPromises() {
    return [...this.promises.values()].flat().map((p) => structuredClone(p));
  }
  async writePromises(alias: string, items: PromiseRecord[]) {
    this.writes.push(alias);
    this.promises.set(alias, structuredClone(items));
  }
  async readContradictions() {
    return structuredClone(this.contradictions);
  }
  async writeContradictions(items: Contradiction[]) {
    this.contradictions = structuredClone(items);
  }
  async readRules(): Promise<Rule[]> {
    return [];
  }
  async writeRules() {}
  async writeRun(_run: CheckRun) {
    return '';
  }
}
