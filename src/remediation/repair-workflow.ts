import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { loadLocalCase } from '../connectors/local-bundle.js';
import { investigate } from '../core/coordinator.js';
import { InvestigatorError } from '../core/errors.js';
import { EvidenceStore } from '../core/evidence-store.js';
import { jsonDigest, sha256, type JsonValue } from '../core/json.js';
import { parseInput } from '../core/parse.js';
import { jsonValueSchema, type CheckResult } from '../core/schemas.js';
import type { ModelProvider } from '../providers/model-provider.js';
import { ScriptedReferenceProvider } from '../providers/scripted-reference.js';
import {
  createCaseReport,
  caseReportSchema,
  serializeCaseReport,
  verifyCaseReport,
  type CaseReport,
} from '../reports/case-report.js';
import { renderCaseHtml } from '../reports/html-report.js';
import {
  copyExportService,
  exportServiceRevision,
  LocalExportServiceAdapter,
} from '../targets/local-export-service.js';

export interface RepairProposal {
  readonly recipe: 'bind-exact-request.v1';
  readonly file: 'authorization.mjs';
  readonly beforeDigest: string;
  readonly afterDigest: string;
  readonly diff: string;
}
export interface RepairResult {
  readonly format: 'investigator-repair-v1';
  readonly before: CaseReport;
  readonly change: RepairProposal;
  readonly after: CaseReport;
  readonly application: { readonly before: ApplicationSources; readonly after: ApplicationSources };
  readonly verification: {
    readonly unchangedExpectations: boolean;
    readonly expectationsDigest: string;
    readonly closedGap: boolean;
    readonly permittedWorkPreserved: boolean;
    readonly scope: 'isolated-authored-example';
  };
}
interface ApplicationSources {
  readonly 'authorization.mjs': string;
  readonly 'server.mjs': string;
}
const sourceSchema = z
  .object({
    'authorization.mjs': z.string().min(1).max(65_536),
    'server.mjs': z.string().min(1).max(65_536),
  })
  .strict();
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const repairSchema = z
  .object({
    format: z.literal('investigator-repair-v1'),
    before: caseReportSchema,
    after: caseReportSchema,
    application: z.object({ before: sourceSchema, after: sourceSchema }).strict(),
    change: z
      .object({
        recipe: z.literal('bind-exact-request.v1'),
        file: z.literal('authorization.mjs'),
        beforeDigest: digestSchema,
        afterDigest: digestSchema,
        diff: z.string().max(262_144),
      })
      .strict(),
    verification: z
      .object({
        unchangedExpectations: z.boolean(),
        expectationsDigest: digestSchema,
        closedGap: z.boolean(),
        permittedWorkPreserved: z.boolean(),
        scope: z.literal('isolated-authored-example'),
      })
      .strict(),
  })
  .strict();
const MARKER = 'return true; // INVESTIGATOR_REPAIR: exact-request-binding';
const REPLACEMENT =
  'return grant.requestDigest === requestDigest; // INVESTIGATOR_REPAIR: exact-request-binding';

function repairDiff(before: string, after: string): string {
  const original = before.trimEnd().split('\n');
  const revised = after.trimEnd().split('\n');
  return `--- a/authorization.mjs\n+++ b/authorization.mjs\n@@ -1,${original.length} +1,${revised.length} @@\n${original.map((line) => `-${line}`).join('\n')}\n${revised.map((line) => `+${line}`).join('\n')}\n`;
}
async function applicationSources(directory: string): Promise<ApplicationSources> {
  return {
    'authorization.mjs': await readFile(join(directory, 'authorization.mjs'), 'utf8'),
    'server.mjs': await readFile(join(directory, 'server.mjs'), 'utf8'),
  };
}

function expectations(checks: readonly CheckResult[]): string | null {
  if (
    checks.length !== 3 ||
    checks.some(
      (check) =>
        check.observations.length === 0 ||
        check.observations.some((observation) => {
          if (!observation || typeof observation !== 'object' || Array.isArray(observation))
            return true;
          return !observation['scenario'] || !observation['expectation'] || !observation['attempt'];
        }),
    )
  )
    return null;
  return jsonDigest(
    checks.map((check) => ({
      id: check.id,
      scenarios: check.observations.map((observation) => {
        const item = observation as Record<string, JsonValue>;
        if (!item.scenario || !item.expectation || !item.attempt)
          throw new InvestigatorError(
            'RETEST_INCOMPLETE',
            'The retest is missing a frozen scenario observation.',
          );
        return { scenario: item.scenario, attempt: item.attempt, expectation: item.expectation };
      }),
    })),
  );
}

export function verifyRepairResult(input: unknown): RepairResult {
  const result = parseInput(repairSchema, input, 'INVALID_REPAIR_REPORT', 'Repair report');
  const before = verifyCaseReport(result.before);
  const after = verifyCaseReport(result.after);
  const original = result.application.before['authorization.mjs'];
  const revised = result.application.after['authorization.mjs'];
  if (
    original.split(MARKER).length !== 2 ||
    revised !== original.replace(MARKER, REPLACEMENT) ||
    result.application.before['server.mjs'] !== result.application.after['server.mjs'] ||
    jsonDigest({ ...result.application.before }) !== before.controlCase.subject.revision ||
    jsonDigest({ ...result.application.after }) !== after.controlCase.subject.revision ||
    sha256(original) !== result.change.beforeDigest ||
    sha256(revised) !== result.change.afterDigest ||
    result.change.diff !== repairDiff(original, revised)
  )
    throw new InvestigatorError(
      'INVALID_REPAIR_REPORT',
      'The repair is not bound to the recorded source revisions and exact change.',
    );
  const originalExpectations = expectations(before.run.checks);
  if (!originalExpectations)
    throw new InvestigatorError(
      'INVALID_REPAIR_REPORT',
      'The original scenario expectations are incomplete.',
    );
  const unchanged =
    originalExpectations === expectations(after.run.checks) &&
    jsonDigest(before.controlCase.requiredChecks) ===
      jsonDigest(after.controlCase.requiredChecks) &&
    jsonDigest(before.controlCase.controlProfile as unknown as JsonValue) ===
      jsonDigest(after.controlCase.controlProfile as unknown as JsonValue) &&
    jsonDigest(before.controlCase.criterionEvidence ?? []) ===
      jsonDigest(after.controlCase.criterionEvidence ?? []) &&
    before.controlCase.claim === after.controlCase.claim &&
    before.controlCase.id === after.controlCase.id &&
    before.controlCase.subject.id === after.controlCase.subject.id &&
    before.controlCase.subject.environment === after.controlCase.subject.environment &&
    before.controlCase.assessmentMode === after.controlCase.assessmentMode &&
    jsonDigest(
      parseInput(
        jsonValueSchema,
        before.controlCase.controlledTarget ?? null,
        'INVALID_REPAIR_REPORT',
        'Original target',
      ),
    ) ===
      jsonDigest(
        parseInput(
          jsonValueSchema,
          after.controlCase.controlledTarget ?? null,
          'INVALID_REPAIR_REPORT',
          'Retested target',
        ),
      ) &&
    before.run.inputEvidenceDigest === after.run.inputEvidenceDigest;
  const closed =
    before.run.finding?.verdict === 'contradicted' &&
    before.run.checks.some(
      (check) => check.id === 'exact-request-binding' && check.status === 'FAIL',
    ) &&
    after.run.finding?.verdict === 'supported' &&
    after.run.checks.length === 3 &&
    after.run.checks.every((check) => check.status === 'PASS');
  const preserved = after.run.checks.some(
    (check) => check.id === 'permitted-work' && check.status === 'PASS',
  );
  if (
    result.format !== 'investigator-repair-v1' ||
    result.verification.expectationsDigest !== originalExpectations ||
    result.verification.unchangedExpectations !== unchanged ||
    result.verification.closedGap !== closed ||
    result.verification.permittedWorkPreserved !== preserved ||
    result.verification.scope !== 'isolated-authored-example'
  )
    throw new InvestigatorError(
      'INVALID_REPAIR_REPORT',
      'Repair assertions do not match their case reports.',
    );
  return result;
}

/** One supported repair recipe. It only changes an owned temporary copy of the bundled example. */
export async function runRepairWorkflow(
  options: {
    readonly providerFactory?: () => ModelProvider;
    readonly signal?: AbortSignal;
  } = {},
): Promise<RepairResult> {
  const directory = await mkdtemp(join(tmpdir(), 'investigator-export-'));
  try {
    await copyExportService(directory);
    const frozenInputs = await loadLocalCase(
      fileURLToPath(new URL('../../examples/customer-export/', import.meta.url)),
    );
    const run = async () => {
      const bundle = {
        controlCase: structuredClone(frozenInputs.controlCase),
        evidence: new EvidenceStore(frozenInputs.evidence.all()),
      };
      delete bundle.controlCase.referenceTarget;
      bundle.controlCase.controlledTarget = { kind: 'local-http-export', version: 1 };
      bundle.controlCase.id = 'external-customer-export';
      bundle.controlCase.subject = {
        id: 'isolated-export-service',
        environment: 'repository',
        revision: await exportServiceRevision(directory),
      };
      const result = await investigate({
        ...bundle,
        provider: options.providerFactory?.() ?? new ScriptedReferenceProvider(),
        checkAdapter: new LocalExportServiceAdapter(directory, bundle.controlCase.subject.revision),
        ...(options.signal ? { signal: options.signal } : {}),
      });
      return createCaseReport(bundle.controlCase, bundle.evidence, result);
    };
    const before = await run();
    const beforeSources = await applicationSources(directory);
    if (
      before.run.finding?.verdict !== 'contradicted' ||
      !expectations(before.run.checks) ||
      before.run.checks.some(
        (check) => check.status === 'ERROR' || check.status === 'INCOMPLETE',
      ) ||
      !before.run.checks.some(
        (check) => check.id === 'exact-request-binding' && check.status === 'FAIL',
      )
    )
      throw new InvestigatorError(
        'REPAIR_PREREQUISITE_FAILED',
        'The supported approval-binding defect was not established; no change was applied.',
      );
    options.signal?.throwIfAborted();
    const path = join(directory, 'authorization.mjs');
    const source = await readFile(path, 'utf8');
    const marker = MARKER;
    if (source.split(marker).length !== 2)
      throw new InvestigatorError(
        'REPAIR_PREIMAGE_MISMATCH',
        'The supported repair location is absent or ambiguous.',
      );
    const replacement = source.replace(marker, REPLACEMENT);
    const change: RepairProposal = {
      recipe: 'bind-exact-request.v1',
      file: 'authorization.mjs',
      beforeDigest: sha256(source),
      afterDigest: sha256(replacement),
      diff: repairDiff(source, replacement),
    };
    if (sha256(await readFile(path)) !== change.beforeDigest)
      throw new InvestigatorError(
        'REPAIR_PREIMAGE_MISMATCH',
        'The source changed after repair preparation.',
      );
    await writeFile(path, replacement, { encoding: 'utf8', mode: 0o600 });
    const after = await run();
    const result: RepairResult = {
      format: 'investigator-repair-v1',
      before,
      change,
      after,
      application: { before: beforeSources, after: await applicationSources(directory) },
      verification: {
        unchangedExpectations: expectations(before.run.checks) === expectations(after.run.checks),
        expectationsDigest: expectations(before.run.checks)!,
        closedGap:
          before.run.finding.verdict === 'contradicted' &&
          after.run.finding?.verdict === 'supported' &&
          after.run.checks.every((check) => check.status === 'PASS'),
        permittedWorkPreserved: after.run.checks.some(
          (check) => check.id === 'permitted-work' && check.status === 'PASS',
        ),
        scope: 'isolated-authored-example',
      },
    };
    return verifyRepairResult(result);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function writeRepairBundle(directory: string, result: RepairResult): Promise<void> {
  verifyRepairResult(result);
  try {
    await mkdir(directory, { mode: 0o700 });
  } catch {
    throw new InvestigatorError('OUTPUT_EXISTS', 'Choose a new repair report directory.');
  }
  for (const [name, content] of [
    ['before.json', serializeCaseReport(result.before)],
    ['after.json', serializeCaseReport(result.after)],
    ['before.html', renderCaseHtml(result.before)],
    ['after.html', renderCaseHtml(result.after)],
    ['repair.diff', result.change.diff],
    ['repair.json', `${JSON.stringify(result, null, 2)}\n`],
  ] as const)
    await writeFile(join(directory, name), content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
}
