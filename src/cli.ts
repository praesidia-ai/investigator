import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { writeFile } from 'node:fs/promises';
import { loadLocalCase } from './connectors/local-bundle.js';
import { investigate, type InvestigationRun } from './core/coordinator.js';
import { InvestigatorError, publicError } from './core/errors.js';
import { parseInput } from './core/parse.js';
import { referenceVariantSchema } from './core/schemas.js';
import { createMetaProvider, diagnoseMeta } from './providers/meta-config.js';
import { loadHttpApprovalTarget } from './targets/http-approval-target.js';
import { initializeControlCase } from './connectors/init-case.js';
import { ScriptedReferenceProvider } from './providers/scripted-reference.js';
import { renderCaseHtml } from './reports/html-report.js';
import { caseReportJsonSchema, renderJUnit } from './reports/exports.js';
import {
  runRepairWorkflow,
  verifyRepairResult,
  writeRepairBundle,
} from './remediation/repair-workflow.js';
import { decodeUtf8, readBoundedFile } from './io/read-file.js';
import { parseJson } from './core/parse.js';
import { evaluateInvestigator } from './evaluation/evaluate.js';
import { loadClientContext } from './context/load.js';
import { runAssuranceCli } from './assurance/cli.js';
import { runCancellationCli } from './cancellation/cli.js';
import { runInteropCli } from './interop/cli.js';
import {
  runEvidencePlanWorkflow,
  verifyEvidencePlanReport,
  writeEvidencePlanBundle,
} from './evidence-plans/workflow.js';
import {
  checkCaseFreshness,
  createCaseReport,
  readCaseReport,
  serializeCaseReport,
  writeCaseReport,
} from './reports/case-report.js';

export interface CliOutput {
  stdout(text: string): void;
  stderr(text: string): void;
}
const HELP = `Praesidia Investigator — standalone control investigations

Usage:
  praesidia-investigator demo [--variant request-unbound|request-bound|block-all|false-refusal|unavailable] [--out new-report.json] [--json]
  praesidia-investigator init <new-case-directory> --target-config <operator-config.json> [--json]
  praesidia-investigator investigate <case-directory> [--target-config operator-config.json] [--scripted] [--out new-report.json] [--json]
  praesidia-investigator doctor [--live] [--out new-diagnostic.json] [--json]
  praesidia-investigator verify <report.json> [--against case-directory] [--json]
  praesidia-investigator verify-repair <repair.json> [--json]
  praesidia-investigator repair-demo [--live] [--out new-directory] [--json]
  praesidia-investigator understand <case-directory> [--out new-context.json] [--json]
  praesidia-investigator evidence-demo [--live] [--out new-directory] [--json]
  praesidia-investigator verify-evidence <evidence-plan.json> [--json]
  praesidia-investigator import-mcp <export-directory> [--out new-import.json] [--json]
  praesidia-investigator checkpoint <evidence-plan.json> [--out new-checkpoint.json] [--json]
  praesidia-investigator assurance-diff <checkpoint.json> <candidate-state.json> [--out new-directory] [--json]
  praesidia-investigator assurance-demo [--live] [--out new-directory] [--json]
  praesidia-investigator verify-assurance <change.json|demo.json> [--json]
  praesidia-investigator cancellation-demo [--variant cached-worker|current-worker|capture-gap|block-all] [--live] [--out new-directory] [--json]
  praesidia-investigator cancellation-trials [--cases 1..4] [--live] [--out new-directory] [--json]
  praesidia-investigator verify-cancellation <case.json|trials.json> [--json]
  praesidia-investigator interop-profiles [--json]
  praesidia-investigator interop-run <request.json> --adapter-config <operator-config.json> --out <new-directory> [--json]
  praesidia-investigator verify-interop <result.json> [--request request.json] [--json]
  praesidia-investigator show <case-dir|case.json>
  praesidia-investigator render <report.json> --out new-report.html [--format html|junit]
  praesidia-investigator schema
  praesidia-investigator smoke [--out new-report.json] [--json]
  praesidia-investigator evaluate [--live] [--cases 1..12] [--out new-results.json] [--json]

demo uses deterministic scripted orchestration and real synthetic effect checks.
investigate calls Meta using META_API_KEY (or MODEL_API_KEY), MODEL_ID and optional MODEL_BASE_URL.
--scripted selects the known control's deterministic test provider explicitly.
Selected case evidence is sent to that provider. No Praesidia account is required.
verify checks the supplied manifest and citations, not independently trusted authorship.

interop-run executes only with an operator --adapter-config whose digest matches the request; requests are data, not permission.
Investigation exit codes: 0 supported, 1 contradicted, 2 incomplete or failed.
Reports contain selected evidence and never overwrite an existing output file.
repair-demo patches an isolated copy of the authored HTTP example and retests it.
understand projects the selected context.json declarations with exact evidence citations; it does not crawl a company.
evidence-demo builds client context, diagnoses missing witnesses and tests a producer-only instrumentation change.
verify-evidence checks supplied records and manifests; it does not authenticate or reexecute them.
import-mcp reads a saved tools/list export; it never calls the server or trusts tool annotations.
assurance-diff explains changes to recorded dependencies; it does not renew a behavioral finding.
assurance-demo tests stale evidence, a fresh unsafe outcome, policy/tool review and unmapped tools.
--live and smoke call Meta; all other demos are explicitly scripted.
`;

function summarize(run: InvestigationRun): string {
  return [
    `Mode: ${run.provider.mode} (${run.provider.model})`,
    `Run: ${run.status}`,
    `Claim: ${run.finding?.verdict ?? 'unresolved'}`,
    ...(run.finding ? [run.finding.statement] : []),
    ...run.checks.map((check) => `${check.status.padEnd(10)} ${check.id}: ${check.summary}`),
    ...run.limitations.map((limitation) => `Scope: ${limitation}`),
    ...(run.error ? [`Error: ${run.error.code}: ${run.error.message}`] : []),
  ].join('\n');
}

function parseOptions(args: readonly string[]) {
  try {
    return parseArgs({
      args: [...args],
      allowPositionals: true,
      strict: true,
      options: {
        help: { type: 'boolean' },
        json: { type: 'boolean' },
        out: { type: 'string' },
        variant: { type: 'string' },
        against: { type: 'string' },
        live: { type: 'boolean' },
        format: { type: 'string' },
        cases: { type: 'string' },
        'target-config': { type: 'string' },
        scripted: { type: 'boolean' },
        request: { type: 'string' },
        'adapter-config': { type: 'string' },
      },
    });
  } catch {
    throw new InvestigatorError(
      'INVALID_ARGUMENTS',
      'Invalid command options. Run --help for usage.',
    );
  }
}

export async function runCli(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  io: CliOutput,
  signal?: AbortSignal,
): Promise<number> {
  try {
    const { values, positionals } = parseOptions(args);
    if (values.help || positionals.length === 0) {
      io.stdout(HELP);
      return 0;
    }
    const command = positionals[0];
    if (values['target-config'] !== undefined && command !== 'investigate' && command !== 'init')
      throw new InvestigatorError(
        'INVALID_ARGUMENTS',
        '--target-config is only available for init and investigate.',
      );
    if (values.scripted !== undefined && command !== 'investigate')
      throw new InvestigatorError(
        'INVALID_ARGUMENTS',
        '--scripted is only available for investigate.',
      );
    if (values.cases && command !== 'evaluate' && command !== 'cancellation-trials')
      throw new InvestigatorError(
        'INVALID_ARGUMENTS',
        '--cases is only available for evaluate and cancellation-trials.',
      );
    const liveProvider = () => createMetaProvider(env);
    const cancellationCode = await runCancellationCli({
      command: command!,
      positionals,
      values,
      env,
      io,
      ...(signal ? { signal } : {}),
    });
    if (cancellationCode !== undefined) return cancellationCode;
    const interopCode = await runInteropCli({
      command: command!,
      positionals,
      values,
      io,
      ...(signal ? { signal } : {}),
    });
    if (interopCode !== undefined) return interopCode;
    const assuranceCode = await runAssuranceCli({
      command: command!,
      positionals,
      values,
      env,
      io,
      ...(signal ? { signal } : {}),
    });
    if (assuranceCode !== undefined) return assuranceCode;
    if (command === 'understand' || command === 'evidence-demo' || command === 'verify-evidence') {
      if (
        values.variant ||
        values.against ||
        values.format ||
        values.cases ||
        (command !== 'evidence-demo' && values.live) ||
        (command === 'evidence-demo'
          ? positionals.length !== 1
          : positionals.length !== 2 || !positionals[1]) ||
        (command === 'verify-evidence' && values.out)
      )
        throw new InvestigatorError(
          'INVALID_ARGUMENTS',
          'Use understand <case-directory>, evidence-demo [--live], or verify-evidence <report.json> with their documented options.',
        );
      if (command === 'understand') {
        const { snapshot } = await loadClientContext(positionals[1]!);
        if (values.out)
          await writeFile(values.out, `${JSON.stringify(snapshot, null, 2)}\n`, {
            encoding: 'utf8',
            flag: 'wx',
            mode: 0o600,
          }).catch(() => {
            throw new InvestigatorError(
              'OUTPUT_UNAVAILABLE',
              'Choose an available new context output file.',
            );
          });
        io.stdout(
          values.json
            ? `${JSON.stringify(snapshot, null, 2)}\n`
            : `Client workflow: ${snapshot.context.scope.workflowRef}\nEntities: ${snapshot.context.entities.length}\nAssertions: ${snapshot.context.assertions.length}\nScope: selected sources only; no autonomous discovery\nUnresolved questions: ${snapshot.context.unresolvedQuestions.length}\n`,
        );
        return 0;
      }
      if (command === 'verify-evidence') {
        const report = verifyEvidencePlanReport(
          parseJson(
            decodeUtf8(await readBoundedFile(positionals[1]!, 20_971_520)),
            'INVALID_EVIDENCE_PLAN_REPORT',
          ),
        );
        const result = {
          integrity: 'consistent-with-supplied-records',
          authenticity: 'not-established',
          execution: 'not-reexecuted',
          validation: report.validation,
        };
        io.stdout(
          values.json
            ? `${JSON.stringify(result, null, 2)}\n`
            : 'Evidence plan records consistent. Authorship not established; recorded workload not reexecuted.\n',
        );
        return 0;
      }
      const report = await runEvidencePlanWorkflow({
        ...(values.live ? { provider: liveProvider() } : {}),
        ...(signal ? { signal } : {}),
      });
      if (values.out) await writeEvidencePlanBundle(values.out, report);
      io.stdout(
        values.json
          ? `${JSON.stringify(report, null, 2)}\n`
          : `Planning: ${report.planning.provider.mode}\nClient context: ${report.context.context.entities.length} entities with explicit source boundaries\nSafe control: ${report.assessments.safeBefore.verdict} -> ${report.assessments.safeAfter.verdict}\nUnsafe control: ${report.assessments.unsafeBefore.verdict} -> ${report.assessments.unsafeAfter.verdict}\nBusiness outcomes preserved: ${report.validation.safeBehaviorPreserved && report.validation.unsafeBehaviorPreserved}\nWitness-removal checks: ${report.validation.witnessChecks.length}\nScope: isolated authored workload; production completeness not established\n${values.out ? 'Context, evidence plan, exact patch and HTML report saved.\n' : ''}`,
      );
      return report.validation.safeBecameAssessable &&
        report.validation.unsafeStillFails &&
        report.validation.safeBehaviorPreserved &&
        report.validation.unsafeBehaviorPreserved &&
        report.validation.excludedCanaryAbsent &&
        report.validation.witnessChecks.length > 0 &&
        report.validation.witnessChecks.every(
          (check) => check.verdictWithoutField === 'insufficient_evidence',
        )
        ? 0
        : 2;
    }
    if (command === 'init') {
      if (
        positionals.length !== 2 ||
        !positionals[1] ||
        !values['target-config'] ||
        values.out ||
        values.live ||
        values.variant ||
        values.against ||
        values.format ||
        values.cases
      )
        throw new InvestigatorError(
          'INVALID_ARGUMENTS',
          'init requires one new directory and --target-config.',
        );
      const controlCase = await initializeControlCase(positionals[1], values['target-config']);
      io.stdout(
        values.json
          ? `${JSON.stringify(controlCase, null, 2)}\n`
          : 'Case initialized with synthetic starter evidence. Edit the policy/request evidence and declared coverage before investigating your application.\n',
      );
      return 0;
    }
    if (command === 'doctor') {
      if (
        positionals.length !== 1 ||
        values.variant ||
        values.against ||
        values.format ||
        values.cases
      )
        throw new InvestigatorError(
          'INVALID_ARGUMENTS',
          'doctor accepts --live, --out and --json.',
        );
      const diagnostic = await diagnoseMeta(env, {
        ...(values.live ? { live: true } : {}),
        ...(signal ? { signal } : {}),
      });
      if (values.out)
        await writeFile(values.out, `${JSON.stringify(diagnostic, null, 2)}\n`, {
          encoding: 'utf8',
          mode: 0o600,
          flag: 'wx',
        }).catch(() => {
          throw new InvestigatorError(
            'OUTPUT_UNAVAILABLE',
            'Choose an available new diagnostic output file.',
          );
        });
      io.stdout(
        values.json
          ? `${JSON.stringify(diagnostic, null, 2)}\n`
          : `Model: ${diagnostic.selectedModel}\nReasoning: ${diagnostic.reasoningEffort}\nKey configured: ${diagnostic.keyConfigured}\nAccount access: ${diagnostic.accountAccess}\nGeneration verification: ${diagnostic.generationVerification}\n`,
      );
      return diagnostic.accountAccess === 'selected-model-unavailable' ? 2 : 0;
    }
    if (command === 'verify-repair') {
      if (
        positionals.length !== 2 ||
        !positionals[1] ||
        values.out ||
        values.live ||
        values.variant ||
        values.against ||
        values.format
      )
        throw new InvestigatorError(
          'INVALID_ARGUMENTS',
          'verify-repair requires one repair report path.',
        );
      const report = verifyRepairResult(
        parseJson(
          decodeUtf8(await readBoundedFile(positionals[1], 20_971_520)),
          'INVALID_REPAIR_REPORT',
        ),
      );
      const verified = {
        ...report.verification,
        integrity: 'consistent-with-supplied-reports-and-source-manifests',
        authenticity: 'not-established',
        behavior: 'recorded-retest-not-reexecuted',
      };
      io.stdout(
        values.json
          ? `${JSON.stringify(verified)}\n`
          : `Repair evidence consistent: ${verified.unchangedExpectations}\nGap closed in recorded checks: ${verified.closedGap}\nAuthorship: not established\nBehavior: recorded retest, not reexecuted\n`,
      );
      return verified.closedGap && verified.unchangedExpectations && verified.permittedWorkPreserved
        ? 0
        : 2;
    }
    if (command === 'schema') {
      if (positionals.length !== 1 || Object.keys(values).length)
        throw new InvestigatorError('INVALID_ARGUMENTS', 'schema accepts no options.');
      io.stdout(`${JSON.stringify(caseReportJsonSchema(), null, 2)}\n`);
      return 0;
    }
    if (command === 'render') {
      if (
        positionals.length !== 2 ||
        !positionals[1] ||
        !values.out ||
        values.live ||
        values.variant ||
        values.against ||
        values.json ||
        (values.format && !['html', 'junit'].includes(values.format))
      )
        throw new InvestigatorError(
          'INVALID_ARGUMENTS',
          'render requires one case report and --out, with optional --format html|junit.',
        );
      const report = await readCaseReport(positionals[1]);
      await writeFile(
        values.out,
        values.format === 'junit' ? renderJUnit(report) : renderCaseHtml(report),
        { encoding: 'utf8', flag: 'wx', mode: 0o600 },
      ).catch(() => {
        throw new InvestigatorError('OUTPUT_UNAVAILABLE', 'Choose an available new output file.');
      });
      io.stdout('Report rendered.\n');
      return 0;
    }
    if (values.format)
      throw new InvestigatorError('INVALID_ARGUMENTS', '--format is only available for render.');
    if (command === 'evaluate') {
      if (
        positionals.length !== 1 ||
        values.variant ||
        values.against ||
        (values.cases && !/^(?:[1-9]|1[0-2])$/.test(values.cases))
      )
        throw new InvestigatorError(
          'INVALID_ARGUMENTS',
          'evaluate accepts --live, --cases 1..12, --out and --json.',
        );
      if (values.live) liveProvider();
      const report = await evaluateInvestigator({
        ...(values.live ? { providerFactory: liveProvider } : {}),
        ...(signal ? { signal } : {}),
        ...(values.cases ? { maxCases: Number(values.cases) } : {}),
      });
      if (values.out)
        await writeFile(values.out, `${JSON.stringify(report, null, 2)}\n`, {
          encoding: 'utf8',
          flag: 'wx',
          mode: 0o600,
        }).catch(() => {
          throw new InvestigatorError(
            'OUTPUT_UNAVAILABLE',
            'Choose an available new evaluation output file.',
          );
        });
      io.stdout(
        values.json
          ? `${JSON.stringify(report, null, 2)}\n`
          : `Mode: ${report.mode}\nCases: ${report.totals.cases}\nPassed: ${report.totals.passed}\nFailed: ${report.totals.failed}\nMonetary cost: unknown\n${report.limitations.map((item) => `Scope: ${item}`).join('\n')}\n`,
      );
      return report.cancelled ? 2 : report.totals.failed ? 1 : 0;
    }
    if (command === 'repair-demo') {
      if (positionals.length !== 1 || values.variant || values.against)
        throw new InvestigatorError(
          'INVALID_ARGUMENTS',
          'repair-demo accepts --live, --out and --json.',
        );
      if (values.live) liveProvider();
      const result = await runRepairWorkflow({
        ...(values.live ? { providerFactory: liveProvider } : {}),
        ...(signal ? { signal } : {}),
      });
      if (values.out) await writeRepairBundle(values.out, result);
      io.stdout(
        values.json
          ? `${JSON.stringify(result, null, 2)}\n`
          : `Before: ${result.before.run.finding?.verdict ?? 'unresolved'}\nAfter: ${result.after.run.finding?.verdict ?? 'unresolved'}\nUnchanged expectations: ${result.verification.unchangedExpectations}\nPermitted work preserved: ${result.verification.permittedWorkPreserved}\nScope: ${result.verification.scope}\n${values.out ? 'Before/after cases, HTML and exact patch saved.\n' : ''}`,
      );
      return result.verification.closedGap &&
        result.verification.unchangedExpectations &&
        result.verification.permittedWorkPreserved
        ? 0
        : 2;
    }
    if (values.live)
      throw new InvestigatorError('INVALID_ARGUMENTS', '--live is only available for repair-demo.');
    if (command === 'verify') {
      if (positionals.length !== 2 || !positionals[1] || values.variant || values.out)
        throw new InvestigatorError('INVALID_ARGUMENTS', 'verify requires one report path.');
      const report = await readCaseReport(positionals[1]);
      const result = {
        integrity: 'consistent-with-supplied-manifest',
        citations: 'resolved',
        authenticity: 'not-established',
        freshness: values.against
          ? await checkCaseFreshness(report, values.against)
          : 'not-checked',
      };
      io.stdout(
        values.json
          ? JSON.stringify(result)
          : `Integrity: ${result.integrity}\nCitations: ${result.citations}\nAuthorship: ${result.authenticity}\nFreshness: ${result.freshness}\n`,
      );
      return result.freshness === 'stale' ? 2 : 0;
    }
    if (command !== 'demo' && command !== 'investigate' && command !== 'smoke')
      throw new InvestigatorError('INVALID_ARGUMENTS', 'Unknown command. Run --help for usage.');
    if (values.against)
      throw new InvestigatorError('INVALID_ARGUMENTS', '--against is only available for verify.');
    if (
      command !== 'investigate'
        ? positionals.length !== 1
        : positionals.length !== 2 || !positionals[1]
    )
      throw new InvestigatorError(
        'INVALID_ARGUMENTS',
        'Provide the expected case directory or run --help.',
      );
    if (command !== 'demo' && values.variant)
      throw new InvestigatorError(
        'INVALID_ARGUMENTS',
        '--variant is only available for the reference demo.',
      );
    const directory =
      command !== 'investigate'
        ? fileURLToPath(new URL('../examples/customer-export/', import.meta.url))
        : positionals[1]!;
    const bundle = await loadLocalCase(directory);
    if (command === 'demo' && values.variant) {
      bundle.controlCase.referenceTarget = {
        kind: 'customer-export-reference',
        variant: parseInput(
          referenceVariantSchema,
          values.variant,
          'INVALID_ARGUMENTS',
          'Reference variant',
        ),
      };
    }
    const provider =
      command === 'demo' || values.scripted ? new ScriptedReferenceProvider() : liveProvider();
    const checkAdapter = values['target-config']
      ? await loadHttpApprovalTarget(values['target-config'], env)
      : undefined;
    const run = await investigate({
      ...bundle,
      provider,
      ...(checkAdapter ? { checkAdapter } : {}),
      ...(signal ? { signal } : {}),
      ...(command === 'smoke'
        ? {
            budget: {
              maxModelTurns: 8,
              maxToolCalls: 12,
              maxOutputTokens: 16_384,
              maxOutputTokensPerCall: 2048,
            },
          }
        : {}),
    });
    const report = createCaseReport(bundle.controlCase, bundle.evidence, run);
    if (values.out) await writeCaseReport(values.out, report);
    io.stdout(
      values.json
        ? serializeCaseReport(report)
        : `${summarize(run)}\n${values.out ? 'Case report saved.\n' : ''}`,
    );
    if (command === 'smoke')
      return run.status === 'completed' &&
        run.checks.length === 3 &&
        run.events.some((event) => event.kind === 'tool-result')
        ? 0
        : 2;
    return run.status !== 'completed' ? 2 : run.finding?.verdict === 'supported' ? 0 : 1;
  } catch (error) {
    const safe = publicError(error);
    io.stderr(`${safe.code}: ${safe.message}\n`);
    return 2;
  }
}
