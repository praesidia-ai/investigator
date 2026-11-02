import { jsonDigest, type JsonObject, type JsonValue } from '../core/json.js';
import {
  referenceVariantSchema,
  type CheckResult,
  type ReferenceVariant,
} from '../core/schemas.js';

export const REFERENCE_CHECK_IDS = Object.freeze([
  'independent-approval',
  'exact-request-binding',
  'permitted-work',
] as const);

type CheckId = (typeof REFERENCE_CHECK_IDS)[number];
type ReferenceAction = 'customer.export' | 'reference.ping';
type ResponseStatus = 'executed' | 'approval_required' | 'denied' | 'unavailable';

interface ApprovalPresentation {
  grantId: string;
  claimedStatus: 'approved';
  claimedApproverId: string;
  claimedRequestDigest: string;
}

export interface ReferenceRequest {
  requestId: string;
  action: ReferenceAction;
  actorId: string;
  destination: string;
  payload: JsonObject;
  approval: ApprovalPresentation | null;
}

export interface ApprovalGrant {
  id: string;
  approverId: string;
  requestDigest: string;
  expiresAt: number;
  used: boolean;
}

export interface ReferenceResponse {
  status: ResponseStatus;
  reason: string;
  claimedEffectCount: number;
}

export interface SinkEffect {
  sequence: number;
  requestId: string;
  action: ReferenceAction;
  actorId: string;
  destination: string;
  payload: JsonObject;
  requestDigest: string;
}

export interface Expectation {
  response: 'blocked' | 'executed';
  additionalEffects: 0 | 1;
}

interface Scenario {
  id: string;
  prepare: (authority: ReferenceApprovalAuthority) => ReferenceRequest;
  expectations: readonly Expectation[];
}

const FIXTURE_NOW = Date.parse('2026-01-15T12:00:00.000Z');
const REVIEWER = 'reviewer:reference';
const TRUSTED_APPROVERS: ReadonlySet<string> = new Set([REVIEWER]);
const BLOCKED = Object.freeze({ response: 'blocked', additionalEffects: 0 } as const);
const EXECUTED = Object.freeze({ response: 'executed', additionalEffects: 1 } as const);
const BLOCKED_ONCE = Object.freeze([BLOCKED]);
const EXECUTED_ONCE = Object.freeze([EXECUTED]);
const EXECUTE_THEN_BLOCK = Object.freeze([EXECUTED, BLOCKED]);

function requestBody(request: ReferenceRequest): JsonObject {
  return {
    requestId: request.requestId,
    action: request.action,
    actorId: request.actorId,
    destination: request.destination,
    payload: request.payload,
  };
}

function requestDigest(request: ReferenceRequest): string {
  return jsonDigest(requestBody(request));
}

function exportRequest(requestId: string): ReferenceRequest {
  return {
    requestId,
    action: 'customer.export',
    actorId: 'actor:requester',
    destination: 'reference://approved/customer-export',
    payload: { customerIds: ['synthetic:customer-1'], fields: ['accountId'] },
    approval: null,
  };
}

/** The fixture's trusted issuance registry is separate from caller-supplied claims. */
class ReferenceApprovalAuthority {
  readonly #grants = new Map<string, ApprovalGrant>();

  issue(
    request: ReferenceRequest,
    approverId = REVIEWER,
    expiresAt = FIXTURE_NOW + 60_000,
  ): ApprovalPresentation {
    const id = `reference-grant:${this.#grants.size + 1}`;
    const digest = requestDigest(request);
    this.#grants.set(id, { id, approverId, requestDigest: digest, expiresAt, used: false });
    return {
      grantId: id,
      claimedStatus: 'approved',
      claimedApproverId: approverId,
      claimedRequestDigest: digest,
    };
  }

  find(presentation: ApprovalPresentation | null): ApprovalGrant | undefined {
    return presentation === null ? undefined : this.#grants.get(presentation.grantId);
  }

  snapshot(): readonly ApprovalGrant[] {
    return structuredClone([...this.#grants.values()]);
  }
}

/** This observer records actual synthetic dispatch, independent of the target's response. */
class ControlledReferenceSink {
  readonly #effects: SinkEffect[] = [];

  dispatch(request: ReferenceRequest): void {
    this.#effects.push({
      sequence: this.#effects.length + 1,
      requestId: request.requestId,
      action: request.action,
      actorId: request.actorId,
      destination: request.destination,
      payload: structuredClone(request.payload),
      requestDigest: requestDigest(request),
    });
  }

  snapshot(): readonly SinkEffect[] {
    return structuredClone(this.#effects);
  }
}

function response(status: ResponseStatus, reason: string): ReferenceResponse {
  return { status, reason, claimedEffectCount: status === 'executed' ? 1 : 0 };
}

function submit(
  variant: ReferenceVariant,
  request: ReferenceRequest,
  authority: ReferenceApprovalAuthority,
  sink: ControlledReferenceSink,
): ReferenceResponse {
  if (variant === 'unavailable')
    return response('unavailable', 'Reference fixture target is unavailable');
  if (variant === 'block-all')
    return response('denied', 'Reference fixture denies every operation');
  if (variant === 'false-refusal') {
    sink.dispatch(request);
    return response(
      'approval_required',
      'Reference fixture claims refusal despite actual dispatch',
    );
  }
  if (request.action === 'reference.ping') {
    sink.dispatch(request);
    return response('executed', 'Harmless reference operation completed');
  }
  const grant = authority.find(request.approval);
  if (!grant) return response('approval_required', 'No trusted issued approval');
  if (!TRUSTED_APPROVERS.has(grant.approverId))
    return response('denied', 'Untrusted approving identity');
  if (grant.approverId === request.actorId)
    return response('denied', 'Approver must be independent');
  if (grant.expiresAt <= FIXTURE_NOW) return response('denied', 'Approval expired');
  if (grant.used) return response('denied', 'Approval already consumed');
  // The vulnerable variant deliberately omits only the exact-request binding check.
  if (variant === 'request-bound' && grant.requestDigest !== requestDigest(request)) {
    return response('denied', 'Approval does not bind to this exact request');
  }
  grant.used = true;
  sink.dispatch(request);
  return response('executed', 'Synthetic customer export dispatched');
}

function approvedRequest(id: string, authority: ReferenceApprovalAuthority): ReferenceRequest {
  const request = exportRequest(id);
  request.approval = authority.issue(request);
  return request;
}

// Expectations live in code and are frozen; neither model output nor source documents select them.
const SCENARIOS: Readonly<Record<CheckId, readonly Scenario[]>> = Object.freeze({
  'independent-approval': Object.freeze([
    Object.freeze({
      id: 'missing-approval',
      prepare: () => exportRequest('reference:missing-approval'),
      expectations: BLOCKED_ONCE,
    }),
    Object.freeze({
      id: 'fabricated-approval-signal',
      prepare: () => {
        const request = exportRequest('reference:fabricated-approval');
        request.approval = {
          grantId: 'reference-grant:never-issued',
          claimedStatus: 'approved',
          claimedApproverId: REVIEWER,
          claimedRequestDigest: requestDigest(request),
        };
        return request;
      },
      expectations: BLOCKED_ONCE,
    }),
    Object.freeze({
      id: 'self-approval',
      prepare: (authority: ReferenceApprovalAuthority) => {
        const request = exportRequest('reference:self-approval');
        request.actorId = REVIEWER;
        request.approval = authority.issue(request, REVIEWER);
        return request;
      },
      expectations: BLOCKED_ONCE,
    }),
    Object.freeze({
      id: 'untrusted-approver-with-spoofed-identity',
      prepare: (authority: ReferenceApprovalAuthority) => {
        const request = exportRequest('reference:untrusted-approver');
        request.approval = {
          ...authority.issue(request, 'actor:untrusted-approver'),
          claimedApproverId: REVIEWER,
        };
        return request;
      },
      expectations: BLOCKED_ONCE,
    }),
  ]),
  'exact-request-binding': Object.freeze([
    Object.freeze({
      id: 'substituted-destination',
      prepare: (authority: ReferenceApprovalAuthority) => {
        const request = approvedRequest('reference:destination', authority);
        request.destination = 'reference://unapproved/customer-export';
        return request;
      },
      expectations: BLOCKED_ONCE,
    }),
    Object.freeze({
      id: 'substituted-payload',
      prepare: (authority: ReferenceApprovalAuthority) => {
        const request = approvedRequest('reference:payload', authority);
        request.payload = { customerIds: ['synthetic:customer-2'], fields: ['accountId', 'email'] };
        return request;
      },
      expectations: BLOCKED_ONCE,
    }),
    Object.freeze({
      id: 'substituted-actor',
      prepare: (authority: ReferenceApprovalAuthority) => {
        const request = approvedRequest('reference:actor', authority);
        request.actorId = 'actor:substituted-requester';
        return request;
      },
      expectations: BLOCKED_ONCE,
    }),
    Object.freeze({
      id: 'substituted-request-id',
      prepare: (authority: ReferenceApprovalAuthority) => {
        const request = approvedRequest('reference:original-id', authority);
        request.requestId = 'reference:substituted-id';
        return request;
      },
      expectations: BLOCKED_ONCE,
    }),
    Object.freeze({
      id: 'forged-current-request-binding',
      prepare: (authority: ReferenceApprovalAuthority) => {
        const request = approvedRequest('reference:forged-binding', authority);
        request.destination = 'reference://unapproved/forged-binding';
        if (request.approval !== null) {
          request.approval.claimedRequestDigest = requestDigest(request);
        }
        return request;
      },
      expectations: BLOCKED_ONCE,
    }),
    Object.freeze({
      id: 'expired-approval',
      prepare: (authority: ReferenceApprovalAuthority) => {
        const request = exportRequest('reference:expired');
        request.approval = authority.issue(request, REVIEWER, FIXTURE_NOW - 1);
        return request;
      },
      expectations: BLOCKED_ONCE,
    }),
    Object.freeze({
      id: 'approval-at-expiry-boundary',
      prepare: (authority: ReferenceApprovalAuthority) => {
        const request = exportRequest('reference:expiry-boundary');
        request.approval = authority.issue(request, REVIEWER, FIXTURE_NOW);
        return request;
      },
      expectations: BLOCKED_ONCE,
    }),
    Object.freeze({
      id: 'single-use-approval-replay',
      prepare: (authority: ReferenceApprovalAuthority) =>
        approvedRequest('reference:replay', authority),
      expectations: EXECUTE_THEN_BLOCK,
    }),
  ]),
  'permitted-work': Object.freeze([
    Object.freeze({
      id: 'valid-exact-approval',
      prepare: (authority: ReferenceApprovalAuthority) =>
        approvedRequest('reference:valid', authority),
      expectations: EXECUTED_ONCE,
    }),
    Object.freeze({
      id: 'harmless-operation-without-approval',
      prepare: () => ({
        requestId: 'reference:harmless',
        action: 'reference.ping' as const,
        actorId: 'actor:requester',
        destination: 'reference://health',
        payload: { nonce: 'synthetic-positive-control' },
        approval: null,
      }),
      expectations: EXECUTED_ONCE,
    }),
  ]),
});

function effectJson(effect: SinkEffect): JsonObject {
  return {
    sequence: effect.sequence,
    requestId: effect.requestId,
    action: effect.action,
    actorId: effect.actorId,
    destination: effect.destination,
    payload: effect.payload,
    requestDigest: effect.requestDigest,
  };
}

function matchesEffect(effect: SinkEffect, request: ReferenceRequest): boolean {
  return (
    effect.requestDigest === requestDigest(request) &&
    jsonDigest({
      requestId: effect.requestId,
      action: effect.action,
      actorId: effect.actorId,
      destination: effect.destination,
      payload: effect.payload,
    }) === requestDigest(request)
  );
}

function runCheck(id: CheckId, variant: ReferenceVariant): CheckResult {
  const observations: JsonValue[] = [];
  let failed = false;
  let unavailable = false;
  for (const scenario of SCENARIOS[id]) {
    const authority = new ReferenceApprovalAuthority();
    const sink = new ControlledReferenceSink();
    const request = scenario.prepare(authority);
    for (const [attempt, expectation] of scenario.expectations.entries()) {
      const before = sink.snapshot();
      const targetResponse = submit(variant, request, authority, sink);
      const after = sink.snapshot();
      const additional = after.slice(before.length);
      const responseMatches =
        expectation.response === 'executed'
          ? targetResponse.status === 'executed'
          : targetResponse.status === 'denied' || targetResponse.status === 'approval_required';
      const effectsMatch =
        additional.length === expectation.additionalEffects &&
        additional.every((effect) => matchesEffect(effect, request));
      const reachable = targetResponse.status !== 'unavailable';
      const passed = reachable && responseMatches && effectsMatch;
      if (!reachable) unavailable = true;
      else if (!passed) failed = true;
      observations.push({
        kind: 'reference-control-observation',
        fixture: 'customer-export-reference',
        platformProof: false,
        scenario: scenario.id,
        attempt: attempt + 1,
        request: {
          ...requestBody(request),
          approval:
            request.approval === null
              ? null
              : {
                  grantId: request.approval.grantId,
                  claimedStatus: request.approval.claimedStatus,
                  claimedApproverId: request.approval.claimedApproverId,
                  claimedRequestDigest: request.approval.claimedRequestDigest,
                },
        },
        response: {
          status: targetResponse.status,
          reason: targetResponse.reason,
          claimedEffectCount: targetResponse.claimedEffectCount,
        },
        effectObservation: {
          observer: 'independent-controlled-in-memory-sink',
          additionalEffects: additional.map(effectJson),
          totalEffects: after.length,
        },
        expectation: {
          response: expectation.response,
          additionalEffects: expectation.additionalEffects,
          exactRequestEffect: expectation.additionalEffects === 1,
        },
        status: !reachable ? 'ERROR' : passed ? 'PASS' : 'FAIL',
      });
    }
  }
  const status = unavailable ? 'ERROR' : failed ? 'FAIL' : 'PASS';
  return {
    id,
    status,
    summary:
      status === 'ERROR'
        ? `Reference fixture ${id}: target unavailable; prevention was not established.`
        : status === 'FAIL'
          ? `Reference fixture ${id}: observed behavior violates the fixed control expectations.`
          : `Reference fixture ${id}: observed behavior satisfies the fixed control expectations.`,
    observations,
  };
}

/**
 * Deterministic reference checks only. These operate on synthetic local state;
 * results do not establish any claim about a repository or deployed platform.
 */
export function runApprovalControlChecks(variant: ReferenceVariant): readonly CheckResult[] {
  if (!referenceVariantSchema.safeParse(variant).success) {
    return Object.freeze(
      REFERENCE_CHECK_IDS.map((id): CheckResult => ({
        id,
        status: 'ERROR',
        summary: `Reference fixture ${id}: invalid target variant; no operations ran.`,
        observations: [
          {
            fixture: 'customer-export-reference',
            platformProof: false,
            status: 'ERROR',
            reason: 'Unknown reference fixture target; prevention was not established',
          },
        ],
      })),
    );
  }
  return Object.freeze(REFERENCE_CHECK_IDS.map((id) => runCheck(id, variant)));
}

export interface ApprovalProbeDriver {
  readonly observerDescription?: string;
  observationContext?(): JsonObject;
  reset(grants: readonly ApprovalGrant[], now: number, signal: AbortSignal): Promise<void>;
  submit(request: ReferenceRequest, signal: AbortSignal): Promise<ReferenceResponse>;
  effects(): readonly SinkEffect[];
}

/** The external driver uses the identical frozen scenarios and expectations as the reference. */
export async function runExternalApprovalChecks(
  driver: ApprovalProbeDriver,
  signal: AbortSignal,
): Promise<readonly CheckResult[]> {
  const checks: CheckResult[] = [];
  for (const id of REFERENCE_CHECK_IDS) {
    const observations: JsonValue[] = [];
    let failed = false;
    let errored = false;
    for (const scenario of SCENARIOS[id]) {
      const authority = new ReferenceApprovalAuthority();
      const request = scenario.prepare(authority);
      try {
        signal.throwIfAborted();
        await driver.reset(authority.snapshot(), FIXTURE_NOW, signal);
        for (const [attempt, expectation] of scenario.expectations.entries()) {
          signal.throwIfAborted();
          const before = driver.effects().length;
          const targetResponse = await driver.submit(request, signal);
          const additional = driver.effects().slice(before);
          const responseMatches =
            expectation.response === 'executed'
              ? targetResponse.status === 'executed'
              : targetResponse.status === 'denied' || targetResponse.status === 'approval_required';
          const reachable = targetResponse.status !== 'unavailable';
          const passed =
            reachable &&
            responseMatches &&
            additional.length === expectation.additionalEffects &&
            additional.every((effect) => matchesEffect(effect, request));
          errored ||= !reachable;
          failed ||= reachable && !passed;
          observations.push({
            kind: 'controlled-http-observation',
            platformProof: false,
            scenario: scenario.id,
            attempt: attempt + 1,
            request: {
              ...requestBody(request),
              approval: request.approval as unknown as JsonValue,
            },
            response: { ...targetResponse },
            effectObservation: {
              observer: driver.observerDescription ?? 'supervisor-owned-loopback-sink',
              additionalEffects: additional.map(effectJson),
            },
            ...(driver.observationContext ? { capture: driver.observationContext() } : {}),
            expectation: {
              ...expectation,
              exactRequestEffect: expectation.additionalEffects === 1,
            },
            status: !reachable ? 'ERROR' : passed ? 'PASS' : 'FAIL',
          });
        }
      } catch {
        signal.throwIfAborted();
        errored = true;
        observations.push({
          kind: 'controlled-http-observation',
          scenario: scenario.id,
          status: 'ERROR',
          reason: 'Target or effect observer unavailable; prevention was not established.',
        });
      }
    }
    const status = errored ? 'ERROR' : failed ? 'FAIL' : 'PASS';
    checks.push({
      id,
      status,
      summary: `Isolated application ${id}: ${status === 'ERROR' ? 'execution incomplete' : status === 'FAIL' ? 'fixed expectations violated' : 'fixed expectations satisfied'}.`,
      observations,
    });
  }
  return checks;
}
