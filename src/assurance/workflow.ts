import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { InvestigatorError } from '../core/errors.js';
import { jsonDigest, stableJson, type JsonValue } from '../core/json.js';
import { parseInput } from '../core/parse.js';
import { runEvidencePlanWorkflow } from '../evidence-plans/workflow.js';
import type { ModelProvider } from '../providers/model-provider.js';
import { applyEvidenceRecipe } from '../remediation/evidence-recipe.js';
import {
  copyEvidenceGapService,
  evidenceGapServiceSources,
  runEvidenceGapService,
} from '../targets/evidence-gap-service.js';
import { renderAssuranceHtml } from '../reports/assurance-html.js';
import {
  assuranceCheckpointSchema,
  createAssuranceCheckpoint,
  verifyAssuranceCheckpoint,
  type FixtureAssuranceState,
} from './checkpoint.js';
import {
  assuranceChangeReportSchema,
  createAssuranceChangeReport,
  supportsFixtureRetest,
  verifyAssuranceChangeReport,
  type AssuranceChangeReport,
} from './report.js';

export async function revalidateAuthoredCandidate(
  input: AssuranceChangeReport,
  signal?: AbortSignal,
): Promise<AssuranceChangeReport> {
  const report = verifyAssuranceChangeReport(input);
  if (!supportsFixtureRetest(report.checkpoint, report.candidate, report.investigation))
    throw new InvestigatorError(
      'ASSURANCE_RETEST_UNAVAILABLE',
      'Resolve the scope/profile or select the supported authored setting change before retesting.',
    );
  const directory = await mkdtemp(join(tmpdir(), 'investigator-revalidate-'));
  try {
    await copyEvidenceGapService(directory);
    await applyEvidenceRecipe(directory);
    const sources = await evidenceGapServiceSources(directory);
    if (stableJson({ ...sources }) !== stableJson(report.candidate.application))
      throw new InvestigatorError(
        'ASSURANCE_RETEST_UNAVAILABLE',
        'Only the unchanged shipped application with the supported producer can be retested.',
      );
    const run = await runEvidenceGapService({
      directory,
      authorization: report.candidate.authorization,
      ...(signal ? { signal } : {}),
    });
    return createAssuranceChangeReport(report.checkpoint, report.candidate, run);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const scenarioSchema = z
  .object({
    id: z.string().min(1).max(160),
    title: z.string().min(1).max(256),
    report: assuranceChangeReportSchema,
  })
  .strict();
export const assuranceDemoSchema = z
  .object({
    format: z.literal('investigator-assurance-demo-v1'),
    checkpoint: assuranceCheckpointSchema,
    cases: z.array(scenarioSchema).length(5),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type AssuranceDemo = z.infer<typeof assuranceDemoSchema>;

function buildDemoBody(checkpoint: AssuranceDemo['checkpoint'], cases: AssuranceDemo['cases']) {
  return { format: 'investigator-assurance-demo-v1' as const, checkpoint, cases };
}

export async function runAssuranceDemo(
  options: { readonly provider?: ModelProvider; readonly signal?: AbortSignal } = {},
): Promise<AssuranceDemo> {
  const checkpoint = createAssuranceCheckpoint(await runEvidencePlanWorkflow(options));
  const current = (): FixtureAssuranceState => ({
    ...structuredClone(checkpoint.state),
    capturedAt: new Date().toISOString(),
  });
  const candidate = current();
  candidate.authorization = 'unsafe';
  const changed = await revalidateAuthoredCandidate(
    createAssuranceChangeReport(checkpoint, candidate),
    options.signal,
  );
  const tool = current();
  const tools = tool.toolsExport as { tools: { description: string }[] };
  tools.tools[0]!.description =
    'Export without an approval reference after an upstream tool update.';
  const unknown = current();
  (unknown.toolsExport as { tools: unknown[] }).tools.push({
    name: 'export_direct',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  });
  const policy = current();
  policy.policyContent += '\nChanged obligation: a different review policy now applies.\n';
  const notes = current();
  notes.operatorNotes += '\nAn unrelated documentation correction.\n';
  const cases = [
    {
      id: 'runtime-setting',
      title: 'A setting changes after a supported finding',
      report: changed,
    },
    {
      id: 'tool-definition',
      title: 'A tool contract changes; old tests cannot approve it',
      report: createAssuranceChangeReport(checkpoint, tool),
    },
    {
      id: 'unmapped-tool',
      title: 'A newly imported tool is missing from the dependency map',
      report: createAssuranceChangeReport(checkpoint, unknown),
    },
    {
      id: 'policy-change',
      title: 'A changed policy requires an explicit obligation review',
      report: createAssuranceChangeReport(checkpoint, policy),
    },
    {
      id: 'unrelated-document',
      title: 'An explicitly excluded document changes',
      report: createAssuranceChangeReport(checkpoint, notes),
    },
  ];
  const body = buildDemoBody(checkpoint, cases);
  return verifyAssuranceDemo({ ...body, digest: jsonDigest(body as unknown as JsonValue) });
}

export function verifyAssuranceDemo(input: unknown): AssuranceDemo {
  const demo = parseInput(
    assuranceDemoSchema,
    input,
    'INVALID_ASSURANCE_DEMO',
    'Change investigation demonstration',
  );
  verifyAssuranceCheckpoint(demo.checkpoint);
  const ids = [
    'runtime-setting',
    'tool-definition',
    'unmapped-tool',
    'policy-change',
    'unrelated-document',
  ];
  if (
    new Set(demo.cases.map((item) => item.id)).size !== ids.length ||
    ids.some((id) => !demo.cases.some((item) => item.id === id))
  )
    throw new InvestigatorError(
      'INVALID_ASSURANCE_DEMO',
      'The declared comparison cases are incomplete.',
    );
  for (const item of demo.cases) {
    const report = verifyAssuranceChangeReport(item.report);
    if (report.checkpoint.digest !== demo.checkpoint.digest)
      throw new InvestigatorError(
        'INVALID_ASSURANCE_DEMO',
        'All cases must preserve the same historical checkpoint.',
      );
  }
  const runtime = demo.cases.find((item) => item.id === 'runtime-setting')!.report;
  const tool = demo.cases.find((item) => item.id === 'tool-definition')!.report;
  const unknown = demo.cases.find((item) => item.id === 'unmapped-tool')!.report;
  const policy = demo.cases.find((item) => item.id === 'policy-change')!.report;
  const notes = demo.cases.find((item) => item.id === 'unrelated-document')!.report;
  if (
    demo.checkpoint.evidencePlan.assessments.safeAfter.verdict !== 'supported' ||
    runtime.retestStatus !== 'completed' ||
    runtime.retest?.assessment.verdict !== 'contradicted' ||
    !runtime.investigation.changes.some(
      (change) =>
        change.dependencyId === 'authorization-binding' && change.disposition === 'retest',
    ) ||
    !tool.investigation.retestPlan.profileReviewRequired ||
    tool.retest !== null ||
    !tool.investigation.changes.some(
      (change) =>
        change.after?.kind === 'tool-definition' && change.disposition === 'profile-review',
    ) ||
    !policy.investigation.changes.some(
      (change) => change.after?.kind === 'policy' && change.disposition === 'profile-review',
    ) ||
    policy.retest !== null ||
    !unknown.investigation.changes.some(
      (change) => change.change === 'added' && change.after?.kind === 'tool-definition',
    ) ||
    !unknown.investigation.checks.every((check) => check.validity === 'unknown') ||
    unknown.retest !== null ||
    !notes.investigation.changes.some((change) => change.disposition === 'out-of-declared-scope') ||
    !notes.investigation.checks.every(
      (check) => check.validity === 'unchanged-recorded-dependencies',
    )
  )
    throw new InvestigatorError(
      'INVALID_ASSURANCE_DEMO',
      'The named cases do not establish their advertised change, review and retest outcomes.',
    );
  const body = buildDemoBody(demo.checkpoint, demo.cases);
  if (demo.digest !== jsonDigest(body as unknown as JsonValue))
    throw new InvestigatorError(
      'INVALID_ASSURANCE_DEMO',
      'The demonstration commitment does not match its cases.',
    );
  return demo;
}

export async function writeAssuranceBundle(
  directory: string,
  input: AssuranceChangeReport,
): Promise<void> {
  const report = verifyAssuranceChangeReport(input);
  await writeNewBundle(directory, {
    'change.json': `${JSON.stringify(report, null, 2)}\n`,
    'candidate-inventory.json': `${JSON.stringify(report.inventory, null, 2)}\n`,
    'report.html': renderAssuranceHtml(report),
  });
}

export async function writeAssuranceDemo(directory: string, input: AssuranceDemo): Promise<void> {
  const demo = verifyAssuranceDemo(input);
  const files: Record<string, string> = {
    'demo.json': `${JSON.stringify(demo, null, 2)}\n`,
    'checkpoint.json': `${JSON.stringify(demo.checkpoint, null, 2)}\n`,
    'candidate-state.json': `${JSON.stringify(demo.cases[0]!.report.candidate, null, 2)}\n`,
  };
  for (const item of demo.cases) {
    files[`${item.id}.json`] = `${JSON.stringify(item.report, null, 2)}\n`;
    files[`${item.id}.html`] = renderAssuranceHtml(item.report);
  }
  await writeNewBundle(directory, files);
}

async function writeNewBundle(directory: string, files: Record<string, string>): Promise<void> {
  await mkdir(directory, { mode: 0o700 }).catch(() => {
    throw new InvestigatorError(
      'OUTPUT_UNAVAILABLE',
      'Choose an available new change-investigation output directory.',
    );
  });
  try {
    for (const [name, content] of Object.entries(files))
      await writeFile(join(directory, name), content, {
        flag: 'wx',
        encoding: 'utf8',
        mode: 0o600,
      });
  } catch {
    await rm(directory, { recursive: true, force: true });
    throw new InvestigatorError(
      'OUTPUT_UNAVAILABLE',
      'The change-investigation bundle could not be written.',
    );
  }
}
