import { describe, expect, it } from 'vitest';
import {
  CANCELLATION_EXPERIMENT_IDS,
  INDEPENDENT_ROOT,
  ROOT_TO_REVOKE,
  cancellationAssessmentSchema,
  type CancellationAttempt,
  type CancellationCapture,
  type CancellationExperimentId,
} from '../src/cancellation/schemas.js';
import {
  assessCancellationExperiment,
  assessCancellationExperiments,
  independentWorkObserved,
} from '../src/cancellation/assessment.js';

const startedAt = '2026-11-02T10:00:00.000Z';
const observedAt = '2026-11-02T10:00:00.500Z';
const finishedAt = '2026-11-02T10:00:01.000Z';
const digest = 'a'.repeat(64);

function attempt(
  rootId = ROOT_TO_REVOKE,
  jobId = 'job:primary',
  attemptId = 'attempt:initial',
  enqueueSequence = 1,
  dispatchSequence = 3,
): CancellationAttempt {
  return { rootId, jobId, attemptId, requestDigest: digest, enqueueSequence, dispatchSequence };
}

function fixture(
  experimentId: CancellationExperimentId = 'queued-after-revoke',
): CancellationCapture {
  const capture: CancellationCapture = {
    schemaVersion: 1,
    experimentId,
    runId: `run:${experimentId}`,
    subjectRevision: 'b'.repeat(64),
    startedAt,
    finishedAt,
    scope: 'authored-loopback-workflow',
    observation: { status: 'complete', windowClosed: true, limitations: [] },
    cut: { rootId: ROOT_TO_REVOKE, ackSequence: 2, observedAt },
    attempts: [attempt()],
    effects: [],
    workerClaims: [{ rootId: ROOT_TO_REVOKE, jobId: 'job:primary', state: 'cancelled' }],
  };
  if (experimentId === 'retry-after-revoke')
    capture.attempts.push(attempt(ROOT_TO_REVOKE, 'job:primary', 'attempt:retry', 1, 4));
  if (experimentId === 'independent-root') {
    capture.cut!.ackSequence = 3;
    capture.attempts = [
      attempt(ROOT_TO_REVOKE, 'job:primary', 'attempt:initial', 1, 4),
      attempt(INDEPENDENT_ROOT, 'job:independent', 'attempt:independent', 2, 5),
    ];
    capture.effects = [
      {
        rootId: INDEPENDENT_ROOT,
        jobId: 'job:independent',
        attemptId: 'attempt:independent',
        requestDigest: digest,
        acceptSequence: 6,
        observedAt,
      },
    ];
  }
  if (experimentId === 'accepted-before-revoke') {
    capture.cut!.ackSequence = 4;
    capture.attempts = [attempt(ROOT_TO_REVOKE, 'job:primary', 'attempt:initial', 1, 2)];
    capture.effects = [
      {
        rootId: ROOT_TO_REVOKE,
        jobId: 'job:primary',
        attemptId: 'attempt:initial',
        requestDigest: digest,
        acceptSequence: 3,
        observedAt,
      },
    ];
  }
  return capture;
}

function addLateAcceptance(capture: CancellationCapture): void {
  const selected = capture.attempts.find((value) => value.rootId === ROOT_TO_REVOKE)!;
  const acceptSequence =
    Math.max(
      capture.cut!.ackSequence,
      ...capture.attempts.map((value) => value.dispatchSequence),
      ...capture.effects.map((value) => value.acceptSequence),
    ) + 1;
  capture.effects.push({
    rootId: selected.rootId,
    jobId: selected.jobId,
    attemptId: selected.attemptId,
    requestDigest: selected.requestDigest,
    acceptSequence,
    observedAt,
  });
}

describe('acknowledged work-revocation evidence', () => {
  it.each(CANCELLATION_EXPERIMENT_IDS)(
    'passes %s only with its actual recorded preconditions and closed scope',
    (id) => {
      expect(assessCancellationExperiment(fixture(id))).toMatchObject({
        experimentId: id,
        status: 'PASS',
      });
    },
  );

  it('uses independent acceptance ordering rather than a cancelled worker status', () => {
    const capture = fixture();
    addLateAcceptance(capture);
    const result = assessCancellationExperiment(capture);
    expect(result.status).toBe('FAIL');
    expect(result.witnessPointers).toContain('/effects/0');
    expect(result.witnessPointers).toContain('/cut');
    expect(capture.workerClaims[0]!.state).toBe('cancelled');
  });

  it('retains a concrete post-cut counterexample despite otherwise partial capture', () => {
    const capture = fixture();
    addLateAcceptance(capture);
    capture.observation = {
      status: 'partial',
      windowClosed: false,
      limitations: ['Another source was unavailable.'],
    };
    expect(assessCancellationExperiment(capture).status).toBe('FAIL');
  });

  it('cannot infer the acknowledgment from a worker response or source code', () => {
    const capture = fixture();
    addLateAcceptance(capture);
    capture.cut = null;
    capture.observation = {
      status: 'partial',
      windowClosed: true,
      limitations: ['Revocation acknowledgment was not captured.'],
    };
    expect(assessCancellationExperiment(capture)).toMatchObject({
      status: 'INCOMPLETE',
      witnessPointers: ['/cut', '/observation'],
    });
  });

  it('cannot pass absence from partial or unclosed capture', () => {
    const partial = fixture();
    partial.observation.status = 'partial';
    const open = fixture();
    open.observation.windowClosed = false;
    expect(assessCancellationExperiment(partial).status).toBe('INCOMPLETE');
    expect(assessCancellationExperiment(open).status).toBe('INCOMPLETE');
  });

  it('does not use wall-clock timestamps to decide which side of the cut accepted an effect', () => {
    const after = fixture();
    addLateAcceptance(after);
    after.effects[0]!.observedAt = '2026-11-02T10:00:00.100Z';
    expect(assessCancellationExperiment(after).status).toBe('FAIL');
    const before = fixture('accepted-before-revoke');
    before.effects[0]!.observedAt = '2026-11-02T10:00:00.900Z';
    expect(assessCancellationExperiment(before).status).toBe('PASS');
  });

  it('does not misclassify already accepted work as a rollback failure', () => {
    const capture = fixture('accepted-before-revoke');
    expect(assessCancellationExperiment(capture).status).toBe('PASS');
    capture.effects[0]!.acceptSequence = 5;
    expect(assessCancellationExperiment(capture).status).toBe('FAIL');
  });

  it('requires independently authorized work and pre-cut legitimate work to remain functional', () => {
    const independent = fixture('independent-root');
    independent.effects = [];
    const before = fixture('accepted-before-revoke');
    before.effects = [];
    expect(assessCancellationExperiment(independent).status).toBe('FAIL');
    expect(assessCancellationExperiment(before).status).toBe('FAIL');
  });

  it('retains positive independent utility even when the retired root also violates revocation', () => {
    const capture = fixture('independent-root');
    addLateAcceptance(capture);
    expect(assessCancellationExperiment(capture).status).toBe('FAIL');
    expect(independentWorkObserved(capture)).toBe(true);
    const blocked = fixture('independent-root');
    blocked.effects = [];
    expect(independentWorkObserved(blocked)).toBe(false);
    const mismatched = fixture('independent-root');
    mismatched.effects[0]!.requestDigest = 'c'.repeat(64);
    expect(independentWorkObserved(mismatched)).toBe(false);
    const partial = fixture('independent-root');
    partial.observation.status = 'partial';
    expect(independentWorkObserved(partial)).toBe(false);
  });

  it('qualifies job/attempt identity by root instead of joining same strings across roots', () => {
    const capture = fixture('independent-root');
    capture.attempts[1]!.jobId = capture.attempts[0]!.jobId;
    capture.attempts[1]!.attemptId = capture.attempts[0]!.attemptId;
    capture.effects[0]!.jobId = capture.attempts[1]!.jobId;
    capture.effects[0]!.attemptId = capture.attempts[1]!.attemptId;
    expect(assessCancellationExperiment(capture).status).toBe('PASS');
    capture.effects[0]!.rootId = ROOT_TO_REVOKE;
    expect(assessCancellationExperiment(capture).status).toBe('FAIL');
  });

  it.each([
    (capture: CancellationCapture) => {
      capture.cut!.rootId = INDEPENDENT_ROOT;
    },
    (capture: CancellationCapture) => {
      capture.cut!.ackSequence = capture.attempts[0]!.dispatchSequence;
    },
    (capture: CancellationCapture) => {
      capture.attempts[0]!.enqueueSequence = 3;
      capture.attempts[0]!.dispatchSequence = 4;
    },
    (capture: CancellationCapture) => {
      capture.finishedAt = '2026-11-02T09:00:00.000Z';
    },
    (capture: CancellationCapture) => {
      capture.cut!.observedAt = '2026-11-02T09:00:00.000Z';
    },
  ])('keeps invalid cut, timing or attempted-work preconditions unresolved', (mutate) => {
    const capture = fixture();
    mutate(capture);
    expect(assessCancellationExperiment(capture).status).toBe('INCOMPLETE');
  });

  it.each([
    (capture: CancellationCapture) => {
      capture.effects[0]!.requestDigest = 'c'.repeat(64);
    },
    (capture: CancellationCapture) => {
      capture.effects[0]!.jobId = 'other-job';
    },
    (capture: CancellationCapture) => {
      capture.effects[0]!.attemptId = 'other-attempt';
    },
    (capture: CancellationCapture) => {
      capture.effects[0]!.acceptSequence = 2;
    },
    (capture: CancellationCapture) => {
      capture.effects.push(structuredClone(capture.effects[0]!));
    },
    (capture: CancellationCapture) => {
      capture.effects[0]!.observedAt = '2027-01-01T00:00:00.000Z';
    },
  ])(
    'requires exact attempted request/receipt correlation and unique sequence evidence',
    (mutate) => {
      const capture = fixture();
      addLateAcceptance(capture);
      mutate(capture);
      expect(assessCancellationExperiment(capture).status).toBe('INCOMPLETE');
    },
  );

  it('requires distinct retry attempts rather than accepting a scenario label', () => {
    const capture = fixture('retry-after-revoke');
    capture.attempts[1]!.attemptId = capture.attempts[0]!.attemptId;
    expect(assessCancellationExperiment(capture).status).toBe('INCOMPLETE');
    const differentRequest = fixture('retry-after-revoke');
    differentRequest.attempts[1]!.requestDigest = 'c'.repeat(64);
    expect(assessCancellationExperiment(differentRequest).status).toBe('INCOMPLETE');
    const missing = fixture('retry-after-revoke');
    missing.attempts.pop();
    expect(assessCancellationExperiment(missing).status).toBe('INCOMPLETE');
  });

  it('keeps malformed or unknown experiments unresolved without fabricating an experiment identity', () => {
    expect(
      assessCancellationExperiment({ experimentId: 'injected', effects: 'pretend passed' }),
    ).toMatchObject({ experimentId: null, status: 'INCOMPLETE' });
    const capture = fixture() as unknown as Record<string, unknown>;
    delete capture['cut'];
    expect(assessCancellationExperiment(capture)).toMatchObject({
      experimentId: 'queued-after-revoke',
      status: 'INCOMPLETE',
    });
  });
});

describe('finite work-revocation assessment', () => {
  it('supports only the complete unique unchanged-subject experiment set', () => {
    expect(Object.isFrozen(CANCELLATION_EXPERIMENT_IDS)).toBe(true);
    const captures = CANCELLATION_EXPERIMENT_IDS.map(fixture);
    const assessment = assessCancellationExperiments(captures);
    expect(assessment.verdict).toBe('supported');
    expect(assessment.missingExperiments).toEqual([]);
    expect(cancellationAssessmentSchema.safeParse(assessment).success).toBe(true);
    expect(assessCancellationExperiments(captures.slice(1)).verdict).toBe('insufficient_evidence');
  });

  it('can establish a scoped counterexample even when other required experiments were not run', () => {
    const capture = fixture();
    addLateAcceptance(capture);
    const result = assessCancellationExperiments([capture]);
    expect(result.verdict).toBe('contradicted');
    expect(result.missingExperiments).toHaveLength(3);
    expect(result.subjectRevision).toBe(capture.subjectRevision);
  });

  it('never merges different target revisions, duplicate experiments or reused capture sessions into support', () => {
    const changed = CANCELLATION_EXPERIMENT_IDS.map(fixture);
    changed[0]!.subjectRevision = 'c'.repeat(64);
    expect(assessCancellationExperiments(changed)).toMatchObject({
      verdict: 'insufficient_evidence',
      subjectRevision: null,
    });
    const duplicate = CANCELLATION_EXPERIMENT_IDS.map(fixture);
    duplicate[1] = fixture();
    expect(assessCancellationExperiments(duplicate).verdict).toBe('insufficient_evidence');
    const reused = CANCELLATION_EXPERIMENT_IDS.map(fixture);
    reused[1]!.runId = reused[0]!.runId;
    expect(assessCancellationExperiments(reused).verdict).toBe('insufficient_evidence');
  });

  it('rejects oversized/non-array batches and does not promote cancellation claims to findings', () => {
    expect(assessCancellationExperiments(Array.from({ length: 5 }, () => fixture())).verdict).toBe(
      'insufficient_evidence',
    );
    expect(assessCancellationExperiments(null as unknown as unknown[]).verdict).toBe(
      'insufficient_evidence',
    );
    const all = CANCELLATION_EXPERIMENT_IDS.map(fixture);
    all[0]!.cut = null;
    expect(assessCancellationExperiments(all).verdict).toBe('insufficient_evidence');
  });
});
