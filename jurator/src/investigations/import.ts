// Import an Investigator result, link it to the saved request and record it beside (never inside) the code check.
import type { PromiseRecord } from '../contracts.js';
import { promiseDigest } from '../cache/index.js';
import { JuratorError } from '../util/errors.js';
import { z } from 'zod';
import {
  InteropError,
  canonicalJson,
  digestOf,
  parseRequest,
  parseResult,
  requestSchema,
  resultSchema,
  type InvestigationRequest,
  type InvestigationResult,
} from './schema.js';

/** `.jurator/investigations/<id>.json`: level/verdict and behavioral result stay separate fields. */
export const linkedRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().min(1),
    promiseId: z.string(),
    importedAt: z.string(),
    promiseDigest: z.string(),
    codeCheck: z.object({ level: z.string(), verdict: z.string(), runId: z.string() }).strict(),
    behavioral: z.object({ execution: z.string(), verdict: z.string().nullable() }).strict(),
    mismatch: z.object({ kind: z.string(), explanation: z.string() }).strict().nullable(),
    request: requestSchema,
    result: resultSchema,
    digest: z.string(),
  })
  .strict();
export type LinkedRecord = z.infer<typeof linkedRecordSchema>;

/** Throws when the result is not for this request. */
export function checkBinding(request: InvestigationRequest, result: InvestigationResult): void {
  const fail = (why: string): never => {
    throw new JuratorError('BINDING_MISMATCH', `The result is not bound to this request: ${why}.`);
  };
  if (result.requestDigest !== request.digest) fail('request digest differs');
  if (canonicalJson(result.adapter) !== canonicalJson(request.adapter)) fail('adapter identity differs');
  if (canonicalJson(result.static) !== canonicalJson(request.trigger.codeCheck)) fail('the static code check was altered');
  if (result.execution.status !== 'unsupported' && canonicalJson({ ...result.profile, requirementsDigest: undefined }) !== canonicalJson({ id: request.mapping.profileId, version: request.mapping.profileVersion }))
    fail('profile differs from the reviewed mapping');
  if (result.execution.status !== 'unsupported' && result.profile?.requirementsDigest !== request.mapping.requirementsDigest) fail('requirements digest differs from the reviewed mapping');
  for (const c of request.trigger.citations)
  {
    if (c.quote.split(/\r?\n/u).length !== c.endLine - c.startLine + 1) fail(`citation ${c.path}:${c.startLine} does not span its lines`);
    const head = request.trigger.repo.commit;
    if (!head.startsWith(c.commit) && !c.commit.startsWith(head)) fail(`citation ${c.path} is at a different commit than the trigger`);
  }
}

function wrap<T>(f: () => T): T {
  try {
    return f();
  } catch (e) {
    if (e instanceof InteropError) throw new JuratorError(e.code, e.message);
    throw e;
  }
}

/** The workspace state a record must still agree with: the accepted promise and its locked policy hash. */
export interface CurrentState {
  readonly promise: PromiseRecord | undefined;
  readonly lockSha256: string | undefined;
}

/** Problems binding a request to the current promise and locked policy source (empty when bound). */
export function currentProblems(request: InvestigationRequest, cur: CurrentState): string[] {
  const p = cur.promise;
  if (!p) return [`${request.promise.id} is not in this workspace.`];
  const out: string[] = [];
  if (p.status !== 'accepted') out.push(`${p.id} is ${p.status}, not accepted.`);
  if (request.promise.digest !== promiseDigest(p)) out.push(`${p.id} changed since the request was exported: the behavioral result is stale.`);
  if (request.policy.sha256 !== p.quote.policySha256 || request.policy.sha256 !== cur.lockSha256)
    out.push('The request policy source is not the locked source this promise was compiled from.');
  return out;
}

/** Summary fields are derived from the request and result, never trusted from the record. */
function summaryOf(request: InvestigationRequest, result: InvestigationResult) {
  return {
    id: `${request.promise.id}.${result.digest.slice(0, 12)}`,
    promiseId: request.promise.id,
    promiseDigest: request.promise.digest,
    codeCheck: { ...request.trigger.codeCheck, runId: request.trigger.runId },
    behavioral: { execution: result.execution.status, verdict: result.behavioral.verdict },
    mismatch: result.mismatch,
  };
}

export function buildRecord(input: { requestRaw: unknown; resultRaw: unknown; current: CurrentState; now: Date }): LinkedRecord {
  const request = wrap(() => parseRequest(input.requestRaw));
  const result = wrap(() => parseResult(input.resultRaw));
  checkBinding(request, result);
  const problems = currentProblems(request, input.current);
  if (problems.length) throw new JuratorError('NOT_BOUND_TO_WORKSPACE', problems.join(' '));
  const body = { schemaVersion: 1 as const, ...summaryOf(request, result), importedAt: input.now.toISOString(), request, result };
  return { ...body, digest: digestOf(body) };
}

export interface RecordVerification {
  readonly ok: boolean;
  readonly integrity: 'consistent-with-supplied-records';
  /** Records and results are unkeyed: a matching digest shows consistency, not who wrote them. */
  readonly authenticity: 'not-established';
  readonly problems: string[];
  readonly notes: string[];
}
/** No AI, no network: recompute every digest, the source hash, the exact quote, the request binding and the workspace state. */
export function verifyRecord(raw: unknown, current: CurrentState): RecordVerification {
  const problems: string[] = [];
  const notes: string[] = [];
  const done = (): RecordVerification => ({ ok: problems.length === 0, integrity: 'consistent-with-supplied-records', authenticity: 'not-established', problems, notes });
  const parsed = linkedRecordSchema.safeParse(raw);
  if (!parsed.success) {
    problems.push(`Not a linked investigation record: ${parsed.error.issues[0]?.message ?? 'invalid'}`);
    return done();
  }
  const rec = parsed.data;
  try {
    if (digestOf(rec) !== rec.digest) problems.push('Record digest does not match: it was changed after import.');
    const request = parseRequest(rec.request); // digest, sha256(source text), exact quote at its locator
    const result = parseResult(rec.result);
    checkBinding(request, result);
    const want = summaryOf(request, result);
    for (const k of Object.keys(want) as Array<keyof typeof want>)
      if (canonicalJson(rec[k]) !== canonicalJson(want[k])) problems.push(`Record field "${k}" does not match its request and result.`);
    problems.push(...currentProblems(request, current));
  } catch (e) {
    problems.push(e instanceof Error ? e.message : String(e));
  }
  return done();
}
