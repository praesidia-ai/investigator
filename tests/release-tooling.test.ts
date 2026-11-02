import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { describe, expect, it } from 'vitest';

interface ReadinessGate {
  readonly id: string;
  readonly status: 'PASS' | 'PENDING' | 'FAIL';
  readonly detail: string;
}
interface ReadinessReport {
  readonly status: 'PASS' | 'PENDING' | 'FAIL';
  readonly ready: boolean;
  readonly gates: readonly ReadinessGate[];
}
const packed = (await import(new URL('../scripts/packed-smoke.mjs', import.meta.url).href)) as {
  inspectPackageFiles: (entries: readonly string[]) => readonly string[];
  smokeEnvironment: (
    environment: Record<string, string>,
    scratch: string,
  ) => Record<string, string>;
};
const readiness = (await import(
  new URL('../scripts/release-readiness.mjs', import.meta.url).href
)) as {
  buildReadinessReport: (options: { packageRoot: string }) => Promise<ReadinessReport>;
};
const INVENTORY = [
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
const METADATA = {
  name: '@praesidia/investigator',
  version: '0.1.0',
  license: 'Apache-2.0',
  private: true,
  type: 'module',
  engines: { node: '>=22.12.0' },
  bin: { 'praesidia-investigator': 'dist/bin.js' },
  exports: { '.': { import: './dist/index.js' } },
  dependencies: { zod: '4.6.7' },
};

async function withReleaseFixture(
  callback: (directory: string) => Promise<void>,
  metadata: object = METADATA,
) {
  const directory = await mkdtemp(join(tmpdir(), 'investigator-release-unit-'));
  try {
    await writeFile(join(directory, 'package.json'), JSON.stringify(metadata));
    await mkdir(join(directory, 'docs'));
    for (const path of INVENTORY.filter((path) => /(?:\.md|LICENSE|NOTICE)$/.test(path))) {
      await mkdir(dirname(join(directory, path)), { recursive: true });
      await writeFile(join(directory, path), 'Synthetic release-document fixture.\n');
    }
    await callback(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe('release tooling boundaries', () => {
  it('requires installed runtime, examples and release documents in the actual package inventory', () => {
    expect(packed.inspectPackageFiles([...INVENTORY, '.env.example'])).toContain('dist/bin.js');
    expect(() =>
      packed.inspectPackageFiles(INVENTORY.filter((path) => !path.endsWith('server.mjs'))),
    ).toThrow('missing');
    expect(() =>
      packed.inspectPackageFiles(INVENTORY.filter((path) => !path.endsWith('RELEASING.md'))),
    ).toThrow('missing');
  });

  it.each([
    'docs/CLIENT-CONTEXT.md',
    'examples/client-evidence-gap/case.json',
    'examples/client-evidence-gap/context.json',
    'examples/client-evidence-gap/policy.md',
    'examples/client-evidence-gap/architecture.json',
    'examples/client-evidence-gap/telemetry.json',
    'examples/client-evidence-gap/producer.mjs',
    'examples/evidence-gap-service/server.mjs',
    'examples/evidence-gap-service/instrumentation.mjs',
  ])('requires the installed context/evidence workflow resource %s', (entry) => {
    expect(() => packed.inspectPackageFiles(INVENTORY.filter((path) => path !== entry))).toThrow(
      'missing',
    );
  });

  it.each([
    'docs/CANCELLATION.md',
    'examples/cancellation-service/server.mjs',
    'examples/cancellation-service/worker-authority.mjs',
  ])('requires the installed cancellation workflow resource %s', (entry) => {
    expect(() => packed.inspectPackageFiles(INVENTORY.filter((path) => path !== entry))).toThrow(
      'missing',
    );
  });

  it.each([
    'docs/ASSURANCE-CHANGES.md',
    'examples/mcp-export/mcp-source.json',
    'examples/mcp-export/tools.json',
    'examples/mcp-export/tools-changed.json',
    'examples/mcp-export/tools-page.json',
  ])('requires the installed assurance/MCP workflow resource %s', (entry) => {
    expect(() => packed.inspectPackageFiles(INVENTORY.filter((path) => path !== entry))).toThrow(
      'missing',
    );
  });

  it.each([
    '.env',
    '.env.production',
    'artifacts/private-report.json',
    '.claude/runs/check.log',
    'node_modules/private/index.js',
    'be/src/app.ts',
    '../shared/index.js',
    '/private/source.js',
    'dist/../../worker/index.js',
    'dist\\index.js',
  ])('rejects private or escaping package entry %s', (entry) => {
    expect(() => packed.inspectPackageFiles([...INVENTORY, entry])).toThrow('forbidden');
  });

  it('does not propagate credentials, node preloads or private npm configuration', () => {
    const environment = packed.smokeEnvironment(
      {
        PATH: '/usr/bin',
        HOME: '/synthetic/home',
        MODEL_API_KEY: 'synthetic-model-secret',
        META_API_KEY: 'synthetic-alias-secret',
        PRAESIDIA_API_KEY: 'synthetic-platform-secret',
        NODE_AUTH_TOKEN: 'synthetic-registry-secret',
        NPM_TOKEN: 'synthetic-npm-secret',
        NODE_OPTIONS: '--require=/private/sibling.js',
        NODE_PATH: '/private/siblings',
        npm_config_userconfig: '/private/.npmrc',
      },
      '/synthetic/owned-temp',
    );
    expect(environment.PATH).toBe('/usr/bin');
    expect(environment.npm_config_ignore_scripts).toBe('true');
    expect(environment.npm_config_userconfig).toBe('/synthetic/owned-temp/empty.npmrc');
    expect(JSON.stringify(environment)).not.toMatch(
      /synthetic-.*secret|private|NODE_OPTIONS|NODE_PATH/,
    );
  });

  it('keeps unobserved execution and external gates pending despite valid local metadata', async () => {
    await withReleaseFixture(async (directory) => {
      const report = await readiness.buildReadinessReport({ packageRoot: directory });
      expect(report).toMatchObject({ status: 'PENDING', ready: false });
      expect(report.gates.find((gate) => gate.id === 'package_metadata')?.status).toBe('PASS');
      expect(report.gates.find((gate) => gate.id === 'release_documents')?.status).toBe('PASS');
      for (const id of [
        'local_gate',
        'packed_consumer',
        'hosted_ci',
        'live_meta',
        'independent_human_trial',
        'submission_portal',
        'publication_authorization',
      ])
        expect(report.gates.find((gate) => gate.id === id)?.status).toBe('PENDING');
      expect(report.gates.some((gate) => gate.status === 'FAIL')).toBe(false);
    });
  });

  it('fails missing release documents and checkout-bound runtime dependencies', async () => {
    await withReleaseFixture(
      async (directory) => {
        await rm(join(directory, 'docs', 'RELEASING.md'));
        const report = await readiness.buildReadinessReport({ packageRoot: directory });
        expect(report).toMatchObject({ status: 'FAIL', ready: false });
        expect(report.gates.find((gate) => gate.id === 'release_documents')?.status).toBe('FAIL');
        expect(
          report.gates.find((gate) => gate.id === 'independent_runtime_dependencies')?.status,
        ).toBe('FAIL');
      },
      { ...METADATA, dependencies: { privatePlatform: 'file:../be' } },
    );
  });
});
