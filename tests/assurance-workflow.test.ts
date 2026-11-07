import { beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createAssuranceCheckpoint,
  inventoryFromFixtureState,
  verifyAssuranceCheckpoint,
} from '../src/assurance/checkpoint.js';
import {
  createAssuranceChangeReport,
  verifyAssuranceChangeReport,
} from '../src/assurance/report.js';
import {
  revalidateAuthoredCandidate,
  runAssuranceDemo,
  verifyAssuranceDemo,
  writeAssuranceDemo,
  type AssuranceDemo,
} from '../src/assurance/workflow.js';
import { runCli } from '../src/cli.js';
import { output } from './helpers.js';
import { jsonDigest, type JsonValue } from '../src/core/json.js';
import { loadMcpExport } from '../src/context/load-mcp.js';
import { renderAssuranceHtml } from '../src/reports/assurance-html.js';

let demo: AssuranceDemo;
beforeAll(async () => {
  demo = await runAssuranceDemo();
});
const example = fileURLToPath(new URL('../examples/mcp-export/', import.meta.url));

describe('recorded control evidence after client changes', () => {
  it('preserves history, identifies the affected checks and observes the changed unsafe outcome', () => {
    const runtime = demo.cases.find((item) => item.id === 'runtime-setting')!.report;
    expect(demo.checkpoint.evidencePlan.assessments.safeAfter.verdict).toBe('supported');
    expect(
      runtime.investigation.checks
        .filter((check) => check.validity === 'stale')
        .map((check) => check.id)
        .sort(),
    ).toEqual(['permitted', 'wrong-request']);
    expect(runtime.investigation.retestPlan.checkIds).toEqual(['permitted', 'wrong-request']);
    expect(
      runtime.investigation.checks.every(
        (check) => check.historicalVerdict === 'supported' && check.currentVerdict === null,
      ),
    ).toBe(true);
    expect(runtime.retestStatus).toBe('completed');
    expect(runtime.retest?.assessment.verdict).toBe('contradicted');
    expect(runtime.retest?.executedChecks).toEqual([
      'no-approval',
      'permitted',
      'self-approval',
      'wrong-request',
    ]);
    expect(
      runtime.retest?.run.scenarios.find((scenario) => scenario.id === 'wrong-request')?.effects,
    ).toHaveLength(1);
    expect(
      runtime.retest?.run.scenarios.find((scenario) => scenario.id === 'permitted')?.effects,
    ).toHaveLength(1);
    expect(verifyAssuranceDemo(JSON.parse(JSON.stringify(demo)))).toEqual(demo);
  });

  it('does not run yesterday’s checks as approval of changed policies or tool contracts', async () => {
    for (const id of ['policy-change', 'tool-definition']) {
      const report = demo.cases.find((item) => item.id === id)!.report;
      expect(report.investigation.retestPlan.profileReviewRequired).toBe(true);
      expect(report.retestStatus).toBe('blocked');
      expect(report.retest).toBeNull();
      await expect(revalidateAuthoredCandidate(report)).rejects.toMatchObject({
        code: 'ASSURANCE_RETEST_UNAVAILABLE',
      });
    }
  });

  it('blocks reuse for a tool missing from the frozen map and for unimported listing pages', () => {
    const report = demo.cases.find((item) => item.id === 'unmapped-tool')!.report;
    expect(report.investigation.checks.every((check) => check.validity === 'unknown')).toBe(true);
    expect(report.investigation.retestPlan.blocked).toBe(true);
    const candidate = structuredClone(demo.checkpoint.state);
    (candidate.toolsExport as Record<string, JsonValue>)['nextCursor'] = 'remaining-page';
    const page = createAssuranceChangeReport(demo.checkpoint, candidate);
    expect(page.inventory.coverage.status).toBe('partial');
    expect(page.investigation.checks.every((check) => check.validity === 'unknown')).toBe(true);
    expect(page.retest).toBeNull();
  });

  it('tolerates timestamp recapture and declared unrelated documents without renewing findings', () => {
    const candidate = structuredClone(demo.checkpoint.state);
    candidate.capturedAt = new Date(Date.parse(candidate.capturedAt) + 1).toISOString();
    const recaptured = createAssuranceChangeReport(demo.checkpoint, candidate);
    expect(recaptured.investigation.changes).toEqual([]);
    expect(recaptured.retestStatus).toBe('not-needed');
    expect(recaptured.investigation.checks.every((check) => check.currentVerdict === null)).toBe(
      true,
    );
    const unrelated = demo.cases.find((item) => item.id === 'unrelated-document')!.report;
    expect(unrelated.investigation.changes[0]?.disposition).toBe('out-of-declared-scope');
    expect(
      unrelated.investigation.checks.every(
        (check) => check.validity === 'unchanged-recorded-dependencies',
      ),
    ).toBe(true);
  });

  it('does not lose reserved JSON metadata keys through the candidate-state parser', () => {
    const first = structuredClone(demo.checkpoint.state);
    const second = structuredClone(demo.checkpoint.state);
    const toolsOne = first.toolsExport as { tools: { _meta?: JsonValue }[] };
    const toolsTwo = second.toolsExport as { tools: { _meta?: JsonValue }[] };
    toolsOne.tools[0]!._meta = JSON.parse('{"__proto__":{"instruction":"one"}}') as JsonValue;
    toolsTwo.tools[0]!._meta = JSON.parse('{"__proto__":{"instruction":"two"}}') as JsonValue;
    const dependency = (state: typeof first) =>
      inventoryFromFixtureState(state).dependencies.find(
        (item) => item.kind === 'tool-definition',
      )!;
    expect(dependency(first).fingerprint).not.toBe(dependency(second).fingerprint);
    const report = createAssuranceChangeReport(demo.checkpoint, first);
    expect(report.investigation.retestPlan.profileReviewRequired).toBe(true);
    expect(verifyAssuranceChangeReport(JSON.parse(JSON.stringify(report)))).toEqual(report);
    const corrupt = structuredClone(report);
    (corrupt.candidate.toolsExport as typeof toolsOne).tools[0]!._meta = toolsTwo.tools[0]!._meta;
    expect(() => verifyAssuranceChangeReport(corrupt)).toThrow();
  });

  it('rejects weakened checkpoints, forged comparisons and mismatched or premature retests', () => {
    const checkpoint = structuredClone(demo.checkpoint);
    checkpoint.contract.checks[0]!.dependencyIds = ['operator-notes'];
    expect(() => verifyAssuranceCheckpoint(checkpoint)).toThrow();
    const runtime = demo.cases[0]!.report;
    const wrongMode = structuredClone(runtime.retest!.run);
    wrongMode.authorization = 'safe';
    expect(() =>
      createAssuranceChangeReport(demo.checkpoint, runtime.candidate, wrongMode),
    ).toThrow(/candidate/);
    const future = structuredClone(runtime.candidate);
    future.capturedAt = '2099-01-01T00:00:00.000Z';
    expect(() => createAssuranceChangeReport(demo.checkpoint, future, runtime.retest!.run)).toThrow(
      /capture window/,
    );
    const fabricated = structuredClone(runtime);
    fabricated.investigation.checks[0]!.historicalVerdict = 'contradicted';
    expect(() => verifyAssuranceChangeReport(fabricated)).toThrow();
    const otherTenant = structuredClone(runtime.candidate);
    otherTenant.scope.tenantRef = 'other-tenant';
    expect(() => createAssuranceChangeReport(demo.checkpoint, otherTenant)).toThrow(/same tenant/);
  });

  it('verifies named demonstration outcomes instead of trusting case IDs', () => {
    const copy = structuredClone(demo);
    const unchanged = createAssuranceChangeReport(demo.checkpoint, demo.checkpoint.state);
    for (const item of copy.cases) item.report = structuredClone(unchanged);
    const { digest: _digest, ...body } = copy;
    copy.digest = jsonDigest(body as unknown as JsonValue);
    expect(() => verifyAssuranceDemo(copy)).toThrow(/advertised/);
    const top = structuredClone(demo);
    top.checkpoint.state.authorization = 'unsafe';
    expect(() => verifyAssuranceDemo(top)).toThrow(/checkpoint/);
  });

  it('exports complete local artifacts and keeps imported instructions inert', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'investigator-assurance-test-'));
    try {
      const destination = join(directory, 'demo');
      await writeAssuranceDemo(destination, demo);
      await expect(writeAssuranceDemo(destination, demo)).rejects.toMatchObject({
        code: 'OUTPUT_UNAVAILABLE',
      });
      expect(
        verifyAssuranceDemo(JSON.parse(await readFile(join(destination, 'demo.json'), 'utf8'))),
      ).toEqual(demo);
      const injection = structuredClone(demo.checkpoint.state);
      injection.coverage = { status: 'partial', frontier: ['<script>alert("unsafe")</script>'] };
      const html = renderAssuranceHtml(createAssuranceChangeReport(demo.checkpoint, injection));
      expect(html).toContain('&lt;script&gt;');
      expect(html).not.toContain('<script>');
      expect(html).toContain("default-src 'none'");
      const imported = await loadMcpExport(example);
      expect(imported.dependencies).toHaveLength(2);
      expect(imported.snapshot.context.sources[0]?.coverage).toBe('partial');
      const { stdout, stderr, io } = output();
      const evidencePath = join(directory, 'evidence.json');
      const checkpointPath = join(directory, 'checkpoint.json');
      const candidatePath = join(directory, 'candidate.json');
      await writeFile(evidencePath, JSON.stringify(demo.checkpoint.evidencePlan));
      await writeFile(candidatePath, JSON.stringify(demo.cases[0]!.report.candidate));
      expect(await runCli(['checkpoint', evidencePath, '--out', checkpointPath], {}, io)).toBe(0);
      expect(createAssuranceCheckpoint(JSON.parse(await readFile(evidencePath, 'utf8')))).toEqual(
        demo.checkpoint,
      );
      expect(
        await runCli(
          ['assurance-diff', checkpointPath, candidatePath, '--out', join(directory, 'diff')],
          {},
          io,
        ),
      ).toBe(1);
      expect(
        await runCli(['verify-assurance', join(destination, 'demo.json'), '--json'], {}, io),
      ).toBe(0);
      expect(JSON.parse(stdout.pop()!)).toMatchObject({
        authenticity: 'not-established',
        execution: 'not-reexecuted',
      });
      expect(await runCli(['import-mcp', example, '--json'], {}, io)).toBe(0);
      expect(JSON.parse(stdout.pop()!)).toMatchObject({ format: 'investigator-mcp-import-v1' });
      expect(await runCli(['assurance-demo', '--live'], {}, io)).toBe(2);
      expect(stderr.join('')).toContain('MODEL_KEY_REQUIRED');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
