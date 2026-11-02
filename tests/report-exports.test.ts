import { describe, expect, it } from 'vitest';
import { investigate } from '../src/core/coordinator.js';
import { EvidenceStore } from '../src/core/evidence-store.js';
import { InvestigatorError } from '../src/core/errors.js';
import { sha256 } from '../src/core/json.js';
import type { ReferenceVariant } from '../src/core/schemas.js';
import type { ModelProvider } from '../src/providers/model-provider.js';
import { ScriptedReferenceProvider } from '../src/providers/scripted-reference.js';
import { createCaseReport } from '../src/reports/case-report.js';
import { caseReportJsonSchema, renderJUnit } from '../src/reports/exports.js';
import { renderCaseHtml } from '../src/reports/html-report.js';
import { referenceCase } from './helpers.js';

async function fixture(variant: ReferenceVariant = 'request-unbound') {
  const bundle = await referenceCase(variant);
  const run = await investigate({ ...bundle, provider: new ScriptedReferenceProvider() });
  return createCaseReport(bundle.controlCase, bundle.evidence, run);
}

describe('portable report exports', () => {
  it('renders the validated case with distinct execution, verdict and trust boundaries', async () => {
    const report = await fixture();
    const html = renderCaseHtml(report);
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('Contradicted in declared scope');
    expect(html).toContain('Execution status');
    expect(html).toContain('>completed</strong>');
    expect(html).toContain('Not established');
    expect(html).toContain('supplied-manifest-only');
    expect(html).toContain('no live model reasoning');
    expect(html).toContain('Synthetic reference test');
    expect(html).toContain('Positive control · permitted work');
    expect(html).toContain('Negative control · prevent unauthorized effects');
    expect(html).toContain('JSON pointer /1/status');
    expect(html).toContain('href="#evidence-0"');
    expect(html).toContain("connect-src 'none'");
    expect(html).not.toMatch(/<script\b|<iframe\b|<img\b|<form\b|\sonclick=/i);
  });

  it('renders evidence, citations and metadata as inert escaped text', async () => {
    const bundle = await referenceCase();
    const attack =
      '</pre><script>alert("evidence")</script><img src="https://evil.test/"> & \'text\'';
    bundle.controlCase.subject.revision = attack;
    bundle.controlCase.workContext = {
      objective: attack,
      accountableParty: attack,
      parentWorkRef: attack,
    };
    const evidence = new EvidenceStore(
      bundle.evidence.all().map((artifact) =>
        artifact.id === 'policy'
          ? {
              ...artifact,
              content: attack,
              sha256: sha256(attack),
              byteLength: Buffer.byteLength(attack),
            }
          : artifact,
      ),
    );
    const run = await investigate({
      controlCase: bundle.controlCase,
      evidence,
      provider: new ScriptedReferenceProvider(),
    });
    const report = createCaseReport(bundle.controlCase, evidence, run);
    const html = renderCaseHtml(report);
    expect(html).toContain('&lt;/pre&gt;&lt;script&gt;alert(&quot;evidence&quot;)&lt;/script&gt;');
    expect(html).toContain('&amp; &#39;text&#39;');
    expect(html).not.toContain(attack);
    expect(html).not.toMatch(/<script\b|<img\b|href="https?:|src="https?:/i);
    const junit = renderJUnit(report);
    expect(junit).not.toContain('evil.test');
    expect(junit).not.toContain('evidence&quot;');
    expect(junit).not.toContain(report.evidence[1]!.content);
  });

  it('distinguishes control failures, execution success and unresolved checks in JUnit', async () => {
    const contradicted = renderJUnit(await fixture());
    expect(contradicted).toContain('tests="5" failures="2" errors="0" skipped="0"');
    expect(contradicted).toMatch(/name="claim-verdict"><failure/);
    expect(contradicted).toContain('name="investigation-execution"></testcase>');
    const supported = renderJUnit(await fixture('request-bound'));
    expect(supported).toContain('tests="5" failures="0" errors="0" skipped="0"');
    const unavailable = renderJUnit(await fixture('unavailable'));
    expect(unavailable).toContain('tests="5" failures="0" errors="3" skipped="2"');
    expect(unavailable).toMatch(/name="permitted-work"><error/);
    expect(unavailable).toMatch(/name="claim-verdict"><skipped/);
  });

  it('exports failed execution as an error and missing checks as skipped without leaking error text', async () => {
    const bundle = await referenceCase();
    const provider: ModelProvider = {
      id: 'failed-provider',
      model: 'failed-model',
      mode: 'live',
      complete: async () => {
        throw new InvestigatorError('TEST_FAILURE', 'private-evidence-marker <&>');
      },
    };
    const run = await investigate({ ...bundle, provider });
    const report = createCaseReport(bundle.controlCase, bundle.evidence, run);
    const junit = renderJUnit(report);
    expect(junit).toContain('tests="5" failures="0" errors="1" skipped="4"');
    expect(junit).toMatch(/name="investigation-execution"><error/);
    expect(junit).not.toContain('private-evidence-marker');
    expect(renderCaseHtml(report)).toContain('private-evidence-marker &lt;&amp;&gt;');
  });

  it('refuses tampered reports before either rendering projection', async () => {
    const report = await fixture();
    report.evidence[0]!.content = 'changed after verification';
    expect(() => renderCaseHtml(report)).toThrow(/manifest/);
    expect(() => renderJUnit(report)).toThrow(/manifest/);
  });

  it('generates a versioned strict JSON Schema and retains semantic verification limits', () => {
    const schema = caseReportJsonSchema();
    expect(schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(schema.$id).toBe('urn:praesidia:investigator:case-report:v1');
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(
      expect.arrayContaining(['format', 'controlCase', 'evidence', 'run', 'integrity']),
    );
    expect(schema.properties?.format).toMatchObject({ const: 'investigator-case-v1' });
    expect(schema.description).toContain('Structural schema only');
    expect(JSON.parse(JSON.stringify(schema))).toMatchObject({ type: 'object' });
  });
});
