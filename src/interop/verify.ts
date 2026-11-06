import {
  InteropError,
  parseRequest,
  parseResult,
  type InvestigationRequest,
  type InvestigationResult,
} from './schema.js';
import { findInteropProfile } from './profiles.js';

export interface InteropVerification {
  readonly integrity: 'consistent-with-supplied-records';
  readonly authenticity: 'not-established';
  readonly requestBinding: 'verified' | 'not-checked';
  readonly execution: InvestigationResult['execution']['status'];
  readonly behavioral: InvestigationResult['behavioral']['verdict'];
  readonly mismatch: InvestigationResult['mismatch'];
}

/** Recomputes digests, policy source hash, exact quote, citations shape and (with the request) the binding. */
export function verifyInterop(resultInput: unknown, requestInput?: unknown): InteropVerification {
  const result = parseResult(resultInput); // digest + mismatch consistency + credential guard
  let request: InvestigationRequest | undefined;
  if (requestInput !== undefined) {
    request = parseRequest(requestInput); // digest, sha256(source text), exact quote at locator
    const fail = (why: string): never => {
      throw new InteropError('BINDING_MISMATCH', `Result is not bound to this request: ${why}`);
    };
    if (result.requestDigest !== request.digest) fail('request digest differs');
    if (canonicalLike(result.adapter) !== canonicalLike(request.adapter))
      fail('adapter identity differs');
    if (canonicalLike(result.static) !== canonicalLike(request.trigger.codeCheck))
      fail('static code check was altered');
    for (const c of request.trigger.citations) {
      if (c.quote.split(/\r?\n/u).length !== c.endLine - c.startLine + 1)
        fail(`citation ${c.path}:${c.startLine} does not span its lines`);
      if (
        !request.trigger.repo.commit.startsWith(c.commit) &&
        !c.commit.startsWith(request.trigger.repo.commit)
      )
        fail(`citation ${c.path} is at a different commit than the trigger`);
    }
    if (result.execution.status !== 'unsupported') {
      const m = request.mapping;
      const p = findInteropProfile(m.profileId, m.profileVersion);
      if (
        !result.profile ||
        result.profile.id !== m.profileId ||
        result.profile.version !== m.profileVersion ||
        result.profile.requirementsDigest !== m.requirementsDigest
      )
        fail('profile differs from the reviewed mapping');
      if (!p || p.requirementsDigest !== m.requirementsDigest)
        fail('mapping is not a registered profile with this requirements digest');
    }
  }
  return {
    integrity: 'consistent-with-supplied-records',
    authenticity: 'not-established',
    requestBinding: request ? 'verified' : 'not-checked',
    execution: result.execution.status,
    behavioral: result.behavioral.verdict,
    mismatch: result.mismatch,
  };
}
const canonicalLike = (v: unknown): string => JSON.stringify(v, Object.keys(v as object).sort());
