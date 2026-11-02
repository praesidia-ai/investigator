import { describe, expect, it } from 'vitest';
import { assessFinding } from '../src/core/assessment.js';
import { CUSTOMER_EXPORT_APPROVAL_PROFILE } from '../src/core/control-profiles.js';
import { EvidenceStore } from '../src/core/evidence-store.js';
import { sha256 } from '../src/core/json.js';
import {
  controlCaseSchema,
  type Citation,
  type Finding,
  type ReferenceVariant,
} from '../src/core/schemas.js';
import { runApprovalControlChecks } from '../src/reference/approval-control.js';
import { referenceCase } from './helpers.js';

async function observedCase(variant: ReferenceVariant = 'request-bound') {
  const bundle = await referenceCase(variant);
  const checks = runApprovalControlChecks(variant);
  const content = JSON.stringify(checks, null, 2);
  bundle.evidence.add({
    id: 'reference-control-results',
    source: { kind: 'reference-check', reference: `customer-export-reference:${variant}:v1` },
    mediaType: 'application/json',
    capturedAt: '2026-11-01T10:00:00.000Z',
    sha256: sha256(content),
    byteLength: Buffer.byteLength(content),
    content,
    coverage: 'complete',
    redacted: false,
  });
  const citations: Citation[] = checks.map((check, index) => ({
    evidenceId: 'reference-control-results',
    locator: { kind: 'json-pointer', pointer: `/${index}/status` },
    quote: JSON.stringify(check.status),
  }));
  return { ...bundle, checks, citations };
}

function finding(verdict: Finding['verdict'], citations: Citation[]): Finding {
  return {
    verdict,
    statement: 'All production systems are legally compliant.',
    citations,
    missingEvidence: [],
  };
}

describe('versioned customer-export approval profile', () => {
  it('binds the exact canonical proposition and all three mandatory checks', async () => {
    const { controlCase } = await referenceCase();
    expect(controlCase.controlProfile).toEqual({
      id: CUSTOMER_EXPORT_APPROVAL_PROFILE.id,
      version: 1,
    });
    expect(controlCase.claim).toBe(CUSTOMER_EXPORT_APPROVAL_PROFILE.claim);
    expect(
      controlCaseSchema.safeParse({ ...controlCase, claim: 'All systems are compliant.' }).success,
    ).toBe(false);
    for (const omitted of CUSTOMER_EXPORT_APPROVAL_PROFILE.requiredChecks) {
      expect(
        controlCaseSchema.safeParse({
          ...controlCase,
          requiredChecks: controlCase.requiredChecks.filter((id) => id !== omitted),
        }).success,
      ).toBe(false);
    }
    expect(
      controlCaseSchema.safeParse({
        ...controlCase,
        controlProfile: { id: controlCase.controlProfile!.id, version: 2 },
      }).success,
    ).toBe(false);
  });

  it('cannot omit the permitted-work criterion to approve a block-everything target', async () => {
    const { controlCase } = await referenceCase('block-all');
    expect(
      controlCaseSchema.safeParse({
        ...controlCase,
        requiredChecks: ['independent-approval', 'exact-request-binding'],
        criterionEvidence: controlCase.criterionEvidence!.filter(
          (entry) => entry.checkId !== 'permitted-work',
        ),
      }).success,
    ).toBe(false);
  });

  it('requires explicit supported mode/profile for every executable target', async () => {
    const { controlCase } = await referenceCase();
    const noProfile = { ...controlCase };
    delete noProfile.controlProfile;
    expect(controlCaseSchema.safeParse(noProfile).success).toBe(false);
    expect(
      controlCaseSchema.safeParse({ ...controlCase, assessmentMode: 'documentary' }).success,
    ).toBe(false);
    expect(
      controlCaseSchema.safeParse({
        ...controlCase,
        controlledTarget: { kind: 'local-http-export', version: 1 },
      }).success,
    ).toBe(false);
  });

  it('requires distinct declared dependencies for every mandatory criterion', async () => {
    const { controlCase } = await referenceCase();
    expect(controlCaseSchema.safeParse({ ...controlCase, criterionEvidence: [] }).success).toBe(
      false,
    );
    expect(
      controlCaseSchema.safeParse({
        ...controlCase,
        criterionEvidence: controlCase.requiredChecks.map((checkId) => ({
          checkId,
          evidenceIds: ['undeclared-source'],
        })),
      }).success,
    ).toBe(false);
    expect(
      controlCaseSchema.safeParse({
        ...controlCase,
        criterionEvidence: controlCase.requiredChecks.map((checkId) => ({
          checkId,
          evidenceIds: ['policy', 'policy'],
        })),
      }).success,
    ).toBe(false);
  });

  it('cannot present an isolated application test as deployment evidence', async () => {
    const { controlCase } = await referenceCase();
    delete controlCase.referenceTarget;
    controlCase.controlledTarget = { kind: 'local-http-export', version: 1 };
    controlCase.subject.revision = 'a'.repeat(64);
    controlCase.subject.environment = 'deployment-evidence';
    expect(controlCaseSchema.safeParse(controlCase).success).toBe(false);
    controlCase.subject.environment = 'repository';
    expect(controlCaseSchema.safeParse(controlCase).success).toBe(true);
    controlCase.subject.revision = 'unbound-revision';
    expect(controlCaseSchema.safeParse(controlCase).success).toBe(false);
  });
});

describe('behavioral verdict prerequisites and scoped statements', () => {
  it.each(['repository', 'deployment-evidence'] as const)(
    'leaves policy-only %s behavior claims unresolved in every assessment mode',
    async (environment) => {
      const { controlCase, evidence } = await referenceCase();
      const policy = evidence.get('policy');
      const citations: Citation[] = [
        {
          evidenceId: 'policy',
          locator: { kind: 'lines', start: 1, end: 1 },
          quote: policy.content.split('\n')[0]!,
        },
      ];
      for (const assessmentMode of [
        'documentary',
        'recorded-behavior',
        'controlled-test',
      ] as const) {
        const candidate = {
          ...controlCase,
          assessmentMode,
          subject: { ...controlCase.subject, environment },
        };
        delete candidate.referenceTarget;
        const parsed = controlCaseSchema.parse(candidate);
        for (const verdict of ['supported', 'contradicted'] as const) {
          expect(assessFinding(finding(verdict, citations), parsed, evidence, []).verdict).toBe(
            'insufficient_evidence',
          );
        }
      }
    },
  );

  it('requires a citation to a failing observed criterion rather than just policy or a passing status', async () => {
    const bundle = await observedCase('request-unbound');
    const policy: Citation = {
      evidenceId: 'policy',
      locator: { kind: 'lines', start: 1, end: 1 },
      quote: bundle.evidence.get('policy').content.split('\n')[0]!,
    };
    for (const citations of [[policy], [bundle.citations[0]!]]) {
      expect(
        assessFinding(
          finding('contradicted', citations),
          bundle.controlCase,
          bundle.evidence,
          bundle.checks,
        ).verdict,
      ).toBe('insufficient_evidence');
    }
    const result = assessFinding(
      finding('contradicted', [bundle.citations[1]!]),
      bundle.controlCase,
      bundle.evidence,
      bundle.checks,
    );
    expect(result.verdict).toBe('contradicted');
    expect(result.statement).toContain('reference-test scope');
    expect(result.statement).toContain('not deployment-wide or legal compliance');
    expect(result.statement).not.toContain('All production systems');
  });

  it('requires an observed PASS citation for every required criterion', async () => {
    const bundle = await observedCase();
    expect(
      assessFinding(
        finding('supported', bundle.citations.slice(0, 1)),
        bundle.controlCase,
        bundle.evidence,
        bundle.checks,
      ).verdict,
    ).toBe('insufficient_evidence');
    expect(
      assessFinding(
        finding('supported', bundle.citations),
        bundle.controlCase,
        bundle.evidence,
        bundle.checks,
      ).verdict,
    ).toBe('supported');
  });

  it('accepts the same profile only for a matching external controlled-target revision', async () => {
    const bundle = await observedCase();
    const controlCase = {
      ...bundle.controlCase,
      controlledTarget: { kind: 'local-http-export' as const, version: 1 as const },
      subject: {
        ...bundle.controlCase.subject,
        environment: 'repository' as const,
        revision: 'a'.repeat(64),
      },
    };
    delete controlCase.referenceTarget;
    const evidence = new EvidenceStore(
      bundle.evidence.all().map((artifact) =>
        artifact.id === 'reference-control-results'
          ? {
              ...artifact,
              id: 'control-check-results',
              source: {
                kind: 'controlled-check' as const,
                reference: `local-http-export:v1:${controlCase.subject.revision}`,
              },
            }
          : artifact,
      ),
    );
    const citations = bundle.citations.map((citation) => ({
      ...citation,
      evidenceId: 'control-check-results',
    }));
    const result = assessFinding(
      finding('supported', citations),
      controlCaseSchema.parse(controlCase),
      evidence,
      bundle.checks,
    );
    expect(result.verdict).toBe('supported');
    expect(result.statement).toContain('repository scope');
    expect(
      assessFinding(
        finding('supported', citations),
        { ...controlCase, subject: { ...controlCase.subject, revision: 'b'.repeat(64) } },
        evidence,
        bundle.checks,
      ).verdict,
    ).toBe('insufficient_evidence');
  });

  it('does not invalidate passing criteria when an unrelated partial source is added', async () => {
    const bundle = await observedCase();
    const content = 'Optional and incomplete historical notes.';
    bundle.controlCase.sources.push({
      id: 'optional-notes',
      path: 'notes.txt',
      mediaType: 'text/plain',
      coverage: 'partial',
      redacted: true,
    });
    bundle.evidence.add({
      id: 'optional-notes',
      source: { kind: 'local-file', reference: 'notes.txt' },
      mediaType: 'text/plain',
      capturedAt: '2026-11-01T10:00:00.000Z',
      content,
      sha256: sha256(content),
      byteLength: Buffer.byteLength(content),
      coverage: 'partial',
      redacted: true,
    });
    const result = assessFinding(
      finding('supported', bundle.citations),
      controlCaseSchema.parse(bundle.controlCase),
      bundle.evidence,
      bundle.checks,
    );
    expect(result.verdict).toBe('supported');
  });

  it('keeps incomplete required input capture unresolved but retains a direct failure witness', async () => {
    for (const variant of ['request-bound', 'request-unbound'] as const) {
      const bundle = await observedCase(variant);
      const evidence = new EvidenceStore(
        bundle.evidence
          .all()
          .map((artifact) =>
            artifact.id === 'work-request'
              ? { ...artifact, coverage: 'partial' as const }
              : artifact,
          ),
      );
      const result = assessFinding(
        finding(variant === 'request-bound' ? 'supported' : 'contradicted', bundle.citations),
        bundle.controlCase,
        evidence,
        bundle.checks,
      );
      expect(result.verdict).toBe(
        variant === 'request-bound' ? 'insufficient_evidence' : 'contradicted',
      );
    }
  });

  it('refuses result snapshots from the wrong variant or fabricated aggregate observations', async () => {
    const bundle = await observedCase();
    const wrongVariant = new EvidenceStore(
      bundle.evidence.all().map((artifact) =>
        artifact.id === 'reference-control-results'
          ? {
              ...artifact,
              source: {
                ...artifact.source,
                reference: 'customer-export-reference:request-unbound:v1',
              },
            }
          : artifact,
      ),
    );
    expect(
      assessFinding(
        finding('supported', bundle.citations),
        bundle.controlCase,
        wrongVariant,
        bundle.checks,
      ).verdict,
    ).toBe('insufficient_evidence');
    const checks = bundle.checks.map((check) => ({ ...check, observations: [] }));
    const content = JSON.stringify(checks, null, 2);
    const noObservations = new EvidenceStore(
      bundle.evidence.all().map((artifact) =>
        artifact.id === 'reference-control-results'
          ? {
              ...artifact,
              content,
              sha256: sha256(content),
              byteLength: Buffer.byteLength(content),
            }
          : artifact,
      ),
    );
    expect(() =>
      assessFinding(
        finding('supported', bundle.citations),
        bundle.controlCase,
        noObservations,
        checks,
      ),
    ).toThrow(/saved observations/);
  });
});
