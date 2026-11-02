import { writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { loadLocalCase } from '../connectors/local-bundle.js';
import type { InvestigationRun } from '../core/coordinator.js';
import { assessFinding, consistentObservations } from '../core/assessment.js';
import { controlCaseCommitment, inputEvidenceCommitment } from '../core/commitments.js';
import { controlResultReference } from '../core/control-target.js';
import { EvidenceStore } from '../core/evidence-store.js';
import { InvestigatorError } from '../core/errors.js';
import { jsonDigest } from '../core/json.js';
import { parseInput, parseJson } from '../core/parse.js';
import {
  checkResultSchema,
  controlCaseSchema,
  evidenceArtifactSchema,
  findingSchema,
  jsonValueSchema,
  type ControlCase,
} from '../core/schemas.js';
import { decodeUtf8, readBoundedFile } from '../io/read-file.js';
import { CONTROL_RESULT_EVIDENCE_ID, REFERENCE_RESULT_EVIDENCE_ID } from '../core/tools.js';

const eventSchema = z
  .object({
    sequence: z.number().int().positive(),
    role: z.enum(['investigator', 'skeptic']),
    kind: z.enum(['tool-result', 'assessment']),
    tool: z.string().optional(),
    callId: z.string().optional(),
    startedAt: z.iso.datetime().optional(),
    finishedAt: z.iso.datetime().optional(),
    inputDigest: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    result: jsonValueSchema,
  })
  .strict();
const runSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.uuid(),
    caseId: z.string().min(1),
    controlCaseDigest: z.string().regex(/^[a-f0-9]{64}$/),
    inputEvidenceDigest: z.string().regex(/^[a-f0-9]{64}$/),
    startedAt: z.iso.datetime(),
    finishedAt: z.iso.datetime(),
    provider: z
      .object({
        id: z.string(),
        model: z.string(),
        mode: z.enum(['live', 'scripted']),
        reasoningEffort: z.enum(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']).optional(),
      })
      .strict(),
    status: z.enum(['completed', 'incomplete', 'failed']),
    finding: findingSchema.nullable(),
    checks: z.array(checkResultSchema).max(32),
    events: z.array(eventSchema).max(130),
    usage: z
      .object({
        inputTokens: z.number().int().nonnegative().nullable(),
        outputTokens: z.number().int().nonnegative().nullable(),
        knownInputTokens: z.number().int().nonnegative().optional(),
        knownOutputTokens: z.number().int().nonnegative().optional(),
        complete: z.boolean().optional(),
      })
      .strict(),
    limitations: z.array(z.string()).max(64),
    error: z.object({ code: z.string(), message: z.string() }).strict().nullable(),
  })
  .strict()
  .superRefine((run, context) => {
    const complete =
      run.status === 'completed' &&
      run.finding !== null &&
      run.finding.verdict !== 'insufficient_evidence' &&
      run.error === null;
    const incomplete =
      run.status === 'incomplete' &&
      ((run.finding?.verdict === 'insufficient_evidence' && run.error === null) ||
        (run.finding === null && run.error !== null));
    const failed = run.status === 'failed' && run.finding === null && run.error !== null;
    if (!complete && !incomplete && !failed)
      context.addIssue({ code: 'custom', message: 'Run status, finding and error must agree' });
  });
const reportPayloadSchema = z
  .object({
    format: z.literal('investigator-case-v1'),
    controlCase: controlCaseSchema,
    evidence: z.array(evidenceArtifactSchema).min(1).max(65),
    run: runSchema,
  })
  .strict();
export const caseReportSchema = reportPayloadSchema.extend({
  integrity: z
    .object({
      algorithm: z.literal('sha256'),
      digest: z.string().regex(/^[a-f0-9]{64}$/),
      trust: z.literal('supplied-manifest-only'),
    })
    .strict(),
});
export type CaseReport = z.infer<typeof caseReportSchema>;
export const MAX_REPORT_BYTES = 8_388_608;

function payloadDigest(payload: z.infer<typeof reportPayloadSchema>): string {
  return jsonDigest(parseInput(jsonValueSchema, payload, 'INVALID_REPORT', 'Report payload'));
}

export function createCaseReport(
  controlCase: ControlCase,
  evidence: EvidenceStore,
  run: InvestigationRun,
): CaseReport {
  const payload = parseInput(
    reportPayloadSchema,
    { format: 'investigator-case-v1', controlCase, evidence: evidence.all(), run },
    'INVALID_REPORT',
    'Case report',
  );
  return verifyCaseReport({
    ...payload,
    integrity: {
      algorithm: 'sha256',
      digest: payloadDigest(payload),
      trust: 'supplied-manifest-only',
    },
  });
}

export function verifyCaseReport(input: unknown): CaseReport {
  const report = parseInput(caseReportSchema, input, 'INVALID_REPORT', 'Case report');
  const { integrity, ...payload } = report;
  if (payloadDigest(payload) !== integrity.digest)
    throw new InvestigatorError(
      'REPORT_CHANGED',
      'The report does not match its supplied integrity manifest.',
    );
  const evidence = new EvidenceStore(report.evidence);
  for (const source of report.controlCase.sources) {
    const artifact = evidence.get(source.id);
    if (
      artifact.source.kind !== 'local-file' ||
      artifact.source.reference !== source.path ||
      artifact.mediaType !== source.mediaType ||
      artifact.coverage !== source.coverage ||
      artifact.redacted !== source.redacted
    ) {
      throw new InvestigatorError(
        'INVALID_REPORT',
        'Evidence provenance does not match its case declaration.',
      );
    }
  }
  if (report.run.caseId !== report.controlCase.id)
    throw new InvestigatorError('INVALID_REPORT', 'The run is bound to a different control case.');
  if (
    report.run.controlCaseDigest !== controlCaseCommitment(report.controlCase) ||
    report.run.inputEvidenceDigest !== inputEvidenceCommitment(report.controlCase, evidence)
  )
    throw new InvestigatorError(
      'INVALID_REPORT',
      'The case or input evidence differs from the scope frozen for this run.',
    );
  const declaredIds = new Set(report.controlCase.sources.map((source) => source.id));
  if (
    report.evidence.some(
      (artifact) =>
        !declaredIds.has(artifact.id) &&
        artifact.id !== REFERENCE_RESULT_EVIDENCE_ID &&
        artifact.id !== CONTROL_RESULT_EVIDENCE_ID,
    )
  )
    throw new InvestigatorError(
      'INVALID_REPORT',
      'The report contains evidence outside its declared inputs and reference checks.',
    );
  if (report.run.status === 'completed' && (!report.run.finding || report.run.error))
    throw new InvestigatorError(
      'INVALID_REPORT',
      'A completed run must have a finding and no error.',
    );
  if (new Set(report.run.checks.map((check) => check.id)).size !== report.run.checks.length)
    throw new InvestigatorError('INVALID_REPORT', 'Check IDs must be unique.');
  if (report.run.checks.some((check) => !consistentObservations(check)))
    throw new InvestigatorError(
      'INVALID_REPORT',
      'Check statuses do not match their recorded observations.',
    );
  if (report.run.checks.length > 0) {
    const target = report.controlCase.referenceTarget;
    const external = report.controlCase.controlledTarget;
    const artifact = evidence.get(
      target ? REFERENCE_RESULT_EVIDENCE_ID : CONTROL_RESULT_EVIDENCE_ID,
    );
    const validTarget = target
      ? report.controlCase.subject.environment === 'reference-test' &&
        artifact.source.kind === 'reference-check' &&
        artifact.source.reference === `customer-export-reference:${target.variant}:v1`
      : external &&
        artifact.source.kind === 'controlled-check' &&
        artifact.source.reference === controlResultReference(report.controlCase);
    if (!validTarget)
      throw new InvestigatorError(
        'INVALID_REPORT',
        'Control-check provenance does not match the declared target.',
      );
    if (JSON.stringify(parseJson(artifact.content)) !== JSON.stringify(report.run.checks))
      throw new InvestigatorError(
        'INVALID_REPORT',
        'Check results differ from their evidence snapshot.',
      );
  }
  if (report.run.events.some((event, index) => event.sequence !== index + 1))
    throw new InvestigatorError('INVALID_REPORT', 'Run event sequences must be contiguous.');
  const assessments = report.run.events.filter((event) => event.kind === 'assessment');
  if (
    report.run.finding &&
    (assessments[0]?.role !== 'investigator' ||
      assessments.at(-1)?.role !== 'skeptic' ||
      assessments.length < 2)
  )
    throw new InvestigatorError(
      'INVALID_REPORT',
      'A final finding requires recorded investigator and skeptic assessments.',
    );
  if (
    report.run.finding &&
    JSON.stringify(assessments.at(-1)?.result) !== JSON.stringify(report.run.finding)
  )
    throw new InvestigatorError(
      'INVALID_REPORT',
      'The final finding differs from its recorded assessment.',
    );
  if (
    report.run.finding &&
    JSON.stringify(
      assessFinding(report.run.finding, report.controlCase, evidence, report.run.checks),
    ) !== JSON.stringify(report.run.finding)
  )
    throw new InvestigatorError(
      'INVALID_REPORT',
      'The finding exceeds its recorded checks or coverage.',
    );
  return report;
}

export function serializeCaseReport(report: CaseReport): string {
  verifyCaseReport(report);
  const text = `${JSON.stringify(report, null, 2)}\n`;
  if (Buffer.byteLength(text) > MAX_REPORT_BYTES)
    throw new InvestigatorError(
      'REPORT_TOO_LARGE',
      'The serialized report exceeds its portable size limit.',
    );
  return text;
}

export async function writeCaseReport(path: string, report: CaseReport): Promise<void> {
  const text = serializeCaseReport(report);
  try {
    await writeFile(path, text, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST')
      throw new InvestigatorError(
        'OUTPUT_EXISTS',
        'The output file already exists; choose a new path.',
      );
    throw new InvestigatorError('OUTPUT_UNAVAILABLE', 'The report could not be saved.');
  }
}

export async function readCaseReport(path: string): Promise<CaseReport> {
  const text = decodeUtf8(await readBoundedFile(path, MAX_REPORT_BYTES));
  return verifyCaseReport(parseJson(text, 'INVALID_REPORT'));
}

export async function checkCaseFreshness(
  report: CaseReport,
  directory: string,
): Promise<'current-for-declared-inputs' | 'stale'> {
  report = verifyCaseReport(report);
  const fresh = await loadLocalCase(directory);
  const oldCase = parseInput(jsonValueSchema, report.controlCase, 'INVALID_REPORT', 'Control case');
  const newCase = parseInput(jsonValueSchema, fresh.controlCase, 'INVALID_CASE', 'Control case');
  if (jsonDigest(oldCase) !== jsonDigest(newCase)) return 'stale';
  const previous = new EvidenceStore(report.evidence);
  return fresh.evidence
    .all()
    .every((artifact) => previous.get(artifact.id).sha256 === artifact.sha256)
    ? 'current-for-declared-inputs'
    : 'stale';
}
