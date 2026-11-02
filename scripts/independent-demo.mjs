import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createHttpApprovalTarget,
  createMetaProvider,
  renderCaseHtml,
  verifyCaseReport,
} from '../dist/index.js';
import { startIndependentObserver } from '../examples/independent-export-service/observer.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const example = join(root, 'examples', 'independent-export-service');
const arguments_ = process.argv.slice(2);
const live = arguments_.includes('--live');
const directories = arguments_.filter((value) => value !== '--live');
const modelEnvironment = {};
const children = new Set();
let interrupted = false;
const cancel = () => {
  interrupted = true;
  for (const child of children) child.kill('SIGTERM');
};
process.once('SIGINT', cancel);
process.once('SIGTERM', cancel);
function track(child) {
  children.add(child);
  child.once('close', () => children.delete(child));
  return child;
}
if (live)
  for (const name of [
    'META_API_KEY',
    'MODEL_API_KEY',
    'MODEL_ID',
    'MODEL_BASE_URL',
    'MODEL_REASONING_EFFORT',
  ])
    if (process.env[name] !== undefined) modelEnvironment[name] = process.env[name];
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
const digest = (value) => createHash('sha256').update(canonical(value)).digest('hex');
const secret = () => randomBytes(32).toString('hex');

async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((done) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      done();
    }, 1500);
    child.once('exit', () => {
      clearTimeout(timer);
      done();
    });
    child.kill('SIGTERM');
  });
}

async function startPython(directory, env) {
  const child = track(
    spawn('python3', [join(directory, 'service.py')], {
      cwd: directory,
      env: { PATH: process.env.PATH ?? '', ...env },
      stdio: ['ignore', 'pipe', 'ignore'],
    }),
  );
  try {
    const identity = await new Promise((done, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(new Error('Python fixture readiness timeout')), 5000);
      const fail = () => {
        clearTimeout(timer);
        reject(new Error('Python standard library fixture did not start'));
      };
      child.once('error', fail);
      child.once('exit', fail);
      child.stdout.on('data', (chunk) => {
        output += chunk.toString('utf8');
        if (output.length > 4096) return fail();
        if (!output.includes('\n')) return;
        try {
          const value = JSON.parse(output.split('\n')[0]);
          if (
            !Number.isInteger(value.port) ||
            value.port < 1 ||
            value.port > 65535 ||
            !/^[a-f0-9]{64}$/.test(value.subjectRevision)
          )
            return fail();
          clearTimeout(timer);
          child.off('error', fail);
          child.off('exit', fail);
          done(value);
        } catch {
          fail();
        }
      });
    });
    return { child, ...identity };
  } catch (error) {
    await stop(child);
    throw error;
  }
}

async function cli(args, env) {
  const child = track(
    spawn(process.execPath, [join(root, 'dist', 'bin.js'), ...args], {
      cwd: root,
      env: { PATH: process.env.PATH ?? '', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
  );
  try {
    return await new Promise((done, reject) => {
      let size = 0;
      const timer = setTimeout(
        () => {
          child.kill('SIGTERM');
          reject(new Error('Bounded CLI demo timeout'));
        },
        live ? 200000 : 30000,
      );
      const consume = (chunk) => {
        size += chunk.length;
        if (size > 4_194_304) {
          child.kill('SIGTERM');
          reject(new Error('Bounded CLI output exceeded'));
        }
      };
      child.stdout.on('data', consume);
      child.stderr.on('data', consume);
      child.once('error', () => {
        clearTimeout(timer);
        reject(new Error('Built CLI could not start'));
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        done(code);
      });
    });
  } finally {
    await stop(child);
  }
}

function expectations(report) {
  return report.run.checks.map((check) => ({
    id: check.id,
    observations: check.observations.map(({ scenario, attempt, expectation }) => ({
      scenario,
      attempt,
      expectation,
    })),
  }));
}

async function runMode(output, label, exactRequestBinding) {
  const directory = join(output, label);
  const app = join(directory, 'application');
  const caseDirectory = join(directory, 'case');
  await mkdir(directory, { mode: 0o700 });
  await mkdir(app, { mode: 0o700 });
  await mkdir(caseDirectory, { mode: 0o700 });
  await copyFile(join(example, 'service.py'), join(app, 'service.py'));
  await writeFile(join(app, 'authorization.json'), `${JSON.stringify({ exactRequestBinding })}\n`, {
    flag: 'wx',
    mode: 0o600,
  });
  const source = Object.fromEntries(
    await Promise.all(
      ['service.py', 'authorization.json'].map(async (name) => [
        name,
        await readFile(join(app, name), 'utf8'),
      ]),
    ),
  );
  const revision = digest(source);
  const env = {
    INDEPENDENT_TARGET_KEY: secret(),
    INDEPENDENT_ADMIN_KEY: secret(),
    INDEPENDENT_OBSERVER_KEY: secret(),
  };
  const observer = await startIndependentObserver({
    subjectRevision: revision,
    credential: env.INDEPENDENT_OBSERVER_KEY,
  });
  let target;
  try {
    target = await startPython(app, {
      INDEPENDENT_TARGET_KEY: env.INDEPENDENT_TARGET_KEY,
      INDEPENDENT_ADMIN_KEY: env.INDEPENDENT_ADMIN_KEY,
      INDEPENDENT_OBSERVER_URL: observer.baseUrl,
    });
    if (target.subjectRevision !== revision)
      throw new Error('Python fixture source revision mismatch');
    const config = {
      kind: 'http-approval-target',
      schemaVersion: 1,
      fixtureProtocol: 'approval-target-v1',
      subjectRevision: revision,
      target: {
        baseUrl: `http://127.0.0.1:${target.port}`,
        credentialEnv: 'INDEPENDENT_TARGET_KEY',
        adminCredentialEnv: 'INDEPENDENT_ADMIN_KEY',
      },
      observer: { baseUrl: observer.baseUrl, credentialEnv: 'INDEPENDENT_OBSERVER_KEY' },
      allowLoopbackHttp: true,
      timeoutMs: 3000,
      maxResponseBytes: 262144,
    };
    const adapter = createHttpApprovalTarget(config, env);
    const configPath = join(directory, 'target.json');
    await writeFile(configPath, JSON.stringify(config, null, 2), { flag: 'wx', mode: 0o600 });
    const original = JSON.parse(
      await readFile(join(root, 'examples', 'customer-export', 'case.json'), 'utf8'),
    );
    delete original.referenceTarget;
    original.id = `independent-python-export-${label}`;
    original.subject = { id: 'independent-python-export', environment: 'repository', revision };
    original.controlledTarget = {
      kind: adapter.id,
      version: adapter.version,
      configurationDigest: adapter.configurationDigest,
    };
    for (const sourceFile of original.sources)
      await copyFile(
        join(root, 'examples', 'customer-export', sourceFile.path),
        join(caseDirectory, sourceFile.path),
      );
    for (const name of ['service.py', 'authorization.json']) {
      await copyFile(join(app, name), join(caseDirectory, name));
      original.sources.push({
        id: name === 'service.py' ? 'application-source' : 'application-policy',
        path: name,
        mediaType: name.endsWith('.json') ? 'application/json' : 'text/plain',
        coverage: 'complete',
        redacted: false,
      });
    }
    await writeFile(join(caseDirectory, 'case.json'), JSON.stringify(original, null, 2), {
      flag: 'wx',
      mode: 0o600,
    });
    const reportPath = join(directory, 'report.json');
    const exitCode = await cli(
      [
        'investigate',
        caseDirectory,
        '--target-config',
        configPath,
        ...(live ? [] : ['--scripted']),
        '--out',
        reportPath,
        '--json',
      ],
      { ...env, ...modelEnvironment },
    );
    if (exitCode !== (exactRequestBinding ? 0 : 1))
      throw new Error('The CLI did not establish the expected independent fixture outcome');
    const report = verifyCaseReport(JSON.parse(await readFile(reportPath, 'utf8')));
    for (const value of Object.values(env))
      if (JSON.stringify(report).includes(value))
        throw new Error('Private credential appeared in a report');
    for (const name of ['META_API_KEY', 'MODEL_API_KEY'])
      if (modelEnvironment[name] && JSON.stringify(report).includes(modelEnvironment[name]))
        throw new Error('Private credential appeared in a report');
    await writeFile(join(directory, 'report.html'), renderCaseHtml(report), {
      flag: 'wx',
      mode: 0o600,
    });
    return { report, reportPath, revision };
  } finally {
    await stop(target?.child);
    await observer.close();
  }
}

try {
  if (
    directories.length > 1 ||
    directories.some((value) => value.startsWith('--')) ||
    arguments_.filter((value) => value === '--live').length > 1
  )
    throw new Error('Use independent-demo.mjs [--live] [new-output-directory]');
  if (live) createMetaProvider(modelEnvironment);
  const output = directories[0]
    ? resolve(directories[0])
    : await mkdtemp(join(tmpdir(), 'investigator-independent-'));
  if (directories[0]) await mkdir(output, { mode: 0o700 });
  const before = await runMode(output, 'before', false);
  if (interrupted) throw new Error('Cancelled');
  const after = await runMode(output, 'after', true);
  const unchanged =
    canonical(expectations(before.report)) === canonical(expectations(after.report));
  const passed = after.report.run.checks.every((check) => check.status === 'PASS');
  if (!unchanged || !passed || before.revision === after.revision)
    throw new Error('Unchanged checks and distinct revision proof required');
  const summary = {
    demo: 'independent-python-http-target',
    provider: before.report.run.provider.id,
    mode: before.report.run.provider.mode,
    model: before.report.run.provider.model,
    scope: 'trusted-authored-loopback-fixture',
    change: 'Operator-authored authorization.json: exactRequestBinding false -> true',
    unchangedExpectations: unchanged,
    before: {
      revision: before.revision,
      checks: before.report.run.checks.map(({ id, status }) => ({ id, status })),
      report: before.reportPath,
    },
    after: {
      revision: after.revision,
      checks: after.report.run.checks.map(({ id, status }) => ({ id, status })),
      report: after.reportPath,
    },
    limitation: 'Synthetic sink effects only; no production attestation or OS sandbox claim.',
  };
  await writeFile(join(output, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, {
    flag: 'wx',
    mode: 0o600,
  });
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
} catch {
  process.stderr.write(
    'Independent fixture demo failed. Build the package, ensure python3 is installed, and choose a new output directory. No successful outcome was recorded.\n',
  );
  process.exitCode = 2;
} finally {
  process.removeListener('SIGINT', cancel);
  process.removeListener('SIGTERM', cancel);
}
