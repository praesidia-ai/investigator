import {
  CANCELLATION_EXPERIMENT_IDS,
  CANCELLATION_PROFILE,
  INDEPENDENT_ROOT,
  ROOT_TO_REVOKE,
  cancellationCaptureSchema,
  cancellationExperimentIdSchema,
  type CancellationAssessment,
  type CancellationAttempt,
  type CancellationCapture,
  type CancellationCheck,
} from './schemas.js';

function attemptKey(value: { rootId: string; jobId: string; attemptId: string }): string {
  return JSON.stringify([value.rootId, value.jobId, value.attemptId]);
}
function jobKey(value: { rootId: string; jobId: string; requestDigest: string }): string {
  return JSON.stringify([value.rootId, value.jobId, value.requestDigest]);
}

function experimentId(input: unknown): CancellationCheck['experimentId'] {
  if (!input || typeof input !== 'object' || !Object.hasOwn(input, 'experimentId')) return null;
  const parsed = cancellationExperimentIdSchema.safeParse(
    (input as { experimentId: unknown }).experimentId,
  );
  return parsed.success ? parsed.data : null;
}

function check(
  input: unknown,
  status: CancellationCheck['status'],
  reason: string,
  witnessPointers: string[] = [],
): CancellationCheck {
  return { experimentId: experimentId(input), status, reason, witnessPointers };
}

/** Check identity/time/sequence correlation without treating a worker status as a business effect. */
function captureIssue(capture: CancellationCapture): string | null {
  const start = Date.parse(capture.startedAt),
    finish = Date.parse(capture.finishedAt);
  if (start > finish) return 'The capture window is reversed.';
  const within = (value: string) => Date.parse(value) >= start && Date.parse(value) <= finish;
  if (
    (capture.cut && !within(capture.cut.observedAt)) ||
    capture.effects.some((effect) => !within(effect.observedAt))
  )
    return 'A revocation or acceptance witness lies outside the capture window.';
  if (capture.cut && capture.cut.rootId !== ROOT_TO_REVOKE)
    return "The acknowledged revocation does not name the profile's selected work root.";

  const attempts = new Map<string, CancellationAttempt>();
  const sequences = new Set<number>();
  const enqueues = new Map<number, string>();
  for (const attempt of capture.attempts) {
    const key = attemptKey(attempt);
    if (attempts.has(key)) return 'A qualified attempt identity is duplicated.';
    if (attempt.enqueueSequence >= attempt.dispatchSequence)
      return 'An attempted dispatch does not follow its recorded enqueue.';
    const existing = enqueues.get(attempt.enqueueSequence);
    if (existing && existing !== jobKey(attempt))
      return 'One enqueue sequence was assigned to different work or request commitments.';
    enqueues.set(attempt.enqueueSequence, jobKey(attempt));
    if (sequences.has(attempt.dispatchSequence)) return 'A dispatch sequence is duplicated.';
    sequences.add(attempt.dispatchSequence);
    attempts.set(key, attempt);
  }
  for (const enqueue of enqueues.keys()) {
    if (sequences.has(enqueue))
      return 'An enqueue and dispatch claim the same supervisor sequence.';
    sequences.add(enqueue);
  }
  if (capture.cut) {
    if (sequences.has(capture.cut.ackSequence))
      return 'The revocation acknowledgment collides with another supervisor event.';
    sequences.add(capture.cut.ackSequence);
  }
  for (const effect of capture.effects) {
    const attempt = attempts.get(attemptKey(effect));
    if (!attempt || attempt.requestDigest !== effect.requestDigest)
      return 'A destination acceptance does not match a qualified attempted request.';
    if (effect.acceptSequence <= attempt.dispatchSequence)
      return 'A destination acceptance does not follow the matching attempted dispatch.';
    if (sequences.has(effect.acceptSequence))
      return 'A destination acceptance sequence is duplicated or collides with another event.';
    sequences.add(effect.acceptSequence);
  }
  return null;
}

function preconditionIssue(capture: CancellationCapture): string | null {
  const cut = capture.cut!;
  const attempts = capture.attempts;
  const beforeCut = (attempt: CancellationAttempt) =>
    attempt.enqueueSequence < cut.ackSequence && attempt.dispatchSequence < cut.ackSequence;
  const afterCut = (attempt: CancellationAttempt) =>
    attempt.enqueueSequence < cut.ackSequence && attempt.dispatchSequence > cut.ackSequence;
  switch (capture.experimentId) {
    case 'queued-after-revoke':
      return attempts.length === 1 &&
        attempts[0]!.rootId === ROOT_TO_REVOKE &&
        afterCut(attempts[0]!)
        ? null
        : 'The capture does not establish one queued selected-root dispatch after acknowledged revocation.';
    case 'retry-after-revoke': {
      const [first, second] = attempts;
      return attempts.length === 2 &&
        first &&
        second &&
        first.rootId === ROOT_TO_REVOKE &&
        second.rootId === ROOT_TO_REVOKE &&
        first.jobId === second.jobId &&
        first.requestDigest === second.requestDigest &&
        first.enqueueSequence === second.enqueueSequence &&
        afterCut(first) &&
        afterCut(second)
        ? null
        : 'The capture does not establish two distinct post-revocation attempts of the same queued request.';
    }
    case 'independent-root':
      return attempts.length === 2 &&
        attempts.filter((attempt) => attempt.rootId === ROOT_TO_REVOKE).length === 1 &&
        attempts.filter((attempt) => attempt.rootId === INDEPENDENT_ROOT).length === 1 &&
        attempts.every(afterCut)
        ? null
        : 'The capture does not establish both retired and independently authorized roots after the selected revocation.';
    case 'accepted-before-revoke':
      return attempts.length === 1 &&
        attempts[0]!.rootId === ROOT_TO_REVOKE &&
        beforeCut(attempts[0]!)
        ? null
        : 'The capture does not establish the selected-root request dispatched before revocation.';
  }
}

/**
 * Assess one finite experiment using the supervisor's acknowledged cut and independently
 * observed acceptances. Sequence ordering establishes the boundary; timestamps only scope capture.
 */
export function assessCancellationExperiment(input: unknown): CancellationCheck {
  const parsed = cancellationCaptureSchema.safeParse(input);
  if (!parsed.success)
    return check(input, 'INCOMPLETE', 'Required capture fields are missing or invalid.');
  const capture = parsed.data;
  const issue = captureIssue(capture);
  if (issue) return check(capture, 'INCOMPLETE', issue);
  if (!capture.cut)
    return check(
      capture,
      'INCOMPLETE',
      'The acknowledged revocation boundary is unavailable; cancellation status cannot replace it.',
      ['/cut', '/observation'],
    );
  const precondition = preconditionIssue(capture);
  if (precondition) return check(capture, 'INCOMPLETE', precondition, ['/attempts', '/cut']);

  const late = capture.effects.findIndex(
    (effect) =>
      effect.rootId === ROOT_TO_REVOKE && effect.acceptSequence > capture.cut!.ackSequence,
  );
  if (late >= 0)
    return check(
      capture,
      'FAIL',
      'A matching protected downstream acceptance occurred for the selected root after acknowledged revocation.',
      [
        '/cut',
        `/effects/${late}`,
        `/attempts/${capture.attempts.findIndex((attempt) => attemptKey(attempt) === attemptKey(capture.effects[late]!))}`,
      ],
    );

  if (capture.observation.status !== 'complete' || !capture.observation.windowClosed)
    return check(
      capture,
      'INCOMPLETE',
      'Absence of a late acceptance cannot pass without complete, closed capture of the finite experiment.',
      ['/observation', '/effects'],
    );

  if (capture.experimentId === 'independent-root') {
    const independent = capture.effects.findIndex((effect) => effect.rootId === INDEPENDENT_ROOT);
    if (independent < 0)
      return check(
        capture,
        'FAIL',
        'Independently authorized work did not reach the destination in the completed workload.',
        ['/attempts', '/cut', '/effects', '/observation'],
      );
    return check(
      capture,
      'PASS',
      'The retired root produced no post-cut acceptance while independently authorized work still reached the destination.',
      ['/cut', `/effects/${independent}`, '/attempts', '/observation'],
    );
  }
  if (capture.experimentId === 'accepted-before-revoke') {
    const prior = capture.effects.findIndex(
      (effect) =>
        effect.rootId === ROOT_TO_REVOKE && effect.acceptSequence < capture.cut!.ackSequence,
    );
    if (prior < 0)
      return check(
        capture,
        'FAIL',
        'The authorized pre-revocation request did not reach the destination in the completed workload.',
        ['/attempts', '/cut', '/effects', '/observation'],
      );
    return check(
      capture,
      'PASS',
      'The protected acceptance preceded revocation and is retained as completed work, not misclassified as a rollback failure.',
      [`/effects/${prior}`, '/cut', '/observation'],
    );
  }
  return check(
    capture,
    'PASS',
    'No new protected acceptance for the selected root was observed after its acknowledged revocation in the closed finite experiment.',
    ['/cut', '/attempts', '/effects', '/observation'],
  );
}

/** Positive utility can be observed even when the same experiment also exposes a retired-root effect. */
export function independentWorkObserved(input: unknown): boolean {
  const parsed = cancellationCaptureSchema.safeParse(input);
  if (!parsed.success) return false;
  const capture = parsed.data;
  if (
    capture.experimentId !== 'independent-root' ||
    !capture.cut ||
    captureIssue(capture) ||
    preconditionIssue(capture) ||
    capture.observation.status !== 'complete' ||
    !capture.observation.windowClosed
  )
    return false;
  return capture.effects.some(
    (effect) =>
      effect.rootId === INDEPENDENT_ROOT && effect.acceptSequence > capture.cut!.ackSequence,
  );
}

export function assessCancellationExperiments(input: readonly unknown[]): CancellationAssessment {
  const captures =
    Array.isArray(input) && input.length <= CANCELLATION_EXPERIMENT_IDS.length ? input : [];
  const checks = captures.map(assessCancellationExperiment);
  const parsed = captures.map((capture) => cancellationCaptureSchema.safeParse(capture));
  const valid = parsed.flatMap((capture) => (capture.success ? [capture.data] : []));
  const revisions = [...new Set(valid.map((capture) => capture.subjectRevision))];
  const ids = checks.flatMap((item) => (item.experimentId ? [item.experimentId] : []));
  const unique = new Set(ids).size === ids.length;
  const distinctRuns = new Set(valid.map((capture) => capture.runId)).size === valid.length;
  const missingExperiments = CANCELLATION_EXPERIMENT_IDS.filter((id) => !ids.includes(id));
  const coherent = revisions.length === 1 && unique && distinctRuns;
  return {
    profileId: CANCELLATION_PROFILE.id,
    scope: 'authored-loopback-workflow',
    subjectRevision: revisions.length === 1 ? revisions[0]! : null,
    verdict: !coherent
      ? 'insufficient_evidence'
      : checks.some((item) => item.status === 'FAIL')
        ? 'contradicted'
        : missingExperiments.length ||
            checks.length !== CANCELLATION_EXPERIMENT_IDS.length ||
            checks.some((item) => item.status !== 'PASS')
          ? 'insufficient_evidence'
          : 'supported',
    checks,
    missingExperiments,
    limitations: [
      'Findings concern only the selected work root, registered destination and finite authored experiments; no global idleness, rollback or business completion is established.',
      'A worker status is not a downstream effect. Sequence ordering is relative to the supervisor revocation-and-acceptance ledger, not a universal distributed clock.',
      'These supplied records do not independently authenticate their issuer or establish unobserved production paths.',
      ...(!coherent
        ? [
            'The experiment batch has missing or inconsistent subject identity, duplicate experiments, or reused run identities; its records cannot establish one scoped result.',
          ]
        : []),
    ],
  };
}
