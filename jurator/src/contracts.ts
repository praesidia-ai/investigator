/**
 * Jurator contracts: the ONLY shared types between packages.
 *
 * Owned by WP-0. Append-only during the MVP sprint: add optional fields or new types, never rename or remove.
 * Every file under .jurator/ is `{ schemaVersion: 1, items: [...] }` (sorted by id) unless stated otherwise.
 *
 * Product principles :
 *  1. Connectors are read-only code. The model never sees credentials; it only sees fetched text.
 *  2. Rules run on every check (no AI, same answer every time). The model *maintains* rules; it does not judge at
 *     runtime when a rule exists. An AI read is a labelled fallback for promises without a rule.
 *  3. The model proposes, the program decides: every quote is re-checked by the program, and the level decides the
 *     words ("looks kept" from an AI read, "holds" only from a rule).
 */
import { z } from 'zod';

/* ============================== primitives ============================== */

export const isoTime = z.string().min(10);
export const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/u);
export const commitSha = z.string().regex(/^[0-9a-f]{7,40}$/u);
/** Promise ids look like `privacy.02`: `<source alias>.<two or more digits>`. Never reused. */
export const promiseId = z.string().regex(/^[a-z][a-z0-9-]*\.[0-9]{2,}$/u);
export const alias = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/u);

/* ============================== policies ============================== */

/** One entry in .jurator/config.json `sources`: where a policy lives. */
export const policySourceConfigSchema = z.object({
  alias,
  /** Connector id: 'file' (path relative to repo root) or 'praesidia' (recorded export JSON for the MVP). */
  connector: z.string().min(1),
  /** Connector-specific locator, e.g. 'docs/privacy.md' or 'fixtures/praesidia/support-agent.v7.json'. */
  locator: z.string().min(1),
});
export type PolicySourceConfig = z.infer<typeof policySourceConfigSchema>;

/** A fetched policy document. `sha256` is computed by the program over `text` (UTF-8). */
export const policyDocumentSchema = z.object({
  alias,
  connector: z.string(),
  locator: z.string(),
  mediaType: z.enum(['text/markdown', 'text/plain', 'application/json']),
  text: z.string(),
  sha256: sha256Hex,
  upstreamVersion: z.string().optional(),
  fetchedAt: isoTime,
});
export type PolicyDocument = z.infer<typeof policyDocumentSchema>;

/** .jurator/sources.lock.json items: the last fetched version of each source. */
export const lockEntrySchema = z.object({
  alias,
  connector: z.string(),
  locator: z.string(),
  sha256: sha256Hex,
  upstreamVersion: z.string().optional(),
  fetchedAt: isoTime,
  /** Copied text lives at .jurator/sources/<alias>.<ext>; this is that path relative to .jurator/. */
  textPath: z.string(),
});
export type LockEntry = z.infer<typeof lockEntrySchema>;

/* ============================== promises ============================== */

/**
 * The exact policy text a promise comes from. For text sources: `text` must occur in the document (whitespace runs
 * collapsed on both sides) and `start`/`end` are UTF-16 offsets into the raw text (end exclusive), filled by the program.
 * For JSON sources: `jsonPointer` names the setting and `text` is its JSON value.
 */
export const policyQuoteSchema = z.object({
  alias,
  policySha256: sha256Hex,
  text: z.string().min(1),
  start: z.number().int().nonnegative().optional(),
  end: z.number().int().nonnegative().optional(),
  line: z.number().int().positive().optional(),
  jsonPointer: z.string().optional(),
});
export type PolicyQuote = z.infer<typeof policyQuoteSchema>;

export const promiseKindSchema = z.enum(['must', 'must-not', 'may']);
/** code: checkable in code · process: goes to the PR checklist · runtime: enforced while running (e.g. Praesidia). */
export const checkableSchema = z.enum(['code', 'process', 'runtime']);

/** Typed facets of a promise. Values are strings so dates, numbers and enums share one shape; units are explicit. */
export const promiseFacetsSchema = z.object({
  /** Normalised noun phrase, e.g. 'support chats', 'customer data', 'card numbers'. */
  subject: z.string().min(1),
  /** Normalised verb, e.g. 'delete', 'keep', 'export', 'log', 'require approval'. */
  action: z.string().min(1),
  constraint: z
    .object({
      name: z.string().min(1),
      op: z.enum(['<=', '>=', '==', 'never', 'always']),
      value: z.string().nullable(),
      unit: z.string().nullable(),
    })
    .nullable(),
});
export type PromiseFacets = z.infer<typeof promiseFacetsSchema>;

/**
 * What a promise's facets state and how far it applies. Absent on older records: read as a requirement whose
 * applicability was never reviewed. Exact quotation does not establish any of these meanings.
 *  - requirement: a limit that must hold · configuration: a value a system is set to · observation: a value seen running.
 *  - interpretation (configuration only): a source field either records the set value or declares a maximum; 'unresolved'
 *    when the source does not say, and the program must not pick one.
 *  - tenant/resource: scoped identity; null = not stated. Same-named data in different tenants is not the same entity.
 *  - applicability: 'ambiguous' keeps a comparison unresolved until a person reviews it.
 */
export const obligationSchema = z.object({
  statement: z.enum(['requirement', 'configuration', 'observation']),
  interpretation: z.enum(['configured-value', 'declared-maximum', 'unresolved']).optional(),
  tenant: z.string().min(1).nullable(),
  resource: z.string().min(1).nullable(),
  applicability: z.enum(['stated', 'reviewed', 'ambiguous']),
  exceptions: z.array(z.string().min(1)),
});
export type Obligation = z.infer<typeof obligationSchema>;

export const promiseSchema = z.object({
  id: promiseId,
  status: z.enum(['draft', 'accepted', 'retired']),
  /** One short checkable sentence in plain words. */
  wording: z.string().min(3).max(400),
  quote: policyQuoteSchema,
  kind: promiseKindSchema,
  checkable: checkableSchema,
  /** Code globs this promise is about (repo-relative), e.g. ['src/routes/**']. Empty = whole code scope. */
  scope: z.array(z.string()),
  params: z.array(z.object({ name: z.string(), value: z.string(), unit: z.string().optional() })).optional(),
  foundBy: z.enum(['model', 'structured', 'human']),
  firstSeen: isoTime,
  rewordedFrom: z.array(z.string()).optional(),
  /**
   * Typed fields beside the exact sentence ("a structured container of unstructured sentences"). A program can
   * compare them: two promises about the same subject with incompatible constraints are a contradiction with no AI.
   */
  facets: promiseFacetsSchema.optional(),
  obligation: obligationSchema.optional(),
});
export type PromiseRecord = z.infer<typeof promiseSchema>;

/** What a compiler produces before the program assigns ids and status. */
export const promiseDraftSchema = promiseSchema.omit({ id: true, status: true, firstSeen: true, rewordedFrom: true });
export type PromiseDraft = z.infer<typeof promiseDraftSchema>;

export const contradictionSchema = z.object({
  id: z.string().regex(/^C-[0-9]+$/u),
  promiseIds: z.array(promiseId).min(2),
  /** A concrete example that shows the conflict, e.g. "a chat from 1 Mar must be gone by 31 Mar but may stay until 30 May". */
  example: z.string().min(3),
  status: z.enum(['open', 'real', 'not-a-conflict']),
  foundBy: z.enum(['model', 'structured']),
  ruling: z.object({ by: z.string(), why: z.string(), at: isoTime }).optional(),
  /** Absent on older records. Two requirements that cannot both hold differ from a configured value breaking a requirement. */
  kind: z.enum(['incompatible-requirements', 'configuration-violation']).optional(),
});
export type Contradiction = z.infer<typeof contradictionSchema>;

/* ============================== code ============================== */

export const codeSnapshotSchema = z.object({
  repo: z.string(),
  branch: z.string().nullable(),
  commit: commitSha,
  /** True when the working tree differs from the commit; such runs are labelled "not reproducible". */
  dirty: z.boolean(),
  /**
   * Multi-repo workspace (R4-WS): each code repo's own state. `commit` above is then the composite commit: the first
   * 40 hex of sha256 over the sorted `name:commit` lines, and paths everywhere are prefixed `name/...`.
   */
  repos: z
    .array(z.object({ name: z.string().min(1), branch: z.string().nullable(), commit: commitSha, dirty: z.boolean() }))
    .optional(),
});
export type CodeSnapshot = z.infer<typeof codeSnapshotSchema>;

/** Code evidence. `quote` is ALWAYS copied by the program from the file at `commit`, never written by a model. */
export const citationSchema = z.object({
  path: z.string(),
  commit: commitSha,
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  quote: z.string(),
});
export type Citation = z.infer<typeof citationSchema>;

export interface SourceFile {
  readonly path: string;
  readonly text: string;
}

/* ============================== rules ============================== */

/**
 * A deterministic check (no AI). Patterns are JavaScript regular expressions (source + flags), run per line unless
 * the 's' or 'm' flag is present, in which case they run over the whole file.
 *  - must-match:      at least one file in `globs` matches `pattern`.
 *  - must-not-match:  no file in `globs` matches `pattern`.
 *  - each-near:       every line matching `anchor` has a line matching `pattern` within `within` lines after it
 *                     (e.g. every route definition calls requireAdmin within 5 lines).
 */
export const ruleSchema = z.object({
  id: z.string().regex(/^R-[a-z0-9.-]+$/u),
  promiseId,
  description: z.string().min(3),
  mode: z.enum(['must-match', 'must-not-match', 'each-near', 'semantic']),
  pattern: z.string().min(1),
  flags: z.string().regex(/^[imsu]*$/u).optional(),
  anchor: z.string().optional(),
  within: z.number().int().min(0).max(50).optional(),
  globs: z.array(z.string()).min(1),
  /** Proof that the rule can fail: the program removed the guarding lines in memory and the rule failed. */
  provenBy: z
    .object({ mutation: z.string(), failedAsExpected: z.boolean(), at: isoTime })
    .nullable(),
  status: z.enum(['proposed', 'accepted']),
  author: z.enum(['model', 'human']),
  createdAt: isoTime,
  /** Mode 'semantic' only: an optional versioned analyzer decides, not a pattern. `pattern` then just describes the control. */
  semantic: z
    .object({
      adapter: z.string().min(1),
      adapterVersion: z.string().min(1),
      control: z.string().min(1),
      config: z.record(z.string(), z.unknown()),
    })
    .optional(),
});
export type Rule = z.infer<typeof ruleSchema>;

export const ruleRunResultSchema = z.object({
  ruleId: z.string(),
  promiseId,
  outcome: z.enum(['pass', 'fail', 'error']),
  /** For a fail: the offending lines; for a pass: the lines that satisfied the rule (may be empty for must-not-match). */
  hits: z.array(citationSchema),
  message: z.string(),
  /** What a semantic analyzer could not assess (dynamic registration, unresolved call, unmodeled path). */
  coverageGaps: z
    .array(z.object({ kind: z.string().min(1), detail: z.string().min(1), path: z.string().optional(), line: z.number().int().positive().optional() }))
    .optional(),
});
export type RuleRunResult = z.infer<typeof ruleRunResultSchema>;

/* ============================== bindings ============================== */

/**
 * Where in the code a promise lives : the constants, config keys, guard calls and allowlists whose
 * value or presence makes the promise true. Committed in .jurator/bindings.json. A change that touches a bound line
 * triggers a check of that promise ("touched CHAT_TTL_DAYS, bound to privacy.01"). `quote` is copied by the program.
 */
export const bindingSchema = z.object({
  id: z.string().regex(/^B-[a-z0-9.-]+$/u),
  promiseId,
  path: z.string(),
  /** Identifier at the location when there is one, e.g. 'CHAT_TTL_DAYS', 'requireAdmin', 'allowedTools'. */
  symbol: z.string().nullable(),
  kind: z.enum(['constant', 'config', 'guard', 'allowlist', 'call', 'other']),
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  quote: z.string(),
  quoteSha256: sha256Hex,
  anchoredAt: commitSha,
  /** For value bindings: what the policy expects, from the promise's typed facets (e.g. <= 30 days). */
  expected: z
    .object({ op: z.enum(['<=', '>=', '==', 'never', 'always']), value: z.string().nullable(), unit: z.string().nullable() })
    .nullable(),
  foundBy: z.enum(['rule', 'model', 'human']),
});
export type Binding = z.infer<typeof bindingSchema>;

/* ============================== checks ============================== */

/**
 * The level decides the words:
 *  - quick:   the change touches the promise's scope; nothing judged -> 'not-checked' ("touched, not checked")
 *  - ai-read: a model read the code -> only 'looks-kept' | 'looks-broken' | 'cant-tell'
 *  - rule:    an accepted rule ran -> only 'holds' | 'broken'
 */
export const levelSchema = z.enum(['quick', 'ai-read', 'rule']);
export type Level = z.infer<typeof levelSchema>;
export const verdictSchema = z.enum(['holds', 'broken', 'looks-kept', 'looks-broken', 'cant-tell', 'not-checked']);
export type Verdict = z.infer<typeof verdictSchema>;

export const modelUsageSchema = z.object({
  id: z.string(),
  mode: z.enum(['live', 'scripted']),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  usd: z.number().nonnegative(),
});
export type ModelUsage = z.infer<typeof modelUsageSchema>;

export const checkResultSchema = z.object({
  promiseId,
  wording: z.string(),
  verdict: verdictSchema,
  level: levelSchema,
  reason: z.string().optional(),
  citations: z.array(citationSchema),
  policyQuote: policyQuoteSchema,
  ruleResults: z.array(ruleRunResultSchema).optional(),
  /** One or two plain sentences; from the model for ai-read, from the rule message for rule. */
  explanation: z.string().optional(),
  model: modelUsageSchema.optional(),
  /** Why this promise was checked in a diff, e.g. "touched CHAT_TTL_DAYS (bound to privacy.01)". */
  trigger: z.string().optional(),
  /**
   * Content-addressed reuse: sha256 over the promise digest, its rule digests and its bound code (or scope file blobs).
   * When the key equals a cached result's key, the verdict is reused instead of rechecked.
   */
  cacheKey: sha256Hex.optional(),
  reused: z.object({ fromRun: z.string(), fromCommit: commitSha }).optional(),
  /** How strong the rule evidence is. Known-open counterexamples prevent an unqualified green result. */
  assurance: z
    .object({
      coverage: z.enum(['strong-control', 'limited-detector', 'unassessed']),
      openCounterexamples: z.number().int().nonnegative(),
      warning: z.string().optional(),
    })
    .optional(),
});
export type CheckResult = z.infer<typeof checkResultSchema>;

export const checkRunSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string(),
  toolVersion: z.string(),
  createdAt: isoTime,
  snapshot: codeSnapshotSchema,
  target: z.object({
    kind: z.enum(['repo', 'diff']),
    base: z.string().optional(),
    head: z.string(),
    changedFiles: z.array(z.string()).optional(),
  }),
  failMode: z.enum(['monitor', 'comment', 'block']),
  status: z.enum(['completed', 'incomplete', 'failed']),
  results: z.array(checkResultSchema),
  /** PR checklist items for touched 'process' promises (no AI). */
  checklist: z.array(z.object({ promiseId, text: z.string() })),
  summary: z.object({
    promises: z.number().int(),
    checked: z.number().int(),
    holds: z.number().int(),
    broken: z.number().int(),
    looksKept: z.number().int(),
    looksBroken: z.number().int(),
    cantTell: z.number().int(),
    notChecked: z.number().int(),
    /** How many accepted code promises have at least one accepted rule: the headline coverage number. */
    coveredByRules: z.number().int(),
    codePromises: z.number().int(),
  }),
  costUsd: z.number().nonnegative(),
  /**
   * The verified state pair : code commit + policy state. policyState = sha256 over the accepted promises'
   * digests and the accepted rules' digests. Same pair as a previous run -> nothing needs rechecking.
   */
  policyState: sha256Hex.optional(),
  incremental: z
    .object({ rechecked: z.number().int(), reused: z.number().int(), skippedUnchanged: z.boolean() })
    .optional(),
  /** sha256(stableJson(run without digest)); `jurator verify` recomputes it. */
  digest: sha256Hex,
  /**
   * Multi-repo workspace (R4-WS): every composite commit the run cites (head, and the diff base) -> each repo's commit,
   * so `verify` can re-read any citation later, on any machine.
   */
  repoCommits: z.record(z.string(), z.array(z.object({ name: z.string().min(1), commit: commitSha }))).optional(),
});
export type CheckRun = z.infer<typeof checkRunSchema>;

/* ============================== rule assessments ============================== */

export const storedEvasionSchema = z.object({
  path: z.string(),
  find: z.string(),
  replace: z.string(),
  why: z.string(),
  judgeNote: z.string(),
  round: z.number().int().min(0),
  closed: z.boolean(),
});

/**
 * Portable record of what is known about a rule. Committed at .jurator/assessments/<ruleId>.json so its limits travel
 * with it. Open counterexamples prevent a 'strong-control' label; a limited detector is kept, with the shapes it misses.
 */
export const assessmentBundleSchema = z.object({
  schemaVersion: z.literal(1),
  ruleId: z.string(),
  promiseId,
  ruleDigest: sha256Hex,
  promiseDigest: sha256Hex,
  analyzer: z.object({ id: z.string().min(1), version: z.string().min(1) }),
  sourceRevision: commitSha,
  readSet: z.array(z.object({ path: z.string(), blob: z.string() })),
  mutants: z.array(storedEvasionSchema),
  harmlessControls: z.array(z.object({ path: z.string(), find: z.string(), replace: z.string(), why: z.string(), passed: z.boolean() })),
  adjudication: z.object({ by: z.enum(['model', 'human', 'none']), model: z.string().optional(), at: isoTime.optional(), independent: z.boolean() }),
  coverage: z.enum(['strong-control', 'limited-detector', 'unassessed']),
  createdAt: isoTime,
  /** sha256(stableJson(bundle without digest)). */
  digest: sha256Hex,
});
export type AssessmentBundle = z.infer<typeof assessmentBundleSchema>;

/* ============================== config ============================== */

export const configSchema = z.object({
  schemaVersion: z.literal(1),
  sources: z.array(policySourceConfigSchema),
  failMode: z.enum(['monitor', 'comment', 'block']),
  /** Default code scope (globs) for promises with an empty scope. */
  codeScope: z.array(z.string()),
  model: z.object({
    id: z.string(),
    reasoningEffort: z.enum(['minimal', 'low', 'medium', 'high']).optional(),
  }),
  budgetUsdPerRun: z.number().positive(),
  /**
   * Multi-repo workspace (R4-WS): the code repos under this folder. `path` is relative to the workspace root (or
   * absolute); `name` is the prefix of every code path (`chrome-extension/src/...`). Absent = a single repo.
   */
  repos: z
    .array(z.object({ name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u), path: z.string().min(1) }))
    .optional(),
});
export type Config = z.infer<typeof configSchema>;

export const DEFAULT_CONFIG: Config = {
  schemaVersion: 1,
  sources: [],
  failMode: 'block',
  codeScope: ['src/**', 'app/**', 'lib/**'],
  model: { id: 'muse-wonder-1.0', reasoningEffort: 'medium' },
  budgetUsdPerRun: 10,
};

/** Generic wrapper for every .jurator/*.json list file. */
export const itemsFile = <T extends z.ZodTypeAny>(item: T) =>
  z.object({ schemaVersion: z.literal(1), items: z.array(item) });

/* ============================== package interfaces ============================== */

/** Read-only connector (principle 1). Credentials come from ConnectorContext and never reach a model. */
export interface ConnectorContext {
  readonly repoRoot: string;
  /** Reads a credential from the environment or ~/.jurator/credentials.json; undefined when absent. */
  credential(name: string): string | undefined;
  now(): Date;
}
export interface Connector {
  readonly id: string;
  readonly readOnly: true;
  fetch(source: PolicySourceConfig, ctx: ConnectorContext): Promise<PolicyDocument>;
  /** Structured sources (e.g. Praesidia settings) become promises with no AI. */
  toPromises?(doc: PolicyDocument): PromiseDraft[];
}

/** Model access (src/model). Tests and offline demos use the scripted client; nothing falls back silently. */
export interface ModelJsonRequest<T> {
  /** Stable task key, used by the scripted client to find its answer, e.g. 'compile:privacy', 'ai-read:security.01'. */
  readonly task: string;
  readonly instructions: string;
  readonly input: string;
  readonly schemaName: string;
  readonly schema: z.ZodType<T>;
  readonly maxOutputTokens?: number;
}
export interface ModelJsonResult<T> {
  readonly value: T;
  readonly usage: ModelUsage;
}
export interface ModelClient {
  readonly id: string;
  readonly mode: 'live' | 'scripted';
  json<T>(request: ModelJsonRequest<T>): Promise<ModelJsonResult<T>>;
}

/** Git access (src/git). Reads come from git objects at a commit, so untracked files such as .env are never seen. */
export interface GitRepo {
  readonly root: string;
  snapshot(): Promise<CodeSnapshot>;
  /** Resolve a ref ('HEAD', 'main', a sha) to a full commit sha. */
  resolve(ref: string): Promise<string>;
  /** Tracked files at `commit` matching any glob (repo-relative, '/' separators). */
  listFiles(commit: string, globs: readonly string[]): Promise<string[]>;
  readFile(commit: string, path: string): Promise<string>;
  changedFiles(base: string, head: string): Promise<string[]>;
}

/** The .jurator/ folder (src/workspace). Writes are sorted by id and pretty-printed for reviewable diffs. */
export interface Store {
  /** Absolute path of the .jurator directory. */
  readonly dir: string;
  readonly repoRoot: string;
  exists(): Promise<boolean>;
  readConfig(): Promise<Config>;
  writeConfig(config: Config): Promise<void>;
  readLock(): Promise<LockEntry[]>;
  writeLock(items: LockEntry[]): Promise<void>;
  /** Saves the fetched text under sources/ and returns its path relative to .jurator/. */
  saveSourceText(doc: PolicyDocument): Promise<string>;
  readSourceText(entry: LockEntry): Promise<string>;
  readPromises(): Promise<PromiseRecord[]>;
  /** Replaces every promise of one source alias (promises/<alias>.json). */
  writePromises(sourceAlias: string, items: PromiseRecord[]): Promise<void>;
  readContradictions(): Promise<Contradiction[]>;
  writeContradictions(items: Contradiction[]): Promise<void>;
  readRules(): Promise<Rule[]>;
  writeRules(items: Rule[]): Promise<void>;
  /** Writes local/runs/<id>/run.json (gitignored) and returns its absolute path. */
  writeRun(run: CheckRun): Promise<string>;
}

/** What `jurator compile` gets back from src/policy for one document. */
export interface CompileResult {
  readonly promises: PromiseRecord[];
  /** Model drafts the program threw out, e.g. because their quote is not in the policy text. */
  readonly dropped: ReadonlyArray<{ wording: string; reason: string }>;
  readonly usage: ModelUsage[];
}

/** What src/rules returns when asked to write a rule for a promise (principle 2: the model maintains rules). */
export type ProposeRuleResult =
  | { readonly ok: true; readonly rule: Rule; readonly usage: ModelUsage }
  | { readonly ok: false; readonly reason: string; readonly usage?: ModelUsage };

export interface CheckOptions {
  readonly repo: GitRepo;
  readonly store: Store;
  readonly model: ModelClient | null;
  /** 'repo' checks every accepted promise; 'diff' only those whose scope matches a changed file. */
  readonly target: { kind: 'repo'; head: string } | { kind: 'diff'; base: string; head: string };
  /** When false, promises without a rule are 'not-checked' (quick) instead of read by AI. */
  readonly aiRead: boolean;
  readonly now: () => Date;
}
