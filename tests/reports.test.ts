import { access, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { investigate } from '../src/core/coordinator.js';
import { EvidenceStore } from '../src/core/evidence-store.js';
import { jsonDigest, sha256 } from '../src/core/json.js';
import { parseInput } from '../src/core/parse.js';
import { jsonValueSchema } from '../src/core/schemas.js';
import { ScriptedReferenceProvider } from '../src/providers/scripted-reference.js';
import type { ModelProvider } from '../src/providers/model-provider.js';
import {
  checkCaseFreshness,
  createCaseReport,
  readCaseReport,
  verifyCaseReport,
  writeCaseReport,
} from '../src/reports/case-report.js';
import { referenceCase, temporaryCase } from './helpers.js';

async function reportFixture() {
  const fixture = await temporaryCase();
  const { loadLocalCase } = await import('../src/connectors/local-bundle.js');
  const bundle = await loadLocalCase(fixture.directory);
  const run = await investigate({ ...bundle, provider: new ScriptedReferenceProvider() });
  return { ...fixture, report: createCaseReport(bundle.controlCase, bundle.evidence, run) };
}

describe('portable case reports', () => {
  it('rejects contradictory observations even when the final assessment is incomplete', async () => {
    const bundle = await referenceCase('unavailable');
    const run = await investigate({ ...bundle, provider: new ScriptedReferenceProvider() });
    const checks = run.checks.map((check, index) =>
      index === 0 ? { ...check, status: 'PASS' as const } : check,
    );
    const content = JSON.stringify(checks);
    const evidence = new EvidenceStore(
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
    expect(() => createCaseReport(bundle.controlCase, evidence, { ...run, checks })).toThrow(
      'recorded observations',
    );
  });
  it('round-trips without trusting a platform or implying independently trusted authorship', async () => {
    const fixture = await reportFixture();
    try {
      const path = join(fixture.directory, 'report.json');
      await writeCaseReport(path, fixture.report);
      const report = await readCaseReport(path);
      expect(report.run.finding?.verdict).toBe('contradicted');
      expect(report.integrity.trust).toBe('supplied-manifest-only');
      expect(report.run.provider.mode).toBe('scripted');
      expect(report.run.events.some((event) => event.role === 'skeptic')).toBe(true);
    } finally {
      await rm(fixture.directory, { recursive: true });
    }
  });

  it('refuses to overwrite an existing output', async () => {
    const fixture = await reportFixture();
    try {
      const path = join(fixture.directory, 'report.json');
      await writeFile(path, 'client-owned-content');
      await expect(writeCaseReport(path, fixture.report)).rejects.toMatchObject({
        code: 'OUTPUT_EXISTS',
      });
      expect(await readFile(path, 'utf8')).toBe('client-owned-content');
    } finally {
      await rm(fixture.directory, { recursive: true });
    }
  });

  it('detects changed artifacts against the supplied manifest', async () => {
    const fixture = await reportFixture();
    try {
      const changed = structuredClone(fixture.report);
      changed.evidence[0]!.content = 'Replaced source';
      expect(() => verifyCaseReport(changed)).toThrow(/manifest/);
      // Even recomputing the outer manifest cannot hide a mismatched artifact digest.
      const { integrity: _integrity, ...payload } = changed;
      changed.integrity.digest = jsonDigest(
        parseInput(jsonValueSchema, payload, 'TEST', 'Payload'),
      );
      expect(() => verifyCaseReport(changed)).toThrow(/digest/);
    } finally {
      await rm(fixture.directory, { recursive: true });
    }
  });

  it('marks only changed declared inputs stale and preserves the historical report', async () => {
    const fixture = await reportFixture();
    try {
      expect(await checkCaseFreshness(fixture.report, fixture.directory)).toBe(
        'current-for-declared-inputs',
      );
      await writeFile(join(fixture.directory, 'unrelated.txt'), 'unrelated');
      expect(await checkCaseFreshness(fixture.report, fixture.directory)).toBe(
        'current-for-declared-inputs',
      );
      await writeFile(join(fixture.directory, 'policy.md'), 'A changed policy.');
      expect(await checkCaseFreshness(fixture.report, fixture.directory)).toBe('stale');
      expect(verifyCaseReport(fixture.report).run.finding?.verdict).toBe('contradicted');
    } finally {
      await rm(fixture.directory, { recursive: true });
    }
  });

  it('rejects mixing a completed run with another target variant or input capture', async () => {
    const fixture = await reportFixture();
    try {
      const changed = structuredClone(fixture.report);
      changed.controlCase.referenceTarget!.variant = 'request-bound';
      const { integrity: _integrity, ...payload } = changed;
      changed.integrity.digest = jsonDigest(
        parseInput(jsonValueSchema, payload, 'TEST', 'Payload'),
      );
      expect(() => verifyCaseReport(changed)).toThrow(/scope frozen/);
      const changedCapture = structuredClone(fixture.report);
      changedCapture.evidence[0]!.capturedAt = '2026-01-01T00:00:00.000Z';
      const { integrity: _other, ...otherPayload } = changedCapture;
      changedCapture.integrity.digest = jsonDigest(
        parseInput(jsonValueSchema, otherPayload, 'TEST', 'Payload'),
      );
      expect(() => verifyCaseReport(changedCapture)).toThrow(/scope frozen/);
    } finally {
      await rm(fixture.directory, { recursive: true });
    }
  });

  it('refuses an escaped report that could not be reopened within the portable byte limit', async () => {
    const fixture = await temporaryCase();
    try {
      const { loadLocalCase } = await import('../src/connectors/local-bundle.js');
      const bundle = await loadLocalCase(fixture.directory);
      const evidence = new EvidenceStore(
        bundle.evidence.all().map((artifact, index) => {
          const content =
            index === 0 ? '\u0001'.repeat(1_048_576) : JSON.stringify('\\'.repeat(524_280));
          return {
            ...artifact,
            content,
            sha256: sha256(content),
            byteLength: Buffer.byteLength(content),
          };
        }),
      );
      const provider: ModelProvider = {
        id: 'test',
        model: 'test',
        mode: 'scripted',
        complete: async () => ({
          text: JSON.stringify({
            verdict: 'insufficient_evidence',
            statement: 'No checks were run.',
            citations: [],
            missingEvidence: ['Run the required checks.'],
          }),
          toolCalls: [],
          state: [],
        }),
      };
      const run = await investigate({ controlCase: bundle.controlCase, evidence, provider });
      const report = createCaseReport(bundle.controlCase, evidence, run);
      const path = join(fixture.directory, 'oversized.json');
      await expect(writeCaseReport(path, report)).rejects.toMatchObject({
        code: 'REPORT_TOO_LARGE',
      });
      await expect(access(path)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(fixture.directory, { recursive: true });
    }
  });

  it.each(['completed-with-unknown', 'failed-with-finding', 'incomplete-with-conclusive'] as const)(
    'rejects the internally inconsistent %s state',
    async (variant) => {
      const fixture = await reportFixture();
      try {
        const changed = structuredClone(fixture.report);
        if (variant === 'completed-with-unknown')
          changed.run.finding!.verdict = 'insufficient_evidence';
        else if (variant === 'failed-with-finding') changed.run.status = 'failed';
        else changed.run.status = 'incomplete';
        expect(() => verifyCaseReport(changed)).toThrow(/invalid/);
      } finally {
        await rm(fixture.directory, { recursive: true });
      }
    },
  );
});
