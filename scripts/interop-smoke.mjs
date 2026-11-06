// Clean-consumer proof for the Jurator <-> Investigator bridge: pack both packages, install the tarballs into an
// empty temp consumer, then export -> investigate (scripted-local adapter) -> import -> verify. No sibling paths.
// Usage: node scripts/interop-smoke.mjs [--offline]   (npm install fetches only the tarballs' dependencies)
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const offline = process.argv.includes('--offline');
const keep = process.argv.includes('--keep');

function run(cmd, args, cwd, expect = [0]) {
  const r = spawnSync(cmd, args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, FORCE_COLOR: '0', META_API_KEY: '', MODEL_API_KEY: '' },
  });
  if (!expect.includes(r.status))
    throw new Error(`${cmd} ${args.join(' ')} -> ${r.status}\n${r.stdout}\n${r.stderr}`);
  return r;
}
const assert = (ok, message) => {
  if (!ok) throw new Error(`smoke assertion failed: ${message}`);
};

const temp = await mkdtemp(join(tmpdir(), 'interop-smoke-'));
try {
  const tarballs = [];
  for (const dir of [ROOT, join(ROOT, 'jurator')]) {
    run('npm', ['run', 'build', '--silent'], dir);
    const dest = join(temp, 'tarballs');
    await mkdir(dest, { recursive: true });
    run('npm', ['pack', '--ignore-scripts', '--silent', '--pack-destination', dest], dir);
  }
  for (const name of await readdir(join(temp, 'tarballs')))
    tarballs.push(join(temp, 'tarballs', name));
  assert(tarballs.length === 2, 'expected two tarballs');

  const consumer = join(temp, 'consumer');
  await mkdir(consumer);
  await writeFile(
    join(consumer, 'package.json'),
    '{"name":"consumer","private":true,"type":"module"}\n',
  );
  run(
    'npm',
    [
      'install',
      '--no-audit',
      '--no-fund',
      '--ignore-scripts',
      ...(offline ? ['--offline'] : ['--prefer-offline']),
      ...tarballs,
    ],
    consumer,
  );
  const jurator = join(consumer, 'node_modules', '.bin', 'jurator');
  const inv = join(consumer, 'node_modules', '.bin', 'praesidia-investigator');

  // A workspace as `jurator pull/compile/accept/check` would leave it (written through the installed package, no model).
  const work = join(consumer, 'work');
  await mkdir(work);
  run('git', ['init', '-q'], work);
  await writeFile(
    join(consumer, 'seed.mjs'),
    `
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
const dist = (p) => pathToFileURL(join(process.argv[2], 'node_modules/jurator/dist', p)).href;
const { initWorkspace } = await import(dist('workspace/index.js'));
const { DEFAULT_CONFIG } = await import(dist('contracts.js'));
const sha = (t) => createHash('sha256').update(t, 'utf8').digest('hex');
const policy = '# Security\\n\\n1. Only workspace   admins can export\\ncustomer data.\\n';
const at = '2026-11-05T09:00:00.000Z';
const commit = 'b'.repeat(40);
const store = await initWorkspace(process.argv[3], { ...DEFAULT_CONFIG, sources: [{ alias: 'security', connector: 'file', locator: 'docs/security.md' }] });
const textPath = await store.saveSourceText({ alias: 'security', connector: 'file', locator: 'docs/security.md', mediaType: 'text/markdown', text: policy, sha256: sha(policy), fetchedAt: at });
await store.writeLock([{ alias: 'security', connector: 'file', locator: 'docs/security.md', sha256: sha(policy), fetchedAt: at, textPath }]);
const quote = { alias: 'security', policySha256: sha(policy), text: 'Only workspace admins can export customer data.', line: 3 };
await store.writePromises('security', [{ id: 'security.01', status: 'accepted', wording: quote.text, quote, kind: 'must', checkable: 'code', scope: [], foundBy: 'human', firstSeen: at }]);
await store.writeRun({ schemaVersion: 1, id: 'run-1', toolVersion: '0.1.0', createdAt: at, snapshot: { repo: process.argv[3], branch: 'main', commit, dirty: false }, target: { kind: 'repo', head: commit }, failMode: 'block', status: 'completed',
  results: [{ promiseId: 'security.01', wording: quote.text, verdict: 'holds', level: 'rule', citations: [{ path: 'src/export.ts', commit, startLine: 1, endLine: 1, quote: 'requireAdmin(req);' }], policyQuote: quote, ruleResults: [{ ruleId: 'R-1', promiseId: 'security.01', outcome: 'pass', hits: [], message: 'ok' }] }],
  checklist: [], summary: { promises: 1, checked: 1, holds: 1, broken: 0, looksKept: 0, looksBroken: 0, cantTell: 0, notChecked: 0, coveredByRules: 1, codePromises: 1 }, costUsd: 0, digest: 'a'.repeat(64) });
`,
  );
  run('node', [join(consumer, 'seed.mjs'), consumer, work], work);

  const profiles = JSON.parse(run(inv, ['interop-profiles', '--json'], consumer).stdout);
  const approval = profiles.find((p) => p.id === 'customer-export-approval');
  await writeFile(
    join(consumer, 'mapping.json'),
    JSON.stringify({
      profileId: approval.id,
      profileVersion: approval.version,
      requirementsDigest: approval.requirementsDigest,
      reviewedBy: 'smoke-reviewer',
      reviewedAt: '2026-11-05T09:30:00.000Z',
    }),
  );
  await writeFile(
    join(consumer, 'adapter.json'),
    JSON.stringify({
      kind: 'scripted-local',
      schemaVersion: 1,
      adapterId: 'scripted-reference',
      variant: 'request-unbound',
    }),
  );

  const request = join(consumer, 'request.json');
  run(
    jurator,
    [
      'investigation',
      'export',
      'security.01',
      '--run',
      'run-1',
      '--mapping',
      join(consumer, 'mapping.json'),
      '--tenant',
      'acme',
      '--workflow',
      'customer-export',
      '--env',
      'reference-test',
      '--window',
      '2026-11-04T00:00:00.000Z..2026-11-05T00:00:00.000Z',
      '--adapter',
      'scripted-reference',
      '--adapter-config',
      join(consumer, 'adapter.json'),
      '--out',
      request,
    ],
    work,
  );
  const out = join(consumer, 'investigated');
  const ran = run(
    inv,
    [
      'interop-run',
      request,
      '--adapter-config',
      join(consumer, 'adapter.json'),
      '--out',
      out,
      '--json',
    ],
    consumer,
    [1],
  );
  const result = JSON.parse(ran.stdout);
  assert(
    result.execution.status === 'completed' && result.behavioral.verdict === 'contradicted',
    'runtime contradicts',
  );
  assert(
    result.static.verdict === 'holds' &&
      result.mismatch?.kind === 'static-pass-runtime-contradicted',
    'static pass kept beside runtime contradiction',
  );
  run(inv, ['verify-interop', join(out, 'result.json'), '--request', request], consumer);
  const imported = run(
    jurator,
    ['investigation', 'import', join(out, 'result.json'), '--json'],
    work,
    [1],
  );
  const record = JSON.parse(imported.stdout);
  assert(
    record.codeCheck.verdict === 'holds' && record.behavioral.verdict === 'contradicted',
    'linked record keeps both',
  );
  run(jurator, ['investigation', 'verify', record.id], work);
  console.log(
    `interop smoke ok: ${record.id} (code check holds, runtime contradicted, mismatch preserved)`,
  );
} finally {
  if (keep) console.log(`kept ${temp}`);
  else await rm(temp, { recursive: true, force: true });
}
