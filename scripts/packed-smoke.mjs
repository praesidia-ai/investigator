import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { copyFile, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PACKAGE_ROOT = fileURLToPath(new URL('../', import.meta.url));
const REQUIRED_FILES = [
  'dist/bin.js',
  'dist/index.js',
  'dist/index.d.ts',
  'README.md',
  'CONTRIBUTING.md',
  'SECURITY.md',
  'CHANGELOG.md',
  'LICENSE',
  'NOTICE',
  'docs/RELEASING.md',
  'docs/INDEPENDENT-TRIAL.md',
  'scripts/packed-smoke.mjs',
  'scripts/release-readiness.mjs',
  'scripts/independent-demo.mjs',
  'scripts/verify-meta.mjs',
  'docs/ADAPTERS.md',
  'docs/META-MODELS.md',
  'docs/CLIENT-CONTEXT.md',
  'docs/ASSURANCE-CHANGES.md',
  'docs/CANCELLATION.md',
  'examples/cancellation-service/server.mjs',
  'examples/cancellation-service/worker-authority.mjs',
  'examples/independent-export-service/service.py',
  'examples/independent-export-service/observer.mjs',
  'examples/customer-export/case.json',
  'examples/customer-export/policy.md',
  'examples/customer-export/work-request.json',
  'examples/export-service/server.mjs',
  'examples/export-service/authorization.mjs',
  'examples/client-evidence-gap/case.json',
  'examples/client-evidence-gap/context.json',
  'examples/client-evidence-gap/policy.md',
  'examples/client-evidence-gap/architecture.json',
  'examples/client-evidence-gap/telemetry.json',
  'examples/client-evidence-gap/producer.mjs',
  'examples/evidence-gap-service/server.mjs',
  'examples/evidence-gap-service/instrumentation.mjs',
  'examples/mcp-export/mcp-source.json',
  'examples/mcp-export/tools.json',
  'examples/mcp-export/tools-changed.json',
  'examples/mcp-export/tools-page.json',
];
const BLOCKED_SEGMENTS = new Set([
  '.git',
  '.claude',
  'node_modules',
  'artifacts',
  'coverage',
  'be',
  'ui',
  'shared',
  'worker',
  'gateway',
  'IAC',
]);
const LIBRARY_FUNCTIONS = [
  'investigate',
  'loadLocalCase',
  'verifyCaseReport',
  'renderCaseHtml',
  'runRepairWorkflow',
  'verifyRepairResult',
  'evaluateInvestigator',
  'createHttpApprovalTarget',
  'loadHttpApprovalTarget',
  'initializeControlCase',
  'diagnoseMeta',
  'loadClientContext',
  'createClientSystemSnapshot',
  'queryClientContext',
  'investigateEvidenceGap',
  'runEvidencePlanWorkflow',
  'verifyEvidencePlanReport',
  'renderEvidencePlanHtml',
  'compareAssurance',
  'createAssuranceCheckpoint',
  'verifyAssuranceCheckpoint',
  'createAssuranceChangeReport',
  'verifyAssuranceChangeReport',
  'runAssuranceDemo',
  'verifyAssuranceDemo',
  'importMcpTools',
  'loadMcpExport',
  'renderAssuranceHtml',
  'investigateCancellation',
  'verifyCancellationInvestigation',
  'assessCancellationExperiments',
  'runCancellationWorkflow',
  'verifyCancellationCase',
  'evaluateCancellation',
  'verifyCancellationTrials',
  'renderCancellationHtml',
  'assertStrictMetaSchema',
];

/** Inspect npm's actual pack inventory, rather than trusting the files allowlist alone. */
export function inspectPackageFiles(entries, additionalRequired = []) {
  if (!Array.isArray(entries) || entries.length === 0)
    throw new Error('npm did not report a nonempty package inventory.');
  const paths = entries.map((entry) => (typeof entry === 'string' ? entry : entry?.path));
  if (paths.some((path) => typeof path !== 'string'))
    throw new Error('The package inventory contains an invalid entry.');
  for (const path of paths) {
    const segments = path.split('/');
    if (
      isAbsolute(path) ||
      path.includes('\\') ||
      segments.some(
        (part) =>
          !part ||
          part === '.' ||
          part === '..' ||
          BLOCKED_SEGMENTS.has(part) ||
          (part.startsWith('.env') && part !== '.env.example') ||
          part.startsWith('.qa'),
      )
    )
      throw new Error('The package inventory contains a forbidden private or generated path.');
  }
  if (new Set(paths).size !== paths.length)
    throw new Error('The package inventory contains duplicate entries.');
  const present = new Set(paths);
  if ([...REQUIRED_FILES, ...additionalRequired].some((path) => !present.has(path)))
    throw new Error(
      'The package is missing a required library, CLI, example, or release document.',
    );
  return [...paths].sort();
}

/** Do not pass model credentials, platform keys, NODE_PATH, or NODE_OPTIONS to the consumer. */
export function smokeEnvironment(source, scratch) {
  const inherited = {};
  for (const name of ['PATH', 'HOME', 'SystemRoot', 'WINDIR', 'TMPDIR', 'TEMP', 'TMP', 'LANG']) {
    if (source[name]) inherited[name] = source[name];
  }
  return {
    ...inherited,
    CI: 'true',
    npm_config_userconfig: join(scratch, 'empty.npmrc'),
    npm_config_globalconfig: join(scratch, 'empty-global.npmrc'),
    npm_config_cache: join(scratch, 'npm-cache'),
    npm_config_registry: 'https://registry.npmjs.org',
    npm_config_ignore_scripts: 'true',
    npm_config_audit: 'false',
    npm_config_fund: 'false',
  };
}

function execute(command, args, cwd, env, label) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: 'utf8',
    timeout: 180_000,
    maxBuffer: 12 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.error || result.status !== 0)
    throw new Error(
      `${label} failed${Number.isInteger(result.status) ? ` (exit ${result.status})` : ''}.`,
    );
  return result.stdout;
}

function parseJsonOutput(value, label) {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`${label} did not return valid JSON.`);
  }
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export async function runPackedSmoke({
  packageRoot = PACKAGE_ROOT,
  outputDirectory,
  includeIndependent = false,
} = {}) {
  const metadata = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
  if (!/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(metadata.name))
    throw new Error('The package name is invalid.');
  for (const version of Object.values(metadata.dependencies ?? {})) {
    if (typeof version !== 'string' || /^(?:file:|link:|workspace:|\.{1,2}\/|\/)/.test(version))
      throw new Error('Runtime dependencies must not resolve to another checkout.');
  }
  for (const file of ['dist/bin.js', 'dist/index.js', 'dist/index.d.ts']) {
    const stat = await lstat(join(packageRoot, file)).catch(() => null);
    if (!stat?.isFile() || stat.isSymbolicLink())
      throw new Error('Build the production files before running the packed smoke.');
  }
  const scratch = await mkdtemp(join(tmpdir(), 'investigator-packed-'));
  try {
    await writeFile(join(scratch, 'empty.npmrc'), '', { mode: 0o600 });
    await writeFile(join(scratch, 'empty-global.npmrc'), '', { mode: 0o600 });
    const env = smokeEnvironment(process.env, scratch);
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const packedDirectory = join(scratch, 'packed');
    await mkdir(packedDirectory);
    // The coordinator has already built/gated. Ignore prepack to avoid recursive checks.
    const packed = parseJsonOutput(
      execute(
        npm,
        ['pack', '--ignore-scripts', '--json', '--pack-destination', packedDirectory],
        packageRoot,
        env,
        'Package creation',
      ),
      'npm pack',
    );
    if (!Array.isArray(packed) || packed.length !== 1)
      throw new Error('npm pack did not produce exactly one package.');
    const item = packed[0];
    if (
      typeof item.filename !== 'string' ||
      basename(item.filename) !== item.filename ||
      !item.filename.endsWith('.tgz')
    )
      throw new Error('npm pack returned an invalid artifact filename.');
    const inventory = inspectPackageFiles(item.files);
    const tarball = join(packedDirectory, item.filename);
    const consumer = join(scratch, 'consumer');
    await mkdir(consumer);
    await writeFile(
      join(consumer, 'package.json'),
      JSON.stringify({ name: 'investigator-isolated-consumer', private: true, type: 'module' }),
    );
    execute(
      npm,
      ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false', tarball],
      consumer,
      env,
      'Isolated package installation',
    );
    const installedRoot = join(consumer, 'node_modules', ...metadata.name.split('/'));
    const cli = join(installedRoot, 'dist', 'bin.js');
    const runCli = (args, label) =>
      parseJsonOutput(execute(process.execPath, [cli, ...args], consumer, env, label), label);
    const cancellationDirectory = join(scratch, 'cancellation');
    const cancellation = runCli(
      ['cancellation-demo', '--out', cancellationDirectory, '--json'],
      'Installed cancellation demonstration',
    );
    const cancellationServer = await readFile(
      join(installedRoot, 'examples/cancellation-service/server.mjs'),
      'utf8',
    );
    const cancellationWorker = await readFile(
      join(installedRoot, 'examples/cancellation-service/worker-authority.mjs'),
      'utf8',
    );
    const savedCancellation = parseJsonOutput(
      await readFile(join(cancellationDirectory, 'case.json'), 'utf8'),
      'Saved installed cancellation case',
    );
    if (
      cancellation.format !== 'investigator-cancellation-case-v1' ||
      cancellation.before?.status !== 'completed' ||
      cancellation.before?.provider?.mode !== 'scripted' ||
      cancellation.before?.validation?.accepted !== true ||
      cancellation.before?.finding?.verdict !== 'contradicted' ||
      cancellation.after?.status !== 'completed' ||
      cancellation.after?.provider?.mode !== 'scripted' ||
      cancellation.after?.validation?.accepted !== true ||
      cancellation.after?.finding?.verdict !== 'supported' ||
      cancellation.repair?.status !== 'applied' ||
      cancellation.change?.recipe !== 'check-current-root-authority.v1' ||
      cancellation.verification?.closedGap !== true ||
      cancellation.verification?.unchangedWorkload !== true ||
      cancellation.verification?.independentWorkBefore !== true ||
      cancellation.verification?.independentWorkAfter !== true ||
      cancellation.verification?.preCutWorkPreserved !== true ||
      cancellation.verification?.contentCanaryAbsent !== true ||
      cancellation.verification?.scope !== 'authored-loopback-workflow' ||
      cancellation.beforeSources?.['server.mjs'] !== cancellationServer ||
      cancellation.beforeSources?.['worker-authority.mjs'] !== cancellationWorker ||
      cancellation.afterSources?.['server.mjs'] !== cancellationServer ||
      typeof cancellation.afterSources?.['worker-authority.mjs'] !== 'string' ||
      cancellation.afterSources['worker-authority.mjs'] === cancellationWorker ||
      JSON.stringify(cancellation) !== JSON.stringify(savedCancellation) ||
      JSON.stringify(cancellation).includes('INVESTIGATOR_SYNTHETIC_CANCELLATION_CONTENT')
    )
      throw new Error(
        'The installed cancellation demonstration failed its source, repair, independent-work or collection invariants.',
      );
    const suppliedRecordLimits = (result) =>
      result?.integrity === 'consistent-with-supplied-records' &&
      result.authenticity === 'not-established' &&
      result.execution === 'not-reexecuted';
    const cancellationVerification = runCli(
      ['verify-cancellation', join(cancellationDirectory, 'case.json'), '--json'],
      'Installed cancellation verification',
    );
    if (!suppliedRecordLimits(cancellationVerification))
      throw new Error('The installed cancellation verifier lost its supplied-record limits.');
    const cancellationTrialsDirectory = join(scratch, 'cancellation-trials');
    const cancellationTrials = runCli(
      ['cancellation-trials', '--cases', '3', '--out', cancellationTrialsDirectory, '--json'],
      'Installed cancellation authored trials',
    );
    const cancellationExpectedVerdicts = ['contradicted', 'supported', 'insufficient_evidence'];
    const savedCancellationTrials = parseJsonOutput(
      await readFile(join(cancellationTrialsDirectory, 'trials.json'), 'utf8'),
      'Saved installed cancellation trials',
    );
    if (
      cancellationTrials.format !== 'investigator-cancellation-trials-v1' ||
      cancellationTrials.mode !== 'scripted-engineering-regression' ||
      cancellationTrials.requestedCases !== 3 ||
      cancellationTrials.cancelled !== false ||
      cancellationTrials.totals?.executed !== 3 ||
      cancellationTrials.totals?.correct !== 3 ||
      cancellationTrials.totals?.unsupportedConclusions !== 0 ||
      !Array.isArray(cancellationTrials.cases) ||
      cancellationTrials.cases.length !== 3 ||
      cancellationTrials.cases.some(
        (trial, index) =>
          trial.expectedVerdict !== cancellationExpectedVerdicts[index] ||
          trial.groundedConclusionCorrect !== true ||
          trial.unsupportedConclusion !== false ||
          trial.report?.before?.status !== 'completed' ||
          trial.report?.before?.provider?.mode !== 'scripted' ||
          trial.report?.before?.validation?.accepted !== true ||
          trial.report?.before?.finding?.verdict !== cancellationExpectedVerdicts[index] ||
          trial.report?.change !== null ||
          trial.report?.verification?.contentCanaryAbsent !== true ||
          trial.report?.beforeSources?.['server.mjs'] !== cancellationServer ||
          typeof trial.report?.beforeSources?.['worker-authority.mjs'] !== 'string',
      ) ||
      JSON.stringify(cancellationTrials) !== JSON.stringify(savedCancellationTrials) ||
      JSON.stringify(cancellationTrials).includes('INVESTIGATOR_SYNTHETIC_CANCELLATION_CONTENT')
    )
      throw new Error(
        'The installed cancellation trials lost grounded safe, unsafe or incomplete outcomes.',
      );
    const cancellationTrialVerification = runCli(
      ['verify-cancellation', join(cancellationTrialsDirectory, 'trials.json'), '--json'],
      'Installed cancellation-trial verification',
    );
    if (!suppliedRecordLimits(cancellationTrialVerification))
      throw new Error('The installed cancellation-trial verifier lost its supplied-record limits.');
    const repairedDirectory = join(scratch, 'repair');
    const repair = runCli(
      ['repair-demo', '--out', repairedDirectory, '--json'],
      'Installed repair demonstration',
    );
    if (
      repair.format !== 'investigator-repair-v1' ||
      repair.before?.run?.finding?.verdict !== 'contradicted' ||
      repair.after?.run?.finding?.verdict !== 'supported'
    )
      throw new Error('The installed repair demonstration did not reproduce and close the gap.');
    const verification = runCli(
      ['verify-repair', join(repairedDirectory, 'repair.json'), '--json'],
      'Installed repair verification',
    );
    if (
      verification.closedGap !== true ||
      verification.unchangedExpectations !== true ||
      verification.permittedWorkPreserved !== true ||
      verification.authenticity !== 'not-established'
    )
      throw new Error('Installed repair verification failed its evidence or utility invariants.');
    const evidenceDirectory = join(scratch, 'evidence');
    const evidencePlan = runCli(
      ['evidence-demo', '--out', evidenceDirectory, '--json'],
      'Installed evidence-plan demonstration',
    );
    const validEvidenceValidation = (validation) =>
      validation?.safeBehaviorPreserved === true &&
      validation.unsafeBehaviorPreserved === true &&
      validation.safeBecameAssessable === true &&
      validation.unsafeStillFails === true &&
      validation.excludedCanaryAbsent === true &&
      Array.isArray(validation.witnessChecks) &&
      validation.witnessChecks.length > 0 &&
      validation.witnessChecks.every(
        (check) => check.verdictWithoutField === 'insufficient_evidence',
      );
    if (
      evidencePlan.format !== 'investigator-evidence-plan-v1' ||
      evidencePlan.planning?.provider?.mode !== 'scripted' ||
      evidencePlan.assessments?.safeBefore?.verdict !== 'insufficient_evidence' ||
      evidencePlan.assessments?.safeAfter?.verdict !== 'supported' ||
      evidencePlan.assessments?.unsafeAfter?.verdict !== 'contradicted' ||
      !validEvidenceValidation(evidencePlan.validation) ||
      JSON.stringify(evidencePlan).includes('INVESTIGATOR_SYNTHETIC_CUSTOMER_CONTENT')
    )
      throw new Error(
        'The installed evidence demonstration failed its assessment or collection invariants.',
      );
    const evidenceVerification = runCli(
      ['verify-evidence', join(evidenceDirectory, 'evidence-plan.json'), '--json'],
      'Installed evidence-plan verification',
    );
    if (
      evidenceVerification.integrity !== 'consistent-with-supplied-records' ||
      evidenceVerification.authenticity !== 'not-established' ||
      evidenceVerification.execution !== 'not-reexecuted' ||
      !validEvidenceValidation(evidenceVerification.validation) ||
      evidenceVerification.validation.witnessChecks.length !==
        evidencePlan.validation.witnessChecks.length
    )
      throw new Error(
        'The installed evidence verifier did not preserve its recorded validation limits.',
      );
    const clientContext = runCli(
      ['understand', join(installedRoot, 'examples/client-evidence-gap'), '--json'],
      'Installed client-context projection',
    );
    // Each CLI invocation captures source metadata again. Compare stable declarations and
    // selected content, not full snapshot commitments that include those capture timestamps.
    const contentManifest = (snapshot) =>
      Array.isArray(snapshot?.evidenceManifest)
        ? snapshot.evidenceManifest
            .map(({ id, sha256, byteLength, coverage }) => ({ id, sha256, byteLength, coverage }))
            .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        : null;
    if (
      clientContext.format !== 'investigator-client-context-v1' ||
      clientContext.scope !== 'selected-sources-only' ||
      clientContext.authenticity !== 'not-established' ||
      !/^[a-f0-9]{64}$/.test(clientContext.digest ?? '') ||
      JSON.stringify(clientContext.context) !== JSON.stringify(evidencePlan.context?.context) ||
      contentManifest(clientContext) === null ||
      JSON.stringify(contentManifest(clientContext)) !==
        JSON.stringify(contentManifest(evidencePlan.context)) ||
      !Array.isArray(clientContext.context?.entities) ||
      clientContext.context.entities.length === 0 ||
      !Array.isArray(clientContext.context.assertions) ||
      clientContext.context.assertions.length === 0 ||
      !Array.isArray(clientContext.context.sources) ||
      clientContext.context.sources.length === 0
    )
      throw new Error(
        'The installed client-context projection is missing its sourced model or scope.',
      );
    const assuranceDirectory = join(scratch, 'assurance');
    const assurance = runCli(
      ['assurance-demo', '--out', assuranceDirectory, '--json'],
      'Installed assurance-change demonstration',
    );
    if (
      assurance.format !== 'investigator-assurance-demo-v1' ||
      assurance.checkpoint?.evidencePlan?.assessments?.safeAfter?.verdict !== 'supported' ||
      !Array.isArray(assurance.cases) ||
      assurance.cases.length !== 5 ||
      new Set(assurance.cases.map((item) => item.id)).size !== 5
    )
      throw new Error(
        'The installed assurance demonstration lacks its historical checkpoint or five cases.',
      );
    const changeCases = new Map(assurance.cases.map((item) => [item.id, item.report]));
    const setting = changeCases.get('runtime-setting');
    const toolChange = changeCases.get('tool-definition');
    const policyChange = changeCases.get('policy-change');
    const unmapped = changeCases.get('unmapped-tool');
    const notes = changeCases.get('unrelated-document');
    const expectedPlannedChecks = ['permitted', 'wrong-request'];
    const expectedExecutedChecks = ['no-approval', 'permitted', 'self-approval', 'wrong-request'];
    if (
      !setting ||
      !toolChange ||
      !policyChange ||
      !unmapped ||
      !notes ||
      assurance.cases.some(
        (item) =>
          item.report?.checkpoint?.digest !== assurance.checkpoint.digest ||
          !Array.isArray(item.report.investigation?.checks) ||
          item.report.investigation.checks.length !== 4 ||
          item.report.investigation.checks.some(
            (check) => check.historicalVerdict !== 'supported' || check.currentVerdict !== null,
          ),
      ) ||
      setting.retestStatus !== 'completed' ||
      setting.retest?.assessment?.verdict !== 'contradicted' ||
      setting.investigation.retestPlan.blocked !== false ||
      JSON.stringify(setting.investigation.retestPlan.checkIds) !==
        JSON.stringify(expectedPlannedChecks) ||
      JSON.stringify(
        setting.investigation.checks
          .filter((check) => check.validity === 'stale')
          .map((check) => check.id)
          .sort(),
      ) !== JSON.stringify(expectedPlannedChecks) ||
      JSON.stringify(setting.retest.requiredChecks) !== JSON.stringify(expectedPlannedChecks) ||
      JSON.stringify(setting.retest.executedChecks) !== JSON.stringify(expectedExecutedChecks) ||
      [toolChange, policyChange].some(
        (item) =>
          item.investigation.retestPlan.profileReviewRequired !== true ||
          item.investigation.retestPlan.blocked !== true ||
          item.retest !== null ||
          item.retestStatus !== 'blocked',
      ) ||
      unmapped.investigation.checks.some((check) => check.validity !== 'unknown') ||
      unmapped.investigation.retestPlan.blocked !== true ||
      unmapped.retest !== null ||
      notes.investigation.checks.some(
        (check) => check.validity !== 'unchanged-recorded-dependencies',
      ) ||
      !notes.investigation.changes.some(
        (change) => change.disposition === 'out-of-declared-scope',
      ) ||
      notes.retest !== null ||
      notes.retestStatus !== 'not-needed'
    )
      throw new Error(
        'Installed assurance changes did not preserve history, semantic review or bounded fresh-retest outcomes.',
      );
    const assuranceVerification = runCli(
      ['verify-assurance', join(assuranceDirectory, 'demo.json'), '--json'],
      'Installed assurance-record verification',
    );
    if (
      assuranceVerification.integrity !== 'consistent-with-supplied-records' ||
      assuranceVerification.authenticity !== 'not-established' ||
      assuranceVerification.execution !== 'not-reexecuted'
    )
      throw new Error(
        'The installed assurance verifier did not preserve its supplied-record limits.',
      );
    const mcpDirectory = join(installedRoot, 'examples/mcp-export');
    const mcpSelection = JSON.parse(await readFile(join(mcpDirectory, 'mcp-source.json'), 'utf8'));
    const mcpImport = runCli(['import-mcp', mcpDirectory, '--json'], 'Installed saved MCP import');
    const importedTools = mcpImport.snapshot?.context?.entities?.filter(
      (entity) => entity.ref.kind === 'tool',
    );
    if (
      mcpImport.format !== 'investigator-mcp-import-v1' ||
      !Array.isArray(mcpImport.dependencies) ||
      mcpImport.dependencies.length !== 2 ||
      new Set(mcpImport.dependencies.map((dependency) => dependency.id)).size !== 2 ||
      mcpImport.dependencies.some(
        (dependency) =>
          dependency.kind !== 'tool-definition' || !/^mcp-tool:[a-f0-9]{64}$/.test(dependency.id),
      ) ||
      !Array.isArray(importedTools) ||
      importedTools.length !== 2 ||
      importedTools.some(
        (entity) =>
          entity.ref.sourceId !== mcpSelection.sourceId ||
          entity.ref.tenant !== mcpSelection.tenant,
      ) ||
      mcpImport.snapshot.scope !== 'selected-sources-only' ||
      mcpImport.snapshot.authenticity !== 'not-established' ||
      mcpImport.snapshot.context.sources.length !== 1 ||
      mcpImport.snapshot.context.sources[0].id !== mcpSelection.sourceId ||
      mcpImport.snapshot.context.sources[0].coverage !== 'partial' ||
      !Array.isArray(mcpImport.snapshot.context.assertions) ||
      mcpImport.snapshot.context.assertions.length !== 2 ||
      mcpImport.snapshot.context.assertions.some(
        (assertion) =>
          assertion.relation !== 'EXPOSES' ||
          assertion.basis !== 'configured' ||
          assertion.observedAt !== null ||
          assertion.assessment !== 'unresolved',
      ) ||
      !Array.isArray(mcpImport.frontier) ||
      !mcpImport.frontier.some((item) => item.includes('runtime permissions'))
    )
      throw new Error(
        'The installed saved MCP importer lost source identity, partial coverage or its non-execution boundary.',
      );
    const regression = runCli(
      ['evaluate', '--cases', '12', '--json'],
      'Installed authored regressions',
    );
    if (
      regression.mode !== 'deterministic-regression-not-model-quality' ||
      regression.cancelled !== false ||
      regression.totals?.cases !== 12 ||
      regression.totals?.passed !== 12 ||
      regression.totals?.failed !== 0
    )
      throw new Error('The installed package did not pass all twelve authored regressions.');
    const exported = parseJsonOutput(
      execute(
        process.execPath,
        [
          '--input-type=module',
          '--eval',
          `const library = await import(${JSON.stringify(metadata.name)});\nconst names = ${JSON.stringify(LIBRARY_FUNCTIONS)};\nif (names.some((name) => typeof library[name] !== 'function')) throw new Error('Missing public function');\nconsole.log(JSON.stringify({ checkedExports: names.length }));`,
        ],
        consumer,
        env,
        'Installed public exports',
      ),
      'Installed public exports',
    );
    if (exported.checkedExports !== LIBRARY_FUNCTIONS.length)
      throw new Error('The installed public export check is incomplete.');
    if (includeIndependent) {
      const independent = parseJsonOutput(
        execute(
          process.execPath,
          [join(installedRoot, 'scripts/independent-demo.mjs'), join(scratch, 'independent')],
          consumer,
          env,
          'Installed independent application',
        ),
        'Installed independent application',
      );
      if (
        independent.mode !== 'scripted' ||
        independent.unchangedExpectations !== true ||
        independent.before?.checks?.[1]?.status !== 'FAIL' ||
        independent.after?.checks?.length !== 3 ||
        !independent.after.checks.every((check) => check.status === 'PASS')
      )
        throw new Error(
          'The installed independent application did not reproduce the expected observations.',
        );
    }
    const bytes = await readFile(tarball);
    const report = {
      format: 'investigator-release-artifact-v1',
      createdAt: new Date().toISOString(),
      package: { name: metadata.name, version: metadata.version },
      artifact: { filename: item.filename, bytes: bytes.length, sha256: sha256(bytes) },
      runtime: { node: process.version, platform: process.platform },
      checks: {
        packageInventory: 'PASS',
        isolatedInstallation: 'PASS',
        installedCancellation: {
          status: 'PASS',
          sourceBoundRepair: true,
          unchangedWorkload: true,
          independentWorkBefore: true,
          independentWorkAfter: true,
          preCutWorkPreserved: true,
          contentCanaryAbsent: true,
        },
        installedCancellationVerification: 'PASS',
        installedCancellationTrials: {
          status: 'PASS',
          mode: cancellationTrials.mode,
          cases: 3,
          correct: 3,
          unsupportedConclusions: 0,
          expectedVerdicts: cancellationExpectedVerdicts,
        },
        installedCancellationTrialVerification: 'PASS',
        installedRepair: 'PASS',
        installedRepairVerification: 'PASS',
        installedClientUnderstanding: 'PASS',
        installedEvidencePlan: {
          status: 'PASS',
          witnessRemovalChecks: evidencePlan.validation.witnessChecks.length,
        },
        installedEvidenceVerification: 'PASS',
        installedAssuranceChanges: {
          status: 'PASS',
          cases: 5,
          plannedChecks: expectedPlannedChecks.length,
          executedChecks: expectedExecutedChecks.length,
        },
        installedAssuranceVerification: 'PASS',
        installedSavedMcpImport: {
          status: 'PASS',
          tools: 2,
          coverage: 'partial',
          execution: 'not-established',
        },
        installedRegressions: { status: 'PASS', cases: 12 },
        publicExports: { status: 'PASS', count: LIBRARY_FUNCTIONS.length },
        installedIndependentApplication: includeIndependent ? 'PASS' : 'NOT_RUN',
      },
      inventory,
      limitations: [
        'Scripted authored regressions do not establish live Meta model quality.',
        'The consumer installs public runtime dependencies from npm; this is not an offline install.',
        'This local result does not establish hosted CI, independent human review, or publication.',
        'SHA256SUMS establishes consistency with these supplied hashes, not trusted authorship.',
      ],
    };
    if (outputDirectory) {
      // Reserve a new owned directory. Never overwrite an existing artifact set.
      const destination = resolve(outputDirectory);
      await mkdir(destination, { mode: 0o700 });
      await copyFile(tarball, join(destination, item.filename));
      const manifest = `${JSON.stringify(report, null, 2)}\n`;
      await writeFile(join(destination, 'release-artifact.json'), manifest, { flag: 'wx' });
      await writeFile(
        join(destination, 'SHA256SUMS'),
        `${report.artifact.sha256}  ${item.filename}\n${sha256(manifest)}  release-artifact.json\n`,
        { flag: 'wx' },
      );
    }
    return report;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

async function main() {
  const args = process.argv.slice(2);
  let outputDirectory;
  let includeIndependent = false;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--out' && !outputDirectory && args[index + 1])
      outputDirectory = args[++index];
    else if (args[index] === '--independent' && !includeIndependent) includeIndependent = true;
    else
      throw new Error('Usage: node scripts/packed-smoke.mjs [--out new-directory] [--independent]');
  }
  const report = await runPackedSmoke({
    ...(outputDirectory ? { outputDirectory } : {}),
    includeIndependent,
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'Packed smoke failed.'}\n`);
    process.exitCode = 1;
  });
}
