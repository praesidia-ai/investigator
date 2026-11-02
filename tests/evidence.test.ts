import { rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadLocalCase } from '../src/connectors/local-bundle.js';
import { EvidenceStore } from '../src/core/evidence-store.js';
import { readLocator, validateCitations } from '../src/core/citations.js';
import { sha256 } from '../src/core/json.js';
import { controlCaseSchema, type EvidenceArtifact } from '../src/core/schemas.js';
import { referenceCase, temporaryCase } from './helpers.js';

function artifact(content: string): EvidenceArtifact {
  return {
    id: 'json-source',
    source: { kind: 'local-file', reference: 'source.json' },
    mediaType: 'application/json',
    capturedAt: '2026-10-31T10:00:00.000Z',
    content,
    sha256: sha256(content),
    byteLength: Buffer.byteLength(content),
    coverage: 'unknown',
    redacted: false,
  };
}

describe('evidence snapshots and citations', () => {
  it('hashes the original bytes and keeps snapshots immutable', async () => {
    const { evidence } = await referenceCase();
    const policy = evidence.get('policy');
    expect(policy.sha256).toBe(sha256(policy.content));
    expect(Object.isFrozen(policy)).toBe(true);
    expect(Object.isFrozen(policy.source)).toBe(true);
    expect(evidence.list()[0]).not.toHaveProperty('content');
  });

  it('rejects modified bytes and duplicate evidence identifiers', () => {
    const good = artifact('{"approved":true}');
    const store = new EvidenceStore([good]);
    expect(() => store.add(good)).toThrow(/unique/);
    expect(() => new EvidenceStore([{ ...good, content: '{"approved":false}' }])).toThrow(/digest/);
  });

  it('resolves RFC 6901 escaped fields and exact array indices', () => {
    const source = artifact('{"a/b":{"~field":["approved","denied"]}}');
    expect(readLocator(source, { kind: 'json-pointer', pointer: '/a~1b/~0field/0' })).toBe(
      '"approved"',
    );
    expect(() =>
      readLocator(source, { kind: 'json-pointer', pointer: '/a~1b/~0field/01' }),
    ).toThrow();
    expect(() => readLocator(source, { kind: 'json-pointer', pointer: '/a~2b' })).toThrow();
    expect(() => readLocator(source, { kind: 'json-pointer', pointer: '/toString' })).toThrow();
  });

  it('preserves reserved own JSON keys in exact quotations and pointers', () => {
    const source = artifact(
      '{"metadata":{"__proto__":{"instruction":"untrusted"},"constructor":"declared"}}',
    );
    expect(readLocator(source, { kind: 'json-pointer', pointer: '/metadata' })).toBe(
      '{"__proto__":{"instruction":"untrusted"},"constructor":"declared"}',
    );
    expect(
      readLocator(source, { kind: 'json-pointer', pointer: '/metadata/__proto__/instruction' }),
    ).toBe('"untrusted"');
    expect(() =>
      readLocator(source, { kind: 'json-pointer', pointer: '/metadata/toString' }),
    ).toThrow();
  });

  it('rejects forged citations and out-of-range locators', async () => {
    const { evidence } = await referenceCase();
    const source = evidence.get('policy');
    const locator = { kind: 'lines', start: 1, end: 1 } as const;
    validateCitations(
      [{ evidenceId: 'policy', locator, quote: readLocator(source, locator) }],
      evidence,
    );
    expect(() =>
      validateCitations(
        [{ evidenceId: 'policy', locator, quote: 'Approval is optional.' }],
        evidence,
      ),
    ).toThrow(/quotation/);
    expect(() => readLocator(source, { kind: 'lines', start: 2, end: 1 })).toThrow();
    expect(() => readLocator(source, { kind: 'lines', start: 1, end: 1000 })).toThrow();
    expect(() =>
      validateCitations([{ evidenceId: 'invented', locator, quote: 'x' }], evidence),
    ).toThrow();
  });
});

describe('local evidence boundary', () => {
  it('does not permit traversal, absolute paths or symlinks outside the case', async () => {
    const fixture = await temporaryCase();
    const other = await temporaryCase();
    try {
      for (const path of ['../policy.md', join(other.directory, 'policy.md')]) {
        fixture.manifest.sources[0]!.path = path;
        await fixture.save();
        await expect(loadLocalCase(fixture.directory)).rejects.toMatchObject({
          code: 'PATH_OUTSIDE_CASE',
        });
      }
      await symlink(join(other.directory, 'policy.md'), join(fixture.directory, 'outside.md'));
      fixture.manifest.sources[0]!.path = 'outside.md';
      await fixture.save();
      await expect(loadLocalCase(fixture.directory)).rejects.toMatchObject({
        code: 'PATH_OUTSIDE_CASE',
      });
    } finally {
      await rm(fixture.directory, { recursive: true });
      await rm(other.directory, { recursive: true });
    }
  });

  it('rejects oversized, malformed JSON and non-UTF-8 source files', async () => {
    const fixture = await temporaryCase();
    try {
      await writeFile(join(fixture.directory, 'policy.md'), Buffer.alloc(1_048_577, 65));
      await expect(loadLocalCase(fixture.directory)).rejects.toMatchObject({
        code: 'SOURCE_TOO_LARGE',
      });
      await writeFile(join(fixture.directory, 'policy.md'), Buffer.from([0xff]));
      await expect(loadLocalCase(fixture.directory)).rejects.toMatchObject({
        code: 'INVALID_ENCODING',
      });
      await writeFile(join(fixture.directory, 'policy.md'), 'Valid policy');
      await writeFile(join(fixture.directory, 'work-request.json'), '{broken');
      await expect(loadLocalCase(fixture.directory)).rejects.toMatchObject({
        code: 'INVALID_EVIDENCE',
      });
    } finally {
      await rm(fixture.directory, { recursive: true });
    }
  });

  it('refuses empty checks, duplicate source IDs and a reference target claiming production scope', async () => {
    const { controlCase } = await referenceCase();
    expect(controlCaseSchema.safeParse({ ...controlCase, requiredChecks: [] }).success).toBe(false);
    expect(
      controlCaseSchema.safeParse({
        ...controlCase,
        sources: [controlCase.sources[0], controlCase.sources[0]],
      }).success,
    ).toBe(false);
    expect(
      controlCaseSchema.safeParse({
        ...controlCase,
        subject: { ...controlCase.subject, environment: 'deployment-evidence' },
      }).success,
    ).toBe(false);
  });
});
