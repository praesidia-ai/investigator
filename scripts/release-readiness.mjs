import { lstat, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PACKAGE_ROOT = fileURLToPath(new URL('../', import.meta.url));
const DOCUMENTS = [
  'README.md',
  'CONTRIBUTING.md',
  'SECURITY.md',
  'CHANGELOG.md',
  'LICENSE',
  'NOTICE',
  'docs/RELEASING.md',
  'docs/INDEPENDENT-TRIAL.md',
  'docs/CANCELLATION.md',
];

function gate(id, status, detail) {
  return { id, status, detail };
}

/** A local inspection never promotes unobserved external release gates to PASS. */
export async function buildReadinessReport({ packageRoot = PACKAGE_ROOT } = {}) {
  const gates = [];
  let metadata;
  try {
    metadata = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
    const valid =
      typeof metadata.name === 'string' &&
      /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(metadata.name) &&
      typeof metadata.version === 'string' &&
      /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(metadata.version) &&
      metadata.license === 'Apache-2.0' &&
      metadata.type === 'module' &&
      metadata.engines?.node === '>=22.12.0' &&
      metadata.bin?.['praesidia-investigator'] === 'dist/bin.js' &&
      metadata.exports?.['.']?.import === './dist/index.js';
    gates.push(
      gate(
        'package_metadata',
        valid ? 'PASS' : 'FAIL',
        valid
          ? 'Expected package, ESM, license, runtime, CLI and library metadata are present.'
          : 'Required package metadata does not match the supported release contract.',
      ),
    );
    const independent = Object.values(metadata.dependencies ?? {}).every(
      (version) =>
        typeof version === 'string' && !/^(?:file:|link:|workspace:|\.{1,2}\/|\/)/.test(version),
    );
    gates.push(
      gate(
        'independent_runtime_dependencies',
        independent ? 'PASS' : 'FAIL',
        independent
          ? 'Runtime dependency declarations contain no local checkout dependencies.'
          : 'A runtime dependency resolves to a local checkout or has an invalid declaration.',
      ),
    );
    const repository =
      typeof metadata.repository === 'string' ? metadata.repository : metadata.repository?.url;
    gates.push(
      gate(
        'maintainer_repository_identity',
        typeof repository === 'string' && /^https:\/\/[^\s]+$/.test(repository)
          ? 'PASS'
          : 'PENDING',
        typeof repository === 'string' && /^https:\/\/[^\s]+$/.test(repository)
          ? 'A maintainer-supplied HTTPS repository is declared; remote existence was not checked.'
          : 'The maintainer repository URL has not been supplied.',
      ),
    );
    gates.push(
      gate(
        'publication_authorization',
        'PENDING',
        metadata.private === true
          ? 'private:true prevents npm publication, not public GitHub source. The GitHub destination and completed publication have not been observed by this inspector.'
          : 'Publishable metadata does not supply authorization to publish.',
      ),
    );
  } catch {
    gates.push(
      gate('package_metadata', 'FAIL', 'Package metadata is unavailable or invalid JSON.'),
    );
  }
  const missing = [];
  for (const document of DOCUMENTS) {
    const stat = await lstat(join(packageRoot, document)).catch(() => null);
    if (!stat?.isFile() || stat.isSymbolicLink()) missing.push(document);
  }
  gates.push(
    gate(
      'release_documents',
      missing.length ? 'FAIL' : 'PASS',
      missing.length
        ? `Required release documents are missing: ${missing.join(', ')}.`
        : 'Required local release and submission documents exist; their claims still require review.',
    ),
  );
  for (const [id, detail] of [
    [
      'local_gate',
      'Not executed by this inspector. Retain the actual npm run check result for this artifact.',
    ],
    [
      'packed_consumer',
      'Not executed by this inspector. Retain the packed smoke artifact manifest for this artifact.',
    ],
    [
      'hosted_ci',
      'Hosted CI outcomes and the tested Node matrix have not been observed by this local inspector.',
    ],
    [
      'live_meta',
      'A real Meta service result for this artifact has not been supplied; credentials are not inspected.',
    ],
    [
      'independent_human_trial',
      'An independent person must record the clean installation and demonstration outcome.',
    ],
    [
      'submission_portal',
      'Event identity, eligibility, required assets and portal submission have not been confirmed.',
    ],
  ])
    gates.push(gate(id, 'PENDING', detail));
  return {
    format: 'investigator-release-readiness-v1',
    inspectedAt: new Date().toISOString(),
    package: metadata ? { name: metadata.name ?? null, version: metadata.version ?? null } : null,
    status: gates.some((item) => item.status === 'FAIL') ? 'FAIL' : 'PENDING',
    ready: false,
    gates,
    limitations: [
      'This read-only inspection does not run tests, query Git/remotes, contact Meta, publish, or submit.',
      'PASS records only the named local inspection; PENDING is not an approval or a failed execution.',
      'No external gate is inferred from local source, credentials, or the presence of a workflow file.',
    ],
  };
}

async function main() {
  const args = process.argv.slice(2);
  let strict = false;
  let output;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--strict' && !strict) strict = true;
    else if (args[index] === '--out' && !output && args[index + 1]) output = args[++index];
    else
      throw new Error('Usage: node scripts/release-readiness.mjs [--strict] [--out new-file.json]');
  }
  const report = await buildReadinessReport();
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (output) await writeFile(output, serialized, { flag: 'wx', mode: 0o600 });
  process.stdout.write(serialized);
  process.exitCode = report.status === 'FAIL' ? 1 : strict ? 2 : 0;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(() => {
    process.stderr.write(
      'Release readiness inspection failed; check arguments and output availability.\n',
    );
    process.exitCode = 1;
  });
}
