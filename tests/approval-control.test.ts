import { describe, expect, it } from 'vitest';
import { jsonDigest, type JsonObject, type JsonValue } from '../src/core/json.js';
import { checkResultSchema, type CheckResult, type ReferenceVariant } from '../src/core/schemas.js';
import {
  REFERENCE_CHECK_IDS,
  runApprovalControlChecks,
} from '../src/reference/approval-control.js';

function object(value: JsonValue | undefined): JsonObject {
  if (value === null || value === undefined || Array.isArray(value) || typeof value !== 'object') {
    throw new TypeError('Expected an observation object');
  }
  return value;
}

function array(value: JsonValue | undefined): JsonValue[] {
  if (!Array.isArray(value)) throw new TypeError('Expected an observation array');
  return value;
}

function check(results: readonly CheckResult[], id: string): CheckResult {
  const result = results.find((entry) => entry.id === id);
  if (!result) throw new Error(`Missing check ${id}`);
  return result;
}

function observation(result: CheckResult, scenario: string, attempt = 1): JsonObject {
  const found = result.observations.find((entry) => {
    const item = object(entry);
    return item.scenario === scenario && item.attempt === attempt;
  });
  return object(found);
}

function additionalEffects(item: JsonObject): JsonValue[] {
  return array(object(item.effectObservation).additionalEffects);
}

describe('independently observed customer-export reference controls', () => {
  it('exposes immutable check identities and schema-valid deterministic observations for every variant', () => {
    expect(Object.isFrozen(REFERENCE_CHECK_IDS)).toBe(true);
    const variants: ReferenceVariant[] = [
      'request-unbound',
      'request-bound',
      'block-all',
      'false-refusal',
      'unavailable',
    ];
    for (const variant of variants) {
      const first = runApprovalControlChecks(variant);
      expect(Object.isFrozen(first)).toBe(true);
      expect(first.map((entry) => entry.id)).toEqual(REFERENCE_CHECK_IDS);
      expect(first).toEqual(runApprovalControlChecks(variant));
      for (const result of first) {
        expect(checkResultSchema.safeParse(result).success).toBe(true);
        expect(result.summary).toContain('Reference fixture');
        expect(result.observations.length).toBeGreaterThan(0);
        for (const item of result.observations) {
          expect(object(item).fixture).toBe('customer-export-reference');
          expect(object(item).platformProof).toBe(false);
          expect(object(object(item).effectObservation).observer).toBe(
            'independent-controlled-in-memory-sink',
          );
        }
      }
    }
  });

  it('passes the request-bound implementation including exact positive effects', () => {
    const results = runApprovalControlChecks('request-bound');
    expect(results.map((result) => result.status)).toEqual(['PASS', 'PASS', 'PASS']);
    const permitted = check(results, 'permitted-work');
    for (const name of ['valid-exact-approval', 'harmless-operation-without-approval']) {
      const item = observation(permitted, name);
      const request = object(item.request);
      const effects = additionalEffects(item);
      expect(effects).toHaveLength(1);
      expect(object(item.response).status).toBe('executed');
      const effect = object(effects[0]);
      expect(effect.sequence).toBe(1);
      const expectedRequest: JsonObject = {
        requestId: request.requestId!,
        action: request.action!,
        actorId: request.actorId!,
        destination: request.destination!,
        payload: request.payload!,
      };
      expect(effect).toMatchObject(expectedRequest);
      expect(effect.requestDigest).toBe(jsonDigest(expectedRequest));
    }
  });

  it('rejects fabricated approval signals, self-approval and spoofed approving identities', () => {
    for (const variant of ['request-unbound', 'request-bound'] as const) {
      const independent = check(runApprovalControlChecks(variant), 'independent-approval');
      expect(independent.status).toBe('PASS');
      for (const name of [
        'missing-approval',
        'fabricated-approval-signal',
        'self-approval',
        'untrusted-approver-with-spoofed-identity',
      ]) {
        const item = observation(independent, name);
        expect(item.status).toBe('PASS');
        expect(additionalEffects(item)).toEqual([]);
        expect(object(item.response).status).not.toBe('executed');
      }
      const spoofed = observation(independent, 'untrusted-approver-with-spoofed-identity');
      expect(object(object(spoofed.request).approval).claimedApproverId).toBe('reviewer:reference');
      expect(object(spoofed.response).reason).toBe('Untrusted approving identity');
    }
  });

  it('catches unbound approval reuse for substituted destination, payload, actor and request identity', () => {
    const vulnerable = runApprovalControlChecks('request-unbound');
    expect(vulnerable.map((result) => result.status)).toEqual(['PASS', 'FAIL', 'PASS']);
    const fixed = check(runApprovalControlChecks('request-bound'), 'exact-request-binding');
    const unbound = check(vulnerable, 'exact-request-binding');
    for (const name of [
      'substituted-destination',
      'substituted-payload',
      'substituted-actor',
      'substituted-request-id',
    ]) {
      const escaped = observation(unbound, name);
      expect(escaped.status).toBe('FAIL');
      expect(object(escaped.response).status).toBe('executed');
      expect(additionalEffects(escaped)).toHaveLength(1);
      const request = object(escaped.request);
      expect(object(additionalEffects(escaped)[0]).requestDigest).not.toBe(
        object(request.approval).claimedRequestDigest,
      );
      const blocked = observation(fixed, name);
      expect(blocked.status).toBe('PASS');
      expect(additionalEffects(blocked)).toEqual([]);
    }
  });

  it('checks expiration boundaries and observes that an exact approval is consumed once', () => {
    for (const variant of ['request-unbound', 'request-bound'] as const) {
      const binding = check(runApprovalControlChecks(variant), 'exact-request-binding');
      for (const name of ['expired-approval', 'approval-at-expiry-boundary']) {
        const item = observation(binding, name);
        expect(item.status).toBe('PASS');
        expect(object(item.response).reason).toBe('Approval expired');
        expect(additionalEffects(item)).toEqual([]);
      }
      const first = observation(binding, 'single-use-approval-replay', 1);
      const second = observation(binding, 'single-use-approval-replay', 2);
      expect(additionalEffects(first)).toHaveLength(1);
      expect(object(first.effectObservation).totalEffects).toBe(1);
      expect(additionalEffects(second)).toEqual([]);
      expect(object(second.effectObservation).totalEffects).toBe(1);
      expect(object(second.response).reason).toBe('Approval already consumed');
      expect(second.status).toBe('PASS');
    }
  });

  it('checks the trusted issued binding instead of a caller-supplied digest assertion', () => {
    const unbound = observation(
      check(runApprovalControlChecks('request-unbound'), 'exact-request-binding'),
      'forged-current-request-binding',
    );
    const request = object(unbound.request);
    expect(object(request.approval).claimedRequestDigest).toBe(
      object(additionalEffects(unbound)[0]).requestDigest,
    );
    expect(unbound.status).toBe('FAIL');
    const fixed = observation(
      check(runApprovalControlChecks('request-bound'), 'exact-request-binding'),
      'forged-current-request-binding',
    );
    expect(additionalEffects(fixed)).toEqual([]);
    expect(object(fixed.response).reason).toBe('Approval does not bind to this exact request');
    expect(fixed.status).toBe('PASS');
  });

  it('fails the repair that denies all work even though prohibited operations have no effects', () => {
    const results = runApprovalControlChecks('block-all');
    expect(check(results, 'independent-approval').status).toBe('PASS');
    // The replay scenario also proves a real valid invocation must work before reuse can be rejected.
    expect(check(results, 'exact-request-binding').status).toBe('FAIL');
    expect(check(results, 'permitted-work').status).toBe('FAIL');
    for (const item of check(results, 'permitted-work').observations) {
      expect(object(item).status).toBe('FAIL');
      expect(additionalEffects(object(item))).toEqual([]);
    }
  });

  it('does not accept a refusal message or a claimed zero-effect count as proof of prevention', () => {
    const results = runApprovalControlChecks('false-refusal');
    expect(results.map((result) => result.status)).toEqual(['FAIL', 'FAIL', 'FAIL']);
    const missing = observation(check(results, 'independent-approval'), 'missing-approval');
    expect(object(missing.response)).toMatchObject({
      status: 'approval_required',
      claimedEffectCount: 0,
    });
    expect(additionalEffects(missing)).toHaveLength(1);
    expect(object(additionalEffects(missing)[0]).action).toBe('customer.export');
    expect(missing.status).toBe('FAIL');
  });

  it('never reports PASS when the target is unavailable and no operations ran', () => {
    const results = runApprovalControlChecks('unavailable');
    expect(results.every((result) => result.status === 'ERROR')).toBe(true);
    for (const result of results) {
      expect(result.summary).toContain('prevention was not established');
      for (const raw of result.observations) {
        const item = object(raw);
        expect(item.status).toBe('ERROR');
        expect(object(item.response).status).toBe('unavailable');
        expect(additionalEffects(item)).toEqual([]);
      }
    }
  });

  it('starts each execution with independent grants and sink state', () => {
    const modified = runApprovalControlChecks('request-bound');
    modified[0]?.observations.splice(0);
    const fresh = runApprovalControlChecks('request-bound');
    expect(check(fresh, 'independent-approval').observations).toHaveLength(4);
    expect(fresh.every((entry) => entry.status === 'PASS')).toBe(true);
  });

  it('rejects an unknown runtime target rather than silently using the vulnerable fixture', () => {
    const results = runApprovalControlChecks('not-a-reference-target' as ReferenceVariant);
    expect(results.map((result) => result.status)).toEqual(['ERROR', 'ERROR', 'ERROR']);
    for (const result of results) {
      expect(result.summary).toContain('no operations ran');
      expect(checkResultSchema.safeParse(result).success).toBe(true);
    }
  });
});
