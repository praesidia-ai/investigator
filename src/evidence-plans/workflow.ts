import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadClientContext } from '../context/load.js';
import { readLocator } from '../core/citations.js';
import { InvestigatorError } from '../core/errors.js';
import type { ModelProvider } from '../providers/model-provider.js';
import { ScriptedEvidenceProvider } from '../providers/scripted-evidence.js';
import { applyEvidenceRecipe, LEGACY_EVIDENCE_PRODUCER } from '../remediation/evidence-recipe.js';
import {
  copyEvidenceGapService,
  evidenceGapServiceSources,
  runEvidenceGapService,
} from '../targets/evidence-gap-service.js';
import { renderEvidencePlanHtml } from '../reports/evidence-plan-html.js';
import { assessEvidenceCapture } from './gap-analysis.js';
import { investigateEvidenceGap, type EvidencePlanningRun } from './investigate.js';
import {
  deriveEvidencePlanValidation,
  verifyEvidencePlanReport,
  type EvidencePlanReport,
} from './report.js';
import {
  EXPORT_EVIDENCE_REQUIREMENTS,
  EXPORT_EVIDENCE_REQUIREMENTS_DIGEST,
} from './requirements.js';

export { evidencePlanReportSchema, verifyEvidencePlanReport } from './report.js';
export type { EvidencePlanReport } from './report.js';

/** End-to-end demonstration using selected client declarations and the shipped finite workload. */
export async function runEvidencePlanWorkflow(
  options: {
    readonly provider?: ModelProvider;
    readonly signal?: AbortSignal;
  } = {},
): Promise<EvidencePlanReport> {
  const bundle = await loadClientContext(
    fileURLToPath(new URL('../../examples/client-evidence-gap/', import.meta.url)),
  );
  const directory = await mkdtemp(join(tmpdir(), 'investigator-evidence-'));
  try {
    await copyEvidenceGapService(directory);
    const beforeSources = await evidenceGapServiceSources(directory);
    if (
      bundle.evidence.get('producer').content !== LEGACY_EVIDENCE_PRODUCER ||
      beforeSources['instrumentation.mjs'] !== LEGACY_EVIDENCE_PRODUCER
    )
      throw new InvestigatorError(
        'EVIDENCE_PREIMAGE_MISMATCH',
        'The selected client producer does not match the authored example.',
      );
    const run = (authorization: 'safe' | 'unsafe') =>
      runEvidenceGapService({
        directory,
        authorization,
        ...(options.signal ? { signal: options.signal } : {}),
      });
    const before = { safe: await run('safe'), unsafe: await run('unsafe') };
    const gaps = assessEvidenceCapture(before.safe).gaps;
    const locator = {
      kind: 'lines',
      start: 1,
      end: LEGACY_EVIDENCE_PRODUCER.trimEnd().split('\n').length,
    } as const;
    const defaultRequest = {
      action: 'instrument-authored-example' as const,
      gapIds: gaps.map((gap) => gap.id),
      sourceId: 'client-export',
      producerCitation: {
        evidenceId: 'producer',
        locator,
        quote: readLocator(bundle.evidence.get('producer'), locator),
      },
      fields: [...EXPORT_EVIDENCE_REQUIREMENTS.collectionFields],
      explanation:
        'The selected producer lacks the work/grant/request join. Apply the supported producer-only recipe and retain independent downstream receipts; do not collect raw customer content.',
    };
    const planning: EvidencePlanningRun = await investigateEvidenceGap({
      snapshot: bundle.snapshot,
      evidence: bundle.evidence,
      gapIds: gaps.map((gap) => gap.id),
      producerEvidenceId: 'producer',
      provider: options.provider ?? new ScriptedEvidenceProvider(defaultRequest),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (planning.request.action !== 'instrument-authored-example')
      throw new InvestigatorError(
        'EVIDENCE_CHANGE_PENDING',
        'The planner requested additional source access; no collection change was applied.',
      );
    const change = await applyEvidenceRecipe(directory);
    const afterSources = await evidenceGapServiceSources(directory);
    const after = { safe: await run('safe'), unsafe: await run('unsafe') };
    const inputs = { before, after, planning, evidence: bundle.evidence.all() };
    return verifyEvidencePlanReport({
      format: 'investigator-evidence-plan-v1',
      requirementsDigest: EXPORT_EVIDENCE_REQUIREMENTS_DIGEST,
      context: bundle.snapshot,
      ...inputs,
      application: { before: beforeSources, after: afterSources },
      change,
      ...deriveEvidencePlanValidation(inputs),
      limitations: [
        'Selected authored client declarations and four controlled attempts do not establish whole-company discovery or production compliance.',
        'Context relationships are supplied and cited; they are not autonomous discovery or authenticated truth.',
        'New capture does not resolve events before instrumentation existed. Evidence repair does not change authorization.',
        'Witness-removal checks test this declared schema and workload, not globally minimal telemetry or formal privacy. Digests and identifiers can be sensitive.',
        'Recorded report verification checks supplied consistency; it does not authenticate issuers or reexecute observations.',
        ...(planning.provider.mode === 'scripted'
          ? [
              'The model plan is an explicit deterministic demonstration, not measured live Meta reasoning.',
            ]
          : []),
      ],
      authenticity: 'not-established',
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function writeEvidencePlanBundle(
  directory: string,
  input: EvidencePlanReport,
): Promise<void> {
  const report = verifyEvidencePlanReport(input);
  await mkdir(directory, { mode: 0o700 }).catch(() => {
    throw new InvestigatorError(
      'OUTPUT_UNAVAILABLE',
      'Choose an available new evidence-plan output directory.',
    );
  });
  try {
    const files: Record<string, string> = {
      'evidence-plan.json': `${JSON.stringify(report, null, 2)}\n`,
      'context.json': `${JSON.stringify(report.context, null, 2)}\n`,
      'instrumentation.diff': report.change.diff,
      'report.html': renderEvidencePlanHtml(report),
    };
    for (const [name, content] of Object.entries(files))
      await writeFile(join(directory, name), content, {
        flag: 'wx',
        mode: 0o600,
        encoding: 'utf8',
      });
  } catch {
    await rm(directory, { recursive: true, force: true });
    throw new InvestigatorError(
      'OUTPUT_UNAVAILABLE',
      'The evidence-plan bundle could not be written.',
    );
  }
}
