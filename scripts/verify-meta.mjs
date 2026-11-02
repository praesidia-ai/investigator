import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

export function verificationOptions(args) {
  const options = { cases: 5, repetitions: 1 };
  for (let index = 0; index < args.length; index++) {
    const name = args[index];
    const value = args[++index];
    if (name === '--out' && value && !options.outputDirectory)
      options.outputDirectory = resolve(value);
    else if (name === '--cases' && /^(?:[1-9]|1[0-2])$/.test(value ?? ''))
      options.cases = Number(value);
    else if (name === '--repetitions' && /^[1-3]$/.test(value ?? ''))
      options.repetitions = Number(value);
    else throw new Error('Use --out new-directory [--cases 1..12] [--repetitions 1..3].');
  }
  if (!options.outputDirectory) throw new Error('Choose a new evidence directory with --out.');
  return options;
}

/** Only the selected model configuration and basic executable lookup reach the child. */
export function liveChildEnvironment(source) {
  const env = {};
  for (const name of [
    'PATH',
    'SystemRoot',
    'WINDIR',
    'TMPDIR',
    'TEMP',
    'TMP',
    'LANG',
    'META_API_KEY',
    'MODEL_API_KEY',
    'MODEL_ID',
    'MODEL_BASE_URL',
    'MODEL_REASONING_EFFORT',
  ])
    if (source[name] !== undefined) env[name] = source[name];
  return env;
}

async function command(args, env, signal, entry = join(ROOT, 'dist/bin.js')) {
  if (signal.aborted) return 130;
  return new Promise((done) => {
    const child = spawn(process.execPath, [entry, ...args], {
      cwd: ROOT,
      env,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    let killTimer;
    const abort = () => {
      child.kill('SIGINT');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 5000);
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    child.once('error', () => done(2));
    child.once('close', (code) => {
      if (killTimer) clearTimeout(killTimer);
      signal.removeEventListener('abort', abort);
      done(code ?? 2);
    });
  });
}

export async function runLiveVerification(options, sourceEnvironment = process.env) {
  const {
    diagnoseMeta,
    readCaseReport,
    verifyRepairResult,
    verifyEvidencePlanReport,
    verifyAssuranceDemo,
    verifyCancellationCase,
    verifyCancellationTrials,
  } = await import('../dist/index.js');
  const env = liveChildEnvironment(sourceEnvironment);
  const diagnostic = await diagnoseMeta(env);
  if (!diagnostic.keyConfigured)
    throw new Error(
      'Configure META_API_KEY or MODEL_API_KEY locally before explicit live verification.',
    );
  await mkdir(options.outputDirectory, { mode: 0o700 });
  const abort = new AbortController();
  const cancel = () => abort.abort();
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  const stages = [];
  const evidence = [];
  let passed = true;
  async function stage(name, args, inspect, files, entry) {
    const startedAt = new Date().toISOString();
    const exitCode = await command(args, env, abort.signal, entry);
    let valid = exitCode === 0;
    if (valid)
      try {
        valid = Boolean(await inspect());
      } catch {
        valid = false;
      }
    stages.push({
      name,
      startedAt,
      finishedAt: new Date().toISOString(),
      exitCode,
      status: valid ? 'PASS' : abort.signal.aborted ? 'CANCELLED' : 'FAIL',
    });
    for (const file of files) {
      const bytes = await readFile(join(options.outputDirectory, file)).catch(() => null);
      if (!bytes) {
        if (valid) {
          valid = false;
          stages.at(-1).status = 'FAIL';
          stages.at(-1).reason =
            'A required stage artifact is missing; the retained evidence bundle is incomplete.';
        }
        continue;
      }
      if (
        [env.META_API_KEY, env.MODEL_API_KEY].some(
          (secret) => secret && bytes.includes(Buffer.from(secret)),
        )
      ) {
        valid = false;
        stages.at(-1).status = 'FAIL';
        stages.at(-1).reason =
          'Configured credential detected in a local artifact; do not share it.';
      }
      evidence.push({
        path: file,
        bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      });
    }
    process.stdout.write(`${name}: ${valid ? 'PASS' : 'FAIL'}\n`);
    passed &&= valid;
    return valid;
  }
  try {
    const file = (name) => join(options.outputDirectory, name);
    if (
      await stage(
        'model-access',
        ['doctor', '--live', '--out', file('doctor.json')],
        async () =>
          JSON.parse(await readFile(file('doctor.json'), 'utf8')).accountAccess ===
          'selected-model-available',
        ['doctor.json'],
      )
    ) {
      if (
        await stage(
          'tool-continuation',
          ['smoke', '--out', file('smoke.json')],
          async () => {
            const report = await readCaseReport(file('smoke.json'));
            return (
              report.run.provider.mode === 'live' &&
              report.run.provider.model === diagnostic.selectedModel &&
              report.run.status === 'completed' &&
              report.run.events.some((event) => event.kind === 'tool-result') &&
              report.run.events.some(
                (event) => event.role === 'skeptic' && event.kind === 'assessment',
              )
            );
          },
          ['smoke.json'],
        )
      ) {
        const cancellationPassed = await stage(
          'cancellation-investigation-and-repair',
          ['cancellation-demo', '--live', '--out', file('cancellation')],
          async () => {
            const report = verifyCancellationCase(
              JSON.parse(await readFile(file('cancellation/case.json'), 'utf8')),
            );
            return (
              report.before.provider.mode === 'live' &&
              report.before.provider.model === diagnostic.selectedModel &&
              report.before.status === 'completed' &&
              report.before.validation.accepted &&
              report.before.finding?.verdict === 'contradicted' &&
              report.after?.provider.mode === 'live' &&
              report.after.provider.model === diagnostic.selectedModel &&
              report.after.status === 'completed' &&
              report.after.validation.accepted &&
              report.after.finding?.verdict === 'supported' &&
              report.repair.status === 'applied' &&
              report.verification.closedGap &&
              report.verification.unchangedWorkload &&
              report.verification.independentWorkBefore &&
              report.verification.independentWorkAfter &&
              report.verification.preCutWorkPreserved &&
              report.verification.contentCanaryAbsent &&
              report.baseline.length === 4 &&
              report.retest.length === 4
            );
          },
          [
            'cancellation/case.json',
            'cancellation/before.json',
            'cancellation/after.json',
            'cancellation/report.html',
            'cancellation/repair.diff',
          ],
        );
        const cancellationTrialsPassed =
          cancellationPassed &&
          (await stage(
            'cancellation-authored-trials',
            ['cancellation-trials', '--cases', '3', '--live', '--out', file('cancellation-trials')],
            async () => {
              const report = verifyCancellationTrials(
                JSON.parse(await readFile(file('cancellation-trials/trials.json'), 'utf8')),
              );
              const expected = ['contradicted', 'supported', 'insufficient_evidence'];
              return (
                report.mode === 'live-authored-concealed-variant-trials' &&
                report.requestedCases === 3 &&
                !report.cancelled &&
                report.cases.length === 3 &&
                report.totals.executed === 3 &&
                report.totals.correct === 3 &&
                report.totals.unsupportedConclusions === 0 &&
                report.cases.every(
                  (trial, index) =>
                    trial.expectedVerdict === expected[index] &&
                    trial.groundedConclusionCorrect &&
                    !trial.unsupportedConclusion &&
                    trial.report.before.provider.mode === 'live' &&
                    trial.report.before.provider.model === diagnostic.selectedModel &&
                    trial.report.before.status === 'completed' &&
                    trial.report.before.validation.accepted &&
                    trial.report.before.finding?.verdict === expected[index],
                )
              );
            },
            [
              'cancellation-trials/trials.json',
              'cancellation-trials/trial-01.json',
              'cancellation-trials/trial-01.html',
              'cancellation-trials/trial-02.json',
              'cancellation-trials/trial-02.html',
              'cancellation-trials/trial-03.json',
              'cancellation-trials/trial-03.html',
            ],
          ));
        const evidencePassed =
          cancellationTrialsPassed &&
          (await stage(
            'client-evidence-plan',
            ['evidence-demo', '--live', '--out', file('evidence-plan')],
            async () => {
              const report = verifyEvidencePlanReport(
                JSON.parse(await readFile(file('evidence-plan/evidence-plan.json'), 'utf8')),
              );
              return (
                report.planning.provider.mode === 'live' &&
                report.planning.provider.model === diagnostic.selectedModel &&
                report.validation.safeBecameAssessable &&
                report.validation.unsafeStillFails &&
                report.validation.safeBehaviorPreserved &&
                report.validation.unsafeBehaviorPreserved &&
                report.validation.excludedCanaryAbsent &&
                report.validation.witnessChecks.length > 0 &&
                report.validation.witnessChecks.every(
                  (check) => check.verdictWithoutField === 'insufficient_evidence',
                )
              );
            },
            [
              'evidence-plan/evidence-plan.json',
              'evidence-plan/context.json',
              'evidence-plan/instrumentation.diff',
              'evidence-plan/report.html',
            ],
          ));
        const assurancePassed =
          evidencePassed &&
          (await stage(
            'change-investigation',
            ['assurance-demo', '--live', '--out', file('assurance')],
            async () => {
              const report = verifyAssuranceDemo(
                JSON.parse(await readFile(file('assurance/demo.json'), 'utf8')),
              );
              return (
                report.checkpoint.evidencePlan.planning.provider.mode === 'live' &&
                report.checkpoint.evidencePlan.planning.provider.model === diagnostic.selectedModel
              );
            },
            [
              'assurance/demo.json',
              'assurance/checkpoint.json',
              'assurance/runtime-setting.json',
              'assurance/runtime-setting.html',
            ],
          ));
        if (
          assurancePassed &&
          (await stage(
            'repair-and-retest',
            ['repair-demo', '--live', '--out', file('repair')],
            async () => {
              const report = verifyRepairResult(
                JSON.parse(await readFile(file('repair/repair.json'), 'utf8')),
              );
              return (
                report.before.run.provider.mode === 'live' &&
                report.after.run.provider.mode === 'live' &&
                report.before.run.provider.model === diagnostic.selectedModel &&
                report.after.run.provider.model === diagnostic.selectedModel &&
                report.verification.closedGap &&
                report.verification.unchangedExpectations &&
                report.verification.permittedWorkPreserved
              );
            },
            ['repair/repair.json', 'repair/before.json', 'repair/after.json'],
          ))
        ) {
          const independentPassed = await stage(
            'independent-http-target',
            ['--live', file('independent')],
            async () => {
              const summary = JSON.parse(await readFile(file('independent/summary.json'), 'utf8'));
              const before = await readCaseReport(file('independent/before/report.json'));
              const after = await readCaseReport(file('independent/after/report.json'));
              return (
                summary.mode === 'live' &&
                summary.model === diagnostic.selectedModel &&
                summary.unchangedExpectations === true &&
                before.run.finding?.verdict === 'contradicted' &&
                after.run.finding?.verdict === 'supported'
              );
            },
            [
              'independent/summary.json',
              'independent/before/report.json',
              'independent/after/report.json',
            ],
            join(ROOT, 'scripts/independent-demo.mjs'),
          );
          if (independentPassed)
            for (let run = 1; run <= options.repetitions; run++) {
              const name = `evaluation-${run}.json`;
              if (
                !(await stage(
                  `authored-evaluation-${run}`,
                  ['evaluate', '--live', '--cases', String(options.cases), '--out', file(name)],
                  async () => {
                    const report = JSON.parse(await readFile(file(name), 'utf8'));
                    return (
                      report.mode === 'live-authored-fixture-evaluation' &&
                      !report.cancelled &&
                      report.totals.cases === options.cases &&
                      report.totals.passed === options.cases &&
                      report.cases.every(
                        (item) =>
                          item.provider?.mode === 'live' &&
                          item.provider.model === diagnostic.selectedModel,
                      )
                    );
                  },
                  [name],
                ))
              )
                break;
            }
        }
      }
    }
    const report = {
      format: 'investigator-live-verification-v1',
      model: diagnostic.selectedModel,
      providerEndpoint: diagnostic.customEndpoint ? 'operator-custom' : 'official-meta-api',
      reasoningEffort: diagnostic.reasoningEffort,
      status:
        passed && !abort.signal.aborted ? 'PASS' : abort.signal.aborted ? 'CANCELLED' : 'FAIL',
      requestedCases: options.cases,
      repetitions: options.repetitions,
      completedAt: new Date().toISOString(),
      stages,
      evidence,
      limitations: [
        'Explicit live provider calls on authored synthetic evidence; no representative production-accuracy claim.',
        'Model-catalog access alone does not establish generation or tool correctness.',
        'Supplied checksums establish artifact consistency, not independently trusted authorship.',
        'No automatic retries, model substitution, publication or submission were performed.',
        ...(diagnostic.customEndpoint
          ? [
              'Operator-configured endpoint compatibility only; this is not verification of direct Meta service access.',
            ]
          : []),
      ],
    };
    await writeFile(file('live-verification.json'), `${JSON.stringify(report, null, 2)}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
    return report;
  } finally {
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  (async () => {
    const report = await runLiveVerification(verificationOptions(process.argv.slice(2)));
    process.stdout.write(`Live verification: ${report.status}\n`);
    process.exitCode = report.status === 'PASS' ? 0 : 2;
  })().catch(() => {
    process.stderr.write(
      'Live verification could not start or save its results. Check the local model configuration, build and new output directory.\n',
    );
    process.exitCode = 2;
  });
}
