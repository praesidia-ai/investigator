import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  INTEROP_PROFILES,
  adapterConfigDigest,
  sealInvestigationRequest,
  sealInvestigationResult,
  runInteropRequest,
  verifyInterop,
  type AdapterConfig,
} from '../src/index.js';
import { runCli } from '../src/cli.js';
import { sha256Text } from '../src/interop/schema.js';

const config: AdapterConfig = {
  kind: 'scripted-local',
  schemaVersion: 1,
  adapterId: 'scripted-reference',
  variant: 'request-unbound',
};
const adapter = { config, digest: adapterConfigDigest(config) };
const policy = '# Security\n\nOnly workspace admins can export customer data.\n';
const quote = 'Only workspace admins can export customer data.';
const profile = INTEROP_PROFILES[0]!;

function request(over: Record<string, unknown> = {}, verdict = 'holds') {
  const start = policy.indexOf(quote);
  return sealInvestigationRequest({
    schema: 'praesidia.investigation-request/v1',
    createdAt: '2026-11-05T10:00:00.000Z',
    promise: {
      id: 'security.01',
      digest: 'a'.repeat(64),
      status: 'accepted',
      wording: quote,
      kind: 'must',
      checkable: 'code',
    },
    policy: {
      alias: 'security',
      sha256: sha256Text(policy),
      mediaType: 'text/markdown',
      text: policy,
    },
    quote: { text: quote, locator: { kind: 'span', start, end: start + quote.length } },
    trigger: {
      runId: 'run-1',
      codeCheck: { level: 'rule', verdict } as never,
      repo: { name: 'acme', commit: 'b'.repeat(40) },
      citations: [],
    },
    tenant: 'acme',
    workflow: 'customer-export',
    environment: 'reference-test',
    window: { start: '2026-11-04T00:00:00.000Z', end: '2026-11-05T00:00:00.000Z' },
    mapping: {
      profileId: profile.id,
      profileVersion: 1,
      requirementsDigest: profile.requirementsDigest,
      reviewedBy: 'lead',
      reviewedAt: '2026-11-05T09:00:00.000Z',
    },
    commitments: { context: 'd'.repeat(64), evidence: 'e'.repeat(64) },
    adapter: { id: 'scripted-reference', configurationDigest: adapter.digest },
    scope: 'Isolated authored workload.',
    budget: { maxModelTurns: 8, maxToolCalls: 12, maxRuntimeSeconds: 120 },
    ...over,
  } as never);
}

describe('interop run', () => {
  it('keeps a static pass and a runtime contradiction apart as a mismatch', async () => {
    const req = request();
    const res = await runInteropRequest({ request: req, adapter });
    expect(res.execution.status).toBe('completed');
    expect(res.behavioral.verdict).toBe('contradicted');
    expect(res.static).toEqual({ level: 'rule', verdict: 'holds' });
    expect(res.mismatch?.kind).toBe('static-pass-runtime-contradicted');
    expect(res.requestDigest).toBe(req.digest);
    expect(verifyInterop(res, req).requestBinding).toBe('verified');
    expect(() =>
      verifyInterop({ ...res, behavioral: { ...res.behavioral, verdict: 'supported' } }, req),
    ).toThrow();
    expect(() => verifyInterop(res, request({ tenant: 'other' }))).toThrow(/not bound/);
  });
  it('unsupported mapping executes nothing', async () => {
    const req = request({
      mapping: {
        profileId: 'unknown-profile',
        profileVersion: 1,
        requirementsDigest: '1'.repeat(64),
        reviewedBy: 'x',
        reviewedAt: '2026-11-05T09:00:00.000Z',
      },
    });
    const res = await runInteropRequest({ request: req, adapter });
    expect(res.execution.status).toBe('unsupported');
    expect(res.captures).toEqual([]);
    expect(res.behavioral.verdict).toBeNull();
    const stale = await runInteropRequest({
      request: request({ mapping: { ...request().mapping, requirementsDigest: '2'.repeat(64) } }),
      adapter,
    });
    expect(stale.execution.status).toBe('unsupported');
  });
  it('refuses a config whose digest differs from the request', async () => {
    await expect(
      runInteropRequest({ request: request(), adapter: { config, digest: '0'.repeat(64) } }),
    ).rejects.toThrow(/does not match/);
  });
  it('runs the revocation profile', async () => {
    const rev = INTEROP_PROFILES[1]!;
    const cfg: AdapterConfig = { ...config, variant: 'cached-worker' };
    const d = adapterConfigDigest(cfg);
    const res = await runInteropRequest({
      request: request({
        mapping: {
          profileId: rev.id,
          profileVersion: 1,
          requirementsDigest: rev.requirementsDigest,
          reviewedBy: 'x',
          reviewedAt: '2026-11-05T09:00:00.000Z',
        },
        adapter: { id: 'scripted-reference', configurationDigest: d },
      }),
      adapter: { config: cfg, digest: d },
    });
    expect(res.execution.status).toBe('completed');
    expect(res.behavioral.verdict).toBe('contradicted');
    expect(res.captures.length).toBeGreaterThan(0);
  }, 120_000);
  it('CLI interop-run and verify-interop round trip', async () => {
    const d = await mkdtemp(join(tmpdir(), 'interop-'));
    const reqPath = join(d, 'request.json');
    const cfgPath = join(d, 'adapter.json');
    await writeFile(reqPath, JSON.stringify(request()));
    await writeFile(cfgPath, JSON.stringify(config));
    const out: string[] = [];
    const io = { stdout: (t: string) => void out.push(t), stderr: (t: string) => void out.push(t) };
    expect(
      await runCli(
        ['interop-run', reqPath, '--adapter-config', cfgPath, '--out', join(d, 'out')],
        {},
        io,
      ),
    ).toBe(1);
    const resPath = join(d, 'out', 'result.json');
    expect(JSON.parse(await readFile(resPath, 'utf8')).mismatch.kind).toBe(
      'static-pass-runtime-contradicted',
    );
    expect(await runCli(['verify-interop', resPath, '--request', reqPath, '--json'], {}, io)).toBe(
      0,
    );
    expect(
      await runCli(
        ['interop-run', reqPath, '--adapter-config', cfgPath, '--out', join(d, 'out')],
        {},
        io,
      ),
    ).toBe(2);
  }, 60_000);

  it('states first what was not observed, and aborts when the run is cancelled', async () => {
    const req = request({ tenant: 'acme', environment: 'prod' });
    const ok = await runInteropRequest({ request: req, adapter });
    expect(ok.scope[0]).toMatch(/not observed/u);
    expect(ok.scope[1]).toMatch(/^Requested scope \(not verified\)/u);
    const stopped = await runInteropRequest({
      request: req,
      adapter,
      signal: AbortSignal.abort(),
    });
    expect(stopped.execution.status).toBe('failed');
    expect(stopped.behavioral.verdict).toBeNull();
    expect(stopped.scope[0]).toMatch(/not observed/u);
  }, 60_000);

  it('refuses an http target config swapped after the adapter digest was bound', async () => {
    const d = await mkdtemp(join(tmpdir(), 'interop-swap-'));
    const targetText = '{"original":true}';
    await writeFile(join(d, 'target.json'), targetText);
    const httpConfig: AdapterConfig = {
      kind: 'http-approval-target',
      schemaVersion: 1,
      adapterId: 'staged-export-http',
      targetConfig: join(d, 'target.json'),
      targetConfigSha256: sha256Text(targetText),
    };
    await writeFile(join(d, 'target.json'), '{"swapped":true}');
    const req = request({
      adapter: { id: 'staged-export-http', configurationDigest: adapterConfigDigest(httpConfig) },
    });
    await expect(
      runInteropRequest({
        request: req,
        adapter: { config: httpConfig, digest: adapterConfigDigest(httpConfig) },
      }),
    ).rejects.toMatchObject({ code: 'ADAPTER_CONFIG_INVALID' });
  });
});

describe('verify binding', () => {
  it('17a: a completed result for an unregistered mapped profile is not verified', async () => {
    const unknown = {
      profileId: 'unknown-profile',
      profileVersion: 1,
      requirementsDigest: '1'.repeat(64),
      reviewedBy: 'x',
      reviewedAt: '2026-11-05T09:00:00.000Z',
    };
    const req = request({ mapping: unknown });
    const res = (await runInteropRequest({ request: req, adapter })) as unknown as Record<
      string,
      unknown
    >;
    const body: Record<string, unknown> = {
      ...res,
      execution: { status: 'completed', reason: null },
      behavioral: { verdict: 'supported', statement: 's' },
      profile: { id: 'unknown-profile', version: 1, requirementsDigest: '1'.repeat(64) },
      mismatch: null,
      proposedAction: null,
    };
    delete body.digest;
    const sealed = sealInvestigationResult(body as never);
    expect(() => verifyInterop(sealed, req)).toThrow(/registered profile/);
  });
});
