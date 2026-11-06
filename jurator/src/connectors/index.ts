// Owner: WP-W. Read-only connectors (principle 1): code fetches; models only ever see fetched text.
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { extname, isAbsolute, join, relative, resolve } from 'node:path';
import { z } from 'zod';
import {
  promiseDraftSchema,
  type Connector,
  type ConnectorContext,
  type LockEntry,
  type PolicyDocument,
  type PolicySourceConfig,
  type PromiseDraft,
  type Store,
} from '../contracts.js';
import { JuratorError } from '../util/errors.js';
import { sha256 } from '../util/json.js';
import { BRAND } from '../brand.js';

/* ============================== shared helpers ============================== */

/** Reads a repo-relative file; refuses paths that leave the repo. */
async function readRepoFile(ctx: ConnectorContext, locator: string, sourceAlias: string): Promise<string> {
  const root = resolve(ctx.repoRoot);
  const path = resolve(root, locator);
  const rel = relative(root, path);
  if (isAbsolute(locator) || rel.startsWith('..') || isAbsolute(rel)) {
    throw new JuratorError('SOURCE_OUTSIDE_REPO', `Source ${sourceAlias}: ${locator} is outside the repo. Use a path inside it.`);
  }
  try {
    return await readFile(path, 'utf8');
  } catch {
    throw new JuratorError('SOURCE_NOT_FOUND', `Source ${sourceAlias}: could not read ${locator}. Check the path in ${BRAND.folder}/config.json.`);
  }
}

function mediaTypeFor(locator: string): PolicyDocument['mediaType'] {
  const ext = extname(locator).toLowerCase();
  if (ext === '.md' || ext === '.mdx' || ext === '.markdown') return 'text/markdown';
  if (ext === '.json') return 'application/json';
  return 'text/plain';
}

/** 1-based line of the first occurrence of `"key"` in a JSON text, if any. */
function lineOfKey(text: string, key: string): number | undefined {
  const at = text.indexOf(JSON.stringify(key));
  if (at < 0) return undefined;
  return text.slice(0, at).split('\n').length;
}

/* ============================== file ============================== */

export const fileConnector: Connector = {
  id: 'file',
  readOnly: true,
  async fetch(source: PolicySourceConfig, ctx: ConnectorContext): Promise<PolicyDocument> {
    const text = await readRepoFile(ctx, source.locator, source.alias);
    return {
      alias: source.alias,
      connector: 'file',
      locator: source.locator,
      mediaType: mediaTypeFor(source.locator),
      text,
      sha256: sha256(text),
      fetchedAt: ctx.now().toISOString(),
    };
  },
};

/* ============================== praesidia ============================== */

/** The settings we read from a Praesidia agent policy. Unknown keys are kept in the text but ignored here. */
export const praesidiaPolicySchema = z.looseObject({
  name: z.string().optional(),
  version: z.union([z.number(), z.string()]).optional(),
  dataRetentionDays: z.number().int().positive().optional(),
  /** What dataRetentionDays means. Absent: the export does not say, and the program does not guess. */
  dataRetentionMeaning: z.enum(['configured-value', 'declared-maximum']).optional(),
  allowedTools: z.array(z.string().min(1)).optional(),
  requireApproval: z.boolean().optional(),
  blockPii: z.boolean().optional(),
});
export type PraesidiaPolicy = z.infer<typeof praesidiaPolicySchema>;

/** Where a Praesidia policy comes from. MVP: a recorded export in the repo. Live: a read-only API GET (not built). */
interface PraesidiaTransport {
  read(source: PolicySourceConfig, ctx: ConnectorContext): Promise<string>;
}

const recordedExport: PraesidiaTransport = {
  read: (source, ctx) => readRepoFile(ctx, source.locator, source.alias),
};

/**
 * Live read (later): `praesidia:<agent id>` locators, GET-only, key from `credential('PRAESIDIA_API_KEY')` and org from
 * `credential('PRAESIDIA_ORG')`. The key stays in this function; only the fetched JSON text leaves it.
 */
const liveApi: PraesidiaTransport = {
  async read(source, ctx) {
    const hasKey = ctx.credential('PRAESIDIA_API_KEY') !== undefined;
    throw new JuratorError(
      'NOT_IMPLEMENTED',
      `Source ${source.alias}: live Praesidia reads are not built yet${hasKey ? '' : ' (and PRAESIDIA_API_KEY is not set)'}. ` +
        'Point the locator at a recorded export JSON in the repo, e.g. policies/praesidia-support-agent.json.',
    );
  },
};

export function parsePraesidia(text: string, sourceAlias: string): PraesidiaPolicy {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new JuratorError('BAD_SOURCE', `Source ${sourceAlias}: the Praesidia export is not valid JSON.`);
  }
  const parsed = praesidiaPolicySchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new JuratorError('BAD_SOURCE', `Source ${sourceAlias}: unexpected Praesidia export (${issue ? `${issue.path.join('.')}: ${issue.message}` : 'bad shape'}).`);
  }
  return parsed.data;
}

/**
 * What a Praesidia agent keeps: a support agent's data is its support chats; any other agent, customer data. Read from
 * the export's own name (or a `dataKind` / `description` when the export has one), never guessed by a model.
 */
export function retentionSubject(policy: PraesidiaPolicy): string {
  const said = [policy['dataKind'], policy['description'], policy.name]
    .filter((v): v is string => typeof v === 'string')
    .join(' ')
    .toLowerCase();
  return /\b(?:support|chats?|conversations?)\b/u.test(said) ? 'support chats' : 'customer data';
}

export const praesidiaConnector: Connector = {
  id: 'praesidia',
  readOnly: true,
  async fetch(source: PolicySourceConfig, ctx: ConnectorContext): Promise<PolicyDocument> {
    const transport = source.locator.startsWith('praesidia:') ? liveApi : recordedExport;
    const text = await transport.read(source, ctx);
    const policy = parsePraesidia(text, source.alias);
    return {
      alias: source.alias,
      connector: 'praesidia',
      locator: source.locator,
      mediaType: 'application/json',
      text,
      sha256: sha256(text),
      ...(policy.version !== undefined ? { upstreamVersion: String(policy.version) } : {}),
      fetchedAt: ctx.now().toISOString(),
    };
  },
  /** Settings become promises with no AI (foundBy 'structured'), in a fixed order so ids stay stable. */
  toPromises(doc: PolicyDocument): PromiseDraft[] {
    const policy = parsePraesidia(doc.text, doc.alias);
    const drafts: PromiseDraft[] = [];
    const quote = (jsonPointer: string, value: unknown, key: string) => {
      const line = lineOfKey(doc.text, key);
      return {
        alias: doc.alias,
        policySha256: doc.sha256,
        text: JSON.stringify(value),
        jsonPointer,
        ...(line !== undefined ? { line } : {}),
      };
    };
    // Typed facets come from the settings themselves (no AI). A retention number is a configured value, a declared
    // maximum or unresolved, as the export's `dataRetentionMeaning` says; it is never silently made a "<= N" limit.
    if (policy.dataRetentionDays !== undefined) {
      const n = String(policy.dataRetentionDays);
      const meaning = policy.dataRetentionMeaning;
      const wording =
        meaning === 'configured-value'
          ? `Data retention is configured to ${n} days.`
          : meaning === 'declared-maximum'
            ? `Data is kept for at most ${n} days.`
            : `Data retention is set to ${n} days; the export does not say what that means.`;
      drafts.push({
        wording,
        quote: quote('/dataRetentionDays', policy.dataRetentionDays, 'dataRetentionDays'),
        kind: 'must',
        checkable: 'code',
        scope: [],
        params: [{ name: 'dataRetentionDays', value: n, unit: 'days' }],
        foundBy: 'structured',
        facets: {
          subject: retentionSubject(policy),
          action: 'keep',
          constraint: { name: 'retention', op: meaning === 'declared-maximum' ? '<=' : '==', value: n, unit: 'days' },
        },
        obligation: {
          statement: 'configuration',
          interpretation: meaning ?? 'unresolved',
          tenant: null,
          resource: null,
          applicability: 'stated',
          exceptions: [],
        },
      });
    }
    if (policy.requireApproval === true && policy.allowedTools) {
      policy.allowedTools.forEach((tool, i) => {
        drafts.push({
          wording: `${tool} needs approval before it runs.`,
          quote: quote(`/allowedTools/${i}`, tool, 'allowedTools'),
          kind: 'must',
          checkable: 'code',
          scope: [],
          params: [{ name: 'tool', value: tool }],
          foundBy: 'structured',
          facets: { subject: tool.toLowerCase(), action: 'require approval', constraint: { name: 'before it runs', op: 'always', value: null, unit: null } },
        });
      });
    }
    if (policy.blockPii === true) {
      drafts.push({
        wording: 'Personal data is blocked from agent output.',
        quote: quote('/blockPii', true, 'blockPii'),
        kind: 'must',
        checkable: 'runtime',
        scope: [],
        foundBy: 'structured',
        facets: { subject: 'personal data', action: 'show in agent output', constraint: { name: 'allowed', op: 'never', value: null, unit: null } },
      });
    }
    return drafts.map((d) => promiseDraftSchema.parse(d));
  },
};

/* ============================== registry + context ============================== */

const CONNECTORS: Readonly<Record<string, Connector>> = { file: fileConnector, praesidia: praesidiaConnector };

export const CONNECTOR_IDS: readonly string[] = Object.keys(CONNECTORS);

export function getConnector(id: string): Connector {
  const connector = CONNECTORS[id];
  if (!connector) {
    throw new JuratorError('UNKNOWN_CONNECTOR', `No connector "${id}". Known connectors: ${CONNECTOR_IDS.join(', ')}.`);
  }
  return connector;
}

/** `$JURATOR_HOME/credentials.json`, default `~/.jurator/credentials.json`. */
export function credentialsPath(env: NodeJS.ProcessEnv): string {
  const home = env.JURATOR_HOME && env.JURATOR_HOME.length > 0 ? env.JURATOR_HOME : join(env.HOME ?? homedir(), BRAND.folder);
  return join(home, 'credentials.json');
}

export function makeConnectorContext(
  repoRoot: string,
  env: NodeJS.ProcessEnv,
  now: () => Date = () => new Date(),
): ConnectorContext {
  let fileCreds: Record<string, unknown> | null | undefined;
  const loadFileCreds = (): Record<string, unknown> | null => {
    if (fileCreds !== undefined) return fileCreds;
    try {
      const raw: unknown = JSON.parse(readFileSync(credentialsPath(env), 'utf8'));
      fileCreds = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
    } catch {
      fileCreds = null;
    }
    return fileCreds;
  };
  return {
    repoRoot: resolve(repoRoot),
    // Never logged, never returned in any record: only connectors call this.
    credential(name: string): string | undefined {
      const fromEnv = env[name];
      if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv;
      const value = loadFileCreds()?.[name];
      return typeof value === 'string' && value.length > 0 ? value : undefined;
    },
    now,
  };
}

/* ============================== pull ============================== */

export interface PullResult {
  readonly docs: PolicyDocument[];
  /** Aliases whose sha256 differs from the lock (new sources count as changed). */
  readonly changed: string[];
}

/** Fetches every configured source; with write=true saves texts and the lock, else only compares (pull --check). */
export async function pullSources(store: Store, ctx: ConnectorContext, write: boolean): Promise<PullResult> {
  const config = await store.readConfig();
  const lock = await store.readLock();
  const byAlias = new Map(lock.map((e) => [e.alias, e]));
  const docs: PolicyDocument[] = [];
  const changed: string[] = [];
  const nextLock: LockEntry[] = [];
  for (const source of config.sources) {
    const doc = await getConnector(source.connector).fetch(source, ctx);
    docs.push(doc);
    const previous = byAlias.get(source.alias);
    const same =
      previous !== undefined &&
      previous.sha256 === doc.sha256 &&
      previous.connector === doc.connector &&
      previous.locator === doc.locator;
    if (!same) changed.push(source.alias);
    if (write) {
      const textPath = await store.saveSourceText(doc);
      // An unchanged source keeps its lock entry as is, so a no-op pull leaves no diff.
      nextLock.push(
        same && previous.textPath === textPath
          ? previous
          : {
              alias: doc.alias,
              connector: doc.connector,
              locator: doc.locator,
              sha256: doc.sha256,
              ...(doc.upstreamVersion !== undefined ? { upstreamVersion: doc.upstreamVersion } : {}),
              fetchedAt: doc.fetchedAt,
              textPath,
            },
      );
    }
  }
  if (write) await store.writeLock(nextLock);
  return { docs, changed };
}
