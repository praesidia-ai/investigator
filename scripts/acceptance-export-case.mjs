// Acceptance scenario P2: static (Jurator ts-export-control) stays green while the runtime export promise is
// contradicted by an independent destination. Runs offline: no model calls, 127.0.0.1 only, ephemeral ports.
// Usage: node scripts/acceptance-export-case.mjs [--json] [--keep]   (needs `npm run build` in this repo and jurator/)
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startIndependentObserver } from '../examples/independent-export-service/observer.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const EXAMPLE = join(ROOT, 'examples', 'staged-export-workflow');
const INV = join(ROOT, 'dist', 'bin.js');
const JUR = join(ROOT, 'jurator', 'dist');
const ANALYZER = join(ROOT, 'jurator', 'analyzers', 'ts-export-control', 'dist', 'index.js');
const VARIANTS = [
  { id: 'unrepaired', patch: null },
  { id: 'exact-request-binding', patch: 'exact-request-binding.patch' },
  { id: 'destination-allowlist-overblocking', patch: 'destination-allowlist-overblocking.patch' },
];
const RULE = {
  guards: [
    {
      module: 'src/access',
      symbol: 'assertAccess',
      subjectArg: 0,
      tenantArg: 1,
      resourceArg: 2,
      style: 'throws',
      async: true,
    },
  ],
  effects: [{ module: 'src/exporter', symbol: 'exportData', tenantArg: 0, resourceArg: 1 }],
  routeRegistrars: ['post'],
  routeObjects: ['router'],
};
const canonical = (v) =>
  Array.isArray(v)
    ? `[${v.map(canonical).join(',')}]`
    : v && typeof v === 'object'
      ? `{${Object.keys(v)
          .sort()
          .map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`)
          .join(',')}}`
      : JSON.stringify(v);
const sha = (t) => createHash('sha256').update(t, 'utf8').digest('hex');
const secret = () => randomBytes(32).toString('hex');
const children = new Set();

function sh(cmd, args, cwd, env = {}) {
  const r = spawnSync(cmd, args, {
    cwd,
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '', ...env },
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
const must = (r, expect, what) => {
  if (!expect.includes(r.code))
    throw new Error(`${what} failed (${r.code}): ${r.err.slice(0, 400)}`);
  return r.out;
};
// Async because the target and observer share this process's event loop with nothing blocking them.
function runAsync(cmd, args, cwd, env) {
  return new Promise((done) => {
    const c = spawn(cmd, args, { cwd, env: { PATH: process.env.PATH ?? '', ...env } });
    children.add(c);
    let out = '',
      err = '';
    c.stdout.on('data', (d) => (out += d));
    c.stderr.on('data', (d) => (err += d));
    c.once('close', (code) => (children.delete(c), done({ code, out, err })));
  });
}
async function startService(app, env) {
  const c = spawn(process.execPath, [join(EXAMPLE, 'server.mjs'), app], {
    cwd: app,
    env: { PATH: process.env.PATH ?? '', ...env },
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  children.add(c);
  const info = await new Promise((ok, no) => {
    const t = setTimeout(() => no(new Error('service readiness timeout')), 8000);
    let buf = '';
    c.once('exit', () => no(new Error('service exited early')));
    c.stdout.on('data', (d) => {
      buf += d;
      if (buf.includes('\n')) (clearTimeout(t), ok(JSON.parse(buf.split('\n')[0])));
    });
  });
  return { child: c, ...info };
}
const stop = (c) =>
  new Promise((done) => {
    if (!c || c.exitCode !== null) return done();
    const t = setTimeout(() => c.kill('SIGKILL'), 1500);
    c.once('exit', () => (clearTimeout(t), done()));
    c.kill('SIGTERM');
  });

async function revisionOf(app) {
  const dir = join(app, 'src');
  const files = (await readdir(dir)).sort();
  return sha(
    canonical(
      Object.fromEntries(
        await Promise.all(files.map(async (f) => [f, await readFile(join(dir, f), 'utf8')])),
      ),
    ),
  );
}

const git = (work, args) =>
  must(
    sh(
      'git',
      ['-c', 'user.name=acceptance', '-c', 'user.email=acceptance@example.invalid', ...args],
      work,
    ),
    [0],
    `git ${args[0]}`,
  );

/**
 * A real Jurator workspace: the service sources are committed, a semantic rule (ts-export-control, guard-before-effect)
 * is accepted after a real sensitivity proof (the same rule must FAIL on a copy with the guard call deleted), and
 * `jurator check --no-ai` produces the saved run that the export reads. Returns that run's id and the code-check result.
 */
async function codeCheckViaJurator(app, work) {
  const rules = await import(pathToFileURL(join(JUR, 'rules/index.js')).href);
  const { initWorkspace } = await import(pathToFileURL(join(JUR, 'workspace/index.js')).href);
  const { DEFAULT_CONFIG } = await import(pathToFileURL(join(JUR, 'contracts.js')).href);
  await mkdir(join(work, 'src'));
  await cp(join(app, 'src'), join(work, 'src'), { recursive: true });
  const policy =
    '# Security\n\n1. Customer data exports require an independent approval bound to the exact request.\n';
  const at = '2026-11-05T09:00:00.000Z';
  const files = await Promise.all(
    (await readdir(join(work, 'src')))
      .sort()
      .map(async (f) => ({ path: `src/${f}`, text: await readFile(join(work, 'src', f), 'utf8') })),
  );
  const routes = files.find((f) => f.path === 'src/routes.ts').text;
  const guard = 'await assertAccess(req, tenant, dataset);';
  if (!routes.includes(guard)) throw new Error('guard line not found');
  const mutant = files.map((f) =>
    f.path === 'src/routes.ts' ? { ...f, text: routes.replace(guard, '// guard removed') } : f,
  );
  const rule = {
    id: 'R-security.01-export-guard',
    promiseId: 'security.01',
    description: 'Every export route checks access for the same tenant before exporting',
    mode: 'semantic',
    pattern: 'guard-before-effect',
    // The worker and the synthetic /ping route stay outside the rule; a route reaching the worker directly is a gap.
    globs: ['src/routes.ts', 'src/access.ts', 'src/exporter.ts', 'src/http.ts', 'src/state.ts'],
    provenBy: null,
    status: 'accepted',
    author: 'human',
    createdAt: at,
    semantic: {
      adapter: 'ts-export-control',
      adapterVersion: '0.1.0',
      control: 'guard-before-effect',
      config: RULE,
    },
  };
  await rules.loadSemanticAdapters([rule]);
  const commit = 'c'.repeat(40);
  const kept = rules.runRule(rule, files, commit);
  const broken = rules.runRule(rule, mutant, commit);
  if (kept.outcome !== 'pass') throw new Error(`semantic rule not green: ${kept.message}`);
  if (broken.outcome !== 'fail')
    throw new Error(`semantic rule did not catch the deleted guard: ${broken.outcome}`);
  rule.provenBy = {
    mutation: 'deleted the assertAccess call in src/routes.ts; the rule then failed',
    failedAsExpected: true,
    at,
  };

  must(sh('git', ['init', '-q', '-b', 'main'], work), [0], 'git init');
  await writeFile(join(work, '.gitignore'), '.jurator/local/\n');
  git(work, ['add', 'src', '.gitignore']);
  git(work, ['commit', '-q', '-m', 'staged export service']);
  const store = await initWorkspace(work, {
    ...DEFAULT_CONFIG,
    sources: [{ alias: 'security', connector: 'file', locator: 'docs/security.md' }],
  });
  const src = { alias: 'security', connector: 'file', locator: 'docs/security.md' };
  const textPath = await store.saveSourceText({
    ...src,
    mediaType: 'text/markdown',
    text: policy,
    sha256: sha(policy),
    fetchedAt: at,
  });
  await store.writeLock([{ ...src, sha256: sha(policy), fetchedAt: at, textPath }]);
  const wording =
    'Customer data exports require an independent approval bound to the exact request.';
  const quote = { alias: 'security', policySha256: sha(policy), text: wording, line: 3 };
  await store.writePromises('security', [
    {
      id: 'security.01',
      status: 'accepted',
      wording,
      quote,
      kind: 'must',
      checkable: 'code',
      scope: [],
      foundBy: 'human',
      firstSeen: at,
    },
  ]);
  await store.writeRules([rule]);
  const r = sh(process.execPath, [join(JUR, 'bin.js'), 'check', '--no-ai', '--json'], work, {
    META_API_KEY: '',
    MODEL_API_KEY: '',
  });
  if (![0, 1].includes(r.code))
    throw new Error(`jurator check exited ${r.code}: ${r.err.slice(0, 400)}`);
  const run = JSON.parse(r.out);
  const res = run.results.find((x) => x.promiseId === 'security.01');
  if (res?.verdict !== 'holds' || res.level !== 'rule')
    throw new Error(`jurator check did not hold: ${res?.verdict}/${res?.level}`);
  return {
    runId: run.id,
    verdict: res.verdict,
    level: res.level,
    proof: rule.provenBy.mutation,
    routes: res.ruleResults?.[0]?.message ?? '',
  };
}

async function runVariant(base, variant) {
  const dir = join(base, variant.id);
  const app = join(dir, 'app');
  await mkdir(dir);
  await cp(join(EXAMPLE, 'base'), app, { recursive: true });
  if (variant.patch)
    must(
      sh('patch', ['-p1', '-s', '-i', join(EXAMPLE, 'patches', variant.patch)], app),
      [0],
      'apply reviewed patch',
    );
  const revision = await revisionOf(app);
  const env = {
    STAGED_TARGET_KEY: secret(),
    STAGED_ADMIN_KEY: secret(),
    STAGED_OBSERVER_KEY: secret(),
  };
  const observer = await startIndependentObserver({
    subjectRevision: revision,
    credential: env.STAGED_OBSERVER_KEY,
  });
  let service;
  try {
    service = await startService(app, {
      STAGED_TARGET_KEY: env.STAGED_TARGET_KEY,
      STAGED_ADMIN_KEY: env.STAGED_ADMIN_KEY,
      STAGED_OBSERVER_URL: observer.baseUrl,
    });
    if (service.subjectRevision !== revision) throw new Error('service revision mismatch');
    const target = {
      kind: 'http-approval-target',
      schemaVersion: 1,
      fixtureProtocol: 'approval-target-v1',
      subjectRevision: revision,
      target: {
        baseUrl: `http://127.0.0.1:${service.port}`,
        credentialEnv: 'STAGED_TARGET_KEY',
        adminCredentialEnv: 'STAGED_ADMIN_KEY',
      },
      observer: { baseUrl: observer.baseUrl, credentialEnv: 'STAGED_OBSERVER_KEY' },
      allowLoopbackHttp: true,
      timeoutMs: 3000,
      maxResponseBytes: 262144,
    };
    await writeFile(join(dir, 'target.json'), JSON.stringify(target, null, 2), { mode: 0o600 });
    await writeFile(
      join(dir, 'adapter.json'),
      JSON.stringify({
        kind: 'http-approval-target',
        schemaVersion: 1,
        adapterId: 'staged-export-http',
        targetConfig: 'target.json',
        targetConfigSha256: sha(await readFile(join(dir, 'target.json'), 'utf8')),
      }),
    );
    const profiles = JSON.parse(
      must(sh(process.execPath, [INV, 'interop-profiles', '--json'], ROOT), [0], 'profiles'),
    );
    const p = profiles.find((x) => x.id === 'customer-export-approval');
    await writeFile(
      join(dir, 'mapping.json'),
      JSON.stringify({
        profileId: p.id,
        profileVersion: p.version,
        requirementsDigest: p.requirementsDigest,
        reviewedBy: 'acceptance-reviewer',
        reviewedAt: '2026-11-05T09:30:00.000Z',
      }),
    );
    const work = join(dir, 'work');
    await mkdir(work);
    const check = await codeCheckViaJurator(app, work);
    const request = join(dir, 'request.json');
    const jur = (args, expect = [0]) =>
      must(
        sh(process.execPath, [join(JUR, 'bin.js'), ...args], work),
        expect,
        `jurator ${args[1]}`,
      );
    jur([
      'investigation',
      'export',
      'security.01',
      '--run',
      check.runId,
      '--mapping',
      join(dir, 'mapping.json'),
      '--tenant',
      'acme',
      '--workflow',
      'customer-export',
      '--env',
      'staging-local',
      '--window',
      '2026-11-04T00:00:00.000Z..2026-11-05T00:00:00.000Z',
      '--adapter',
      'staged-export-http',
      '--adapter-config',
      join(dir, 'adapter.json'),
      '--out',
      request,
    ]);
    const out = join(dir, 'investigated');
    const ran = await runAsync(
      process.execPath,
      [
        INV,
        'interop-run',
        request,
        '--adapter-config',
        join(dir, 'adapter.json'),
        '--out',
        out,
        '--json',
      ],
      ROOT,
      env,
    );
    if (![0, 1].includes(ran.code))
      throw new Error(`interop-run exited ${ran.code}: ${ran.err.slice(0, 400)}`);
    const result = JSON.parse(await readFile(join(out, 'result.json'), 'utf8'));
    must(
      sh(
        process.execPath,
        [INV, 'verify-interop', join(out, 'result.json'), '--request', request],
        ROOT,
      ),
      [0],
      'verify-interop',
    );
    const imported = JSON.parse(
      jur(['investigation', 'import', join(out, 'result.json'), '--json'], [0, 1, 2]),
    );
    jur(['investigation', 'verify', imported.id]);
    for (const v of Object.values(env))
      if (JSON.stringify([result, imported]).includes(v))
        throw new Error('credential leaked into evidence');
    const status = (id) => result.captures.find((c) => c.id === id)?.status;
    // Retest passes only when the mapped promise is supported AND the legitimate independently authorized work still runs.
    const retestPasses =
      result.behavioral.verdict === 'supported' && status('permitted-work') === 'PASS';
    return {
      retestPasses,
      variant: variant.id,
      patch: variant.patch,
      revision,
      exitCode: ran.code,
      codeCheck: {
        outcome: 'pass',
        via: 'jurator check --no-ai',
        verdict: check.verdict,
        level: check.level,
        proof: check.proof,
        detail: check.routes,
      },
      result,
      record: imported,
    };
  } finally {
    await stop(service?.child);
    await observer.close();
  }
}

export async function runAcceptance({ keep = false } = {}) {
  const base = await mkdtemp(join(tmpdir(), 'staged-export-'));
  const cancel = () => children.forEach((c) => c.kill('SIGKILL'));
  process.once('exit', cancel);
  try {
    const cases = [];
    for (const v of VARIANTS) cases.push(await runVariant(base, v));
    return { cases, dir: keep ? base : null };
  } finally {
    if (!keep) await rm(base, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { cases, dir } = await runAcceptance({ keep: process.argv.includes('--keep') });
    if (process.argv.includes('--json'))
      process.stdout.write(`${JSON.stringify({ cases, dir }, null, 2)}\n`);
    else
      for (const c of cases)
        console.log(
          `${c.variant}: code check ${c.record.codeCheck.verdict}; runtime ${c.result.behavioral.verdict}; mismatch ${c.result.mismatch?.kind ?? 'none'}; action ${c.result.proposedAction?.kind}`,
        );
  } catch (e) {
    process.stderr.write(`acceptance failed: ${e.message}\n`);
    process.exitCode = 2;
  }
}
