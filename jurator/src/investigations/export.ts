// Build a sealed Investigator request from an accepted promise and a saved check run. Data only: no credentials,
// no commands, no URLs. The operator's adapter config stays with the operator; only its digest travels.
import { basename } from 'node:path';
import { BRAND } from '../brand.js';
import { promiseDigest } from '../cache/index.js';
import type { CheckRun, LockEntry, PromiseRecord } from '../contracts.js';
import { JuratorError } from '../util/errors.js';
import {
  InteropError,
  REQUEST_SCHEMA,
  canonicalJson,
  jsonValueAt,
  mappingSchema,
  quoteProblem,
  sealRequest,
  sha256Text,
  type InvestigationRequest,
} from './schema.js';

export interface ExportInput {
  readonly promise: PromiseRecord;
  readonly run: CheckRun;
  readonly lock: LockEntry | undefined;
  readonly sourceText: string;
  readonly mapping: unknown;
  readonly tenant: string;
  readonly workflow: string;
  readonly environment: string;
  readonly window: { start: string; end: string };
  readonly adapter: { id: string; configurationDigest: string };
  readonly scope: string;
  readonly budget: { maxModelTurns: number; maxToolCalls: number; maxRuntimeSeconds: number };
  readonly contextDigest?: string;
  readonly evidenceDigest?: string;
  readonly now: Date;
}

const collapse = (s: string): string => s.replace(/\s+/gu, ' ').trim();
const mediaOf = (locator: string): 'application/json' | 'text/markdown' | 'text/plain' =>
  /\.json$/iu.test(locator) ? 'application/json' : /\.(md|markdown)$/iu.test(locator) ? 'text/markdown' : 'text/plain';

/** Jurator quotes may be whitespace-collapsed; Investigator needs the raw span. Recopy it from the source. */
export function exactQuote(promise: PromiseRecord, source: string): InvestigationRequest['quote'] {
  const q = promise.quote;
  if (q.jsonPointer !== undefined) {
    const at = jsonValueAt(source, q.jsonPointer);
    if (typeof at === 'string') throw new JuratorError('QUOTE_NOT_IN_SOURCE', `${promise.id}: ${at}.`);
    // the exact form the schema accepts: a string value as-is, anything else as its canonical JSON text
    return { text: typeof at.value === 'string' ? at.value : JSON.stringify(at.value), locator: { kind: 'json-pointer', pointer: q.jsonPointer } };
  }
  const fits = (s: number, e: number) => e <= source.length && s < e && collapse(source.slice(s, e)) === collapse(q.text);
  let start = q.start;
  let end = q.end;
  if (start === undefined || end === undefined || !fits(start, end)) {
    const words = collapse(q.text).split(' ').map((w) => w.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'));
    const m = new RegExp(words.join('\\s+'), 'u').exec(source);
    if (!m) throw new JuratorError('QUOTE_NOT_IN_SOURCE', `${promise.id}: the quote is not in the saved policy text. Run pull and compile again.`);
    start = m.index;
    end = m.index + m[0].length;
  }
  return { text: source.slice(start, end), locator: { kind: 'span', start, end } };
}

export function buildRequest(i: ExportInput): InvestigationRequest {
  const p = i.promise;
  if (p.status !== 'accepted') throw new JuratorError('PROMISE_NOT_ACCEPTED', `${p.id} is ${p.status}. Accept it first (jurator accept ${p.id}); only accepted promises can be investigated.`);
  if (p.checkable === 'process') throw new JuratorError('NOT_INVESTIGABLE', `${p.id} is a process promise; only code and runtime promises can be investigated.`);
  if (!i.lock) throw new JuratorError('SOURCE_NOT_PULLED', `No saved policy source for ${p.quote.alias}. Run pull first.`);
  if (sha256Text(i.sourceText) !== p.quote.policySha256 || i.lock.sha256 !== p.quote.policySha256)
    throw new JuratorError('POLICY_CHANGED', `${p.id}: the saved policy text no longer matches the hash the promise was compiled from. Run compile again.`);
  const mapping = mappingSchema.safeParse(i.mapping);
  if (!mapping.success) throw new JuratorError('INVALID_MAPPING', 'The reviewed mapping needs profileId, profileVersion, requirementsDigest, reviewedBy and reviewedAt.');
  const media = mediaOf(i.lock.locator);
  const quote = exactQuote(p, i.sourceText);
  const bad = quoteProblem(i.sourceText, media, quote);
  if (bad) throw new JuratorError('QUOTE_NOT_IN_SOURCE', `${p.id}: ${bad}.`);
  const result = i.run.results.find((r) => r.promiseId === p.id);
  if (result && result.wording !== p.wording)
    throw new JuratorError('STALE_RUN', `${p.id}: run ${i.run.id} checked older wording. Run ${BRAND.command} check again, then export.`);
  const citations = (result?.citations ?? []).slice(0, 64);
  const repoName = basename(i.run.snapshot.repo).replace(/[^A-Za-z0-9._-]/gu, '-').replace(/^[^A-Za-z0-9]+/u, '') || 'repo';
  try {
    return sealRequest({
      schema: REQUEST_SCHEMA,
      createdAt: i.now.toISOString(),
      promise: { id: p.id, digest: promiseDigest(p), status: 'accepted', wording: p.wording, kind: p.kind, checkable: p.checkable },
      policy: { alias: p.quote.alias, sha256: p.quote.policySha256, mediaType: media, text: i.sourceText },
      quote,
      trigger: {
        runId: i.run.id,
        // a runtime promise is skipped by check today: say so instead of inventing a verdict
        codeCheck: result ? { level: result.level, verdict: result.verdict } : { level: 'none', verdict: 'not-checked' },
        repo: { name: repoName, commit: i.run.snapshot.commit },
        citations,
      },
      tenant: i.tenant,
      workflow: i.workflow,
      environment: i.environment,
      window: i.window,
      mapping: mapping.data,
      commitments: {
        context: i.contextDigest ?? sha256Text(canonicalJson({ tenant: i.tenant, workflow: i.workflow, environment: i.environment, window: i.window })),
        evidence: i.evidenceDigest ?? sha256Text(canonicalJson(citations)),
      },
      adapter: i.adapter,
      scope: i.scope,
      budget: i.budget,
    } as never);
  } catch (e) {
    if (e instanceof InteropError) throw new JuratorError(e.code, e.message);
    throw e;
  }
}
