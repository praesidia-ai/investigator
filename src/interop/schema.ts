// Versioned Jurator -> Investigator request/result pair (v1). Same-logic copy (formatting may differ) lives in the Investigator package
// at src/interop/schema.ts: neither package imports the other, and both test the same fixtures in schemas/interop/v1.
// Self-contained on purpose (zod + node:crypto only). A request is DATA, never permission to execute anything.
import { createHash } from 'node:crypto';
import { z } from 'zod';

export const REQUEST_SCHEMA = 'praesidia.investigation-request/v1' as const;
export const RESULT_SCHEMA = 'praesidia.investigation-result/v1' as const;

export class InteropError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'InteropError';
    this.code = code;
  }
}

/* ------------------------------ digests ------------------------------ */

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = Object.create(null);
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined)
        Object.defineProperty(out, key, {
          value: sortKeys(v),
          enumerable: true,
          writable: true,
          configurable: true,
        });
    }
    return out;
  }
  return value;
}
export const canonicalJson = (value: unknown): string => JSON.stringify(sortKeys(value));
export const sha256Text = (text: string): string =>
  createHash('sha256').update(text, 'utf8').digest('hex');
/** Digest of a record without its own `digest` field. */
export function digestOf(record: object): string {
  const { digest: _digest, ...rest } = record as Record<string, unknown>;
  void _digest;
  return sha256Text(canonicalJson(rest));
}

/* ------------------------------ primitives ------------------------------ */

const sha = z.string().regex(/^[0-9a-f]{64}$/u);
const time = z.iso.datetime({ offset: true });
const ident = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u);
const line = z.number().int().positive();
const text = (max: number) => z.string().min(1).max(max);

const LEVELS = ['quick', 'ai-read', 'rule', 'none'] as const;
const VERDICTS = [
  'holds',
  'broken',
  'looks-kept',
  'looks-broken',
  'cant-tell',
  'not-checked',
] as const;
export type StaticLevel = (typeof LEVELS)[number];
export type StaticVerdict = (typeof VERDICTS)[number];

export const citationSchema = z
  .object({
    path: text(1024),
    commit: z.string().regex(/^[0-9a-f]{7,40}$/u),
    startLine: line,
    endLine: line,
    quote: z.string().max(16_384),
  })
  .strict();

const staticSchema = z.object({ level: z.enum(LEVELS), verdict: z.enum(VERDICTS) }).strict();

/* ------------------------------ request ------------------------------ */

export const mappingSchema = z
  .object({
    profileId: ident,
    profileVersion: z.number().int().positive(),
    requirementsDigest: sha,
    reviewedBy: text(256),
    reviewedAt: time,
  })
  .strict();

const locatorSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('span'),
      start: z.number().int().nonnegative(),
      end: z.number().int().positive(),
    })
    .strict(),
  z.object({ kind: z.literal('json-pointer'), pointer: z.string().max(1024) }).strict(),
]);

export const requestSchema = z
  .object({
    schema: z.literal(REQUEST_SCHEMA),
    createdAt: time,
    promise: z
      .object({
        id: z.string().regex(/^[a-z][a-z0-9-]*\.[0-9]{2,}$/u),
        digest: sha,
        status: z.literal('accepted'),
        wording: text(400),
        kind: z.enum(['must', 'must-not', 'may']),
        checkable: z.enum(['code', 'process', 'runtime']),
      })
      .strict(),
    /** The original policy source as data; sha256 is over its UTF-8 text. */
    policy: z
      .object({
        alias: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/u),
        sha256: sha,
        mediaType: z.enum(['text/markdown', 'text/plain', 'application/json']),
        text: z.string().max(4_194_304),
      })
      .strict(),
    /** Exact raw quote (never whitespace-collapsed) and where it sits in `policy.text`. */
    quote: z.object({ text: text(16_384), locator: locatorSchema }).strict(),
    trigger: z
      .object({
        runId: text(160),
        codeCheck: staticSchema,
        repo: z.object({ name: ident, commit: z.string().regex(/^[0-9a-f]{7,40}$/u) }).strict(),
        citations: z.array(citationSchema).max(64),
      })
      .strict(),
    tenant: ident,
    workflow: ident,
    environment: ident,
    window: z.object({ start: time, end: time }).strict(),
    mapping: mappingSchema,
    commitments: z.object({ context: sha, evidence: sha }).strict(),
    /** Operator-selected adapter identity; the configuration itself stays with the operator. */
    adapter: z.object({ id: ident, configurationDigest: sha }).strict(),
    scope: text(1024),
    budget: z
      .object({
        maxModelTurns: z.number().int().min(0).max(64),
        maxToolCalls: z.number().int().min(0).max(256),
        maxRuntimeSeconds: z.number().int().min(1).max(3600),
      })
      .strict(),
    digest: sha,
  })
  .strict()
  .superRefine((r, ctx) => {
    const bad = (path: (string | number)[], message: string) =>
      ctx.addIssue({ code: 'custom', path, message });
    if (Date.parse(r.window.start) >= Date.parse(r.window.end))
      bad(['window'], 'window.start must be before window.end');
    if (r.digest !== digestOf(r)) bad(['digest'], 'digest does not match the request content');
    if (sha256Text(r.policy.text) !== r.policy.sha256)
      bad(['policy', 'sha256'], 'policy.sha256 is not the hash of policy.text');
    const found = quoteProblem(r.policy.text, r.policy.mediaType, r.quote);
    if (found) bad(['quote'], found);
  });
export type InvestigationRequest = z.infer<typeof requestSchema>;
export type RequestBody = Omit<InvestigationRequest, 'digest'>;

/** null when the exact quote is at its locator in the source; else the reason. */
export function quoteProblem(
  source: string,
  mediaType: string,
  quote: InvestigationRequest['quote'],
): string | null {
  const loc = quote.locator;
  if (loc.kind === 'span') {
    if (loc.end > source.length || loc.start >= loc.end)
      return 'quote span is outside the policy text';
    return source.slice(loc.start, loc.end) === quote.text
      ? null
      : 'quote does not equal the policy text at its span';
  }
  if (mediaType !== 'application/json')
    return 'json-pointer quotes need an application/json policy';
  const at = jsonValueAt(source, loc.pointer);
  if (typeof at === 'string') return at;
  const v = at.value;
  return quote.text === JSON.stringify(v) || v === quote.text
    ? null
    : 'quote does not equal the value at the JSON pointer';
}

/** The value at an RFC 6901 pointer, or the reason it cannot be read. Array `length` and prototype keys never resolve. */
export function jsonValueAt(source: string, pointer: string): { value: unknown } | string {
  try {
    let value: unknown = JSON.parse(source);
    if (pointer !== '') {
      if (!pointer.startsWith('/')) return 'invalid JSON pointer';
      for (const token of pointer.slice(1).split('/')) {
        const key = token.replace(/~1/gu, '/').replace(/~0/gu, '~');
        if (
          value === null ||
          typeof value !== 'object' ||
          !Object.hasOwn(value, key) ||
          (Array.isArray(value) && !/^(0|[1-9][0-9]*)$/u.test(key))
        )
          return 'JSON pointer does not resolve in the policy';
        value = (value as Record<string, unknown>)[key];
      }
    }
    return { value };
  } catch {
    return 'policy is not valid JSON';
  }
}

/* ------------------------------ result ------------------------------ */

const BEHAVIOR = ['supported', 'contradicted', 'insufficient_evidence'] as const;
export type BehavioralVerdict = (typeof BEHAVIOR)[number];
const MISMATCH_KINDS = [
  'static-pass-runtime-contradicted',
  'static-fail-runtime-supported',
] as const;

/** Static pass + runtime contradiction (or the reverse) is kept as an explicit field, never merged into one verdict. */
export function deriveMismatch(codeCheck: { verdict: string }, behavior: BehavioralVerdict | null) {
  const pass = codeCheck.verdict === 'holds' || codeCheck.verdict === 'looks-kept';
  const fail = codeCheck.verdict === 'broken' || codeCheck.verdict === 'looks-broken';
  if (pass && behavior === 'contradicted')
    return {
      kind: MISMATCH_KINDS[0],
      explanation: 'The code check passed but observed runtime behavior contradicts the promise.',
    };
  if (fail && behavior === 'supported')
    return {
      kind: MISMATCH_KINDS[1],
      explanation: 'The code check failed but observed runtime behavior supports the promise.',
    };
  return null;
}

export const resultSchema = z
  .object({
    schema: z.literal(RESULT_SCHEMA),
    createdAt: time,
    requestDigest: sha,
    profile: z
      .object({ id: ident, version: z.number().int().positive(), requirementsDigest: sha })
      .strict()
      .nullable(),
    adapter: z.object({ id: ident, configurationDigest: sha }).strict(),
    execution: z
      .object({
        status: z.enum(['completed', 'incomplete', 'failed', 'unsupported']),
        reason: z.string().max(2048).nullable(),
      })
      .strict(),
    behavioral: z
      .object({ verdict: z.enum(BEHAVIOR).nullable(), statement: z.string().max(4096).nullable() })
      .strict(),
    /** Echo of the Jurator code check from the request, kept beside (never merged with) the behavioral verdict. */
    static: staticSchema,
    mismatch: z
      .object({ kind: z.enum(MISMATCH_KINDS), explanation: text(1024) })
      .strict()
      .nullable(),
    scope: z.array(text(2048)).max(32),
    captures: z
      .array(
        z
          .object({
            id: ident,
            kind: ident,
            status: z.enum(['PASS', 'FAIL', 'INCOMPLETE', 'ERROR']),
            summary: text(2048),
            digest: sha,
          })
          .strict(),
      )
      .max(64),
    missingEvidence: z.array(text(1024)).max(32),
    proposedAction: z
      .object({
        kind: z.enum(['none', 'repair', 'collect-evidence', 'review']),
        description: text(2048),
      })
      .strict()
      .nullable(),
    digest: sha,
  })
  .strict()
  .superRefine((r, ctx) => {
    const bad = (path: (string | number)[], message: string) =>
      ctx.addIssue({ code: 'custom', path, message });
    if (r.digest !== digestOf(r)) bad(['digest'], 'digest does not match the result content');
    const ran = r.execution.status === 'completed' || r.execution.status === 'incomplete';
    if (!ran && (r.behavioral.verdict !== null || r.captures.length > 0))
      bad(
        ['execution'],
        `a ${r.execution.status} result carries no behavioral verdict or captures`,
      );
    if (r.execution.status === 'completed' && r.behavioral.verdict === null)
      bad(['behavioral'], 'a completed result needs a behavioral verdict');
    if (
      (r.mismatch?.kind ?? null) !== (deriveMismatch(r.static, r.behavioral.verdict)?.kind ?? null)
    )
      bad(
        ['mismatch'],
        'mismatch does not follow from the static check and the behavioral verdict',
      );
  });
export type InvestigationResult = z.infer<typeof resultSchema>;
export type ResultBody = Omit<InvestigationResult, 'digest'>;

/* ------------------------------ credential guard ------------------------------ */

const SECRET_KEY =
  /(^|[-_. ])(api[-_]?key|secret|token|password|passwd|credential|authorization|bearer|private[-_]?key|cookie|command|cmd|exec|shell|script|url|uri|endpoint|href)s?($|[-_. ])|apikey|accesskey/iu;
const SECRET_VALUE = [
  /\b[a-z][a-z0-9+.-]*:\/\//iu,
  /\b(?:sk|pk|rk|ghp|gho|ghs|github_pat|xox[abprs])[-_][A-Za-z0-9_-]{16,}/u,
  /\bAKIA[0-9A-Z]{16}\b/u,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/iu,
];
/** Free text that is evidence, not configuration: quoted policy/code may legitimately contain URLs. */
const EVIDENCE_PATHS = [
  /^policy\.text$/u,
  /^quote\.text$/u,
  /^promise\.wording$/u,
  /^trigger\.citations\.\d+\.quote$/u,
  /\.summary$/u,
  /\.statement$/u,
  /\.explanation$/u,
  /\.description$/u,
  /^scope\.\d+$/u,
  /^missingEvidence\.\d+$/u,
  /\.reason$/u,
];

/** Refuses key-like fields and credential/URL-like values anywhere in an untrusted document. */
export function assertNoCredentialMaterial(value: unknown, path = ''): void {
  if (typeof value === 'string') {
    if (EVIDENCE_PATHS.some((p) => p.test(path))) return;
    if (SECRET_VALUE.some((p) => p.test(value)))
      throw new InteropError(
        'CREDENTIAL_MATERIAL',
        `${path || 'document'} looks like a credential or an execution URL; requests and results are data, not permission`,
      );
    return;
  }
  if (Array.isArray(value))
    return value.forEach((v, i) =>
      assertNoCredentialMaterial(v, path ? `${path}.${i}` : String(i)),
    );
  if (value && typeof value === 'object')
    for (const [k, v] of Object.entries(value)) {
      const at = path ? `${path}.${k}` : k;
      if (SECRET_KEY.test(k))
        throw new InteropError(
          'CREDENTIAL_MATERIAL',
          `field "${at}" is not allowed: no credentials, commands or URLs in requests or results`,
        );
      assertNoCredentialMaterial(v, at);
    }
}

function parseWith<T>(schema: z.ZodType<T>, raw: unknown, what: string): T {
  assertNoCredentialMaterial(raw);
  const parsed = schema.safeParse(raw);
  if (parsed.success) return parsed.data;
  const issues = parsed.error.issues
    .slice(0, 4)
    .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
  throw new InteropError('INVALID_DOCUMENT', `Not a valid ${what}: ${issues.join('; ')}`);
}
export const parseRequest = (raw: unknown): InvestigationRequest =>
  parseWith(requestSchema, raw, REQUEST_SCHEMA);
export const parseResult = (raw: unknown): InvestigationResult =>
  parseWith(resultSchema, raw, RESULT_SCHEMA);
export const sealRequest = (body: RequestBody): InvestigationRequest =>
  parseRequest({ ...body, digest: digestOf(body) });
export const sealResult = (body: ResultBody): InvestigationResult =>
  parseResult({ ...body, digest: digestOf(body) });
