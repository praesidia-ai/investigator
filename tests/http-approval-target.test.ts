import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { startIndependentObserver } from '../examples/independent-export-service/observer.mjs';
import { jsonDigest, sha256, type JsonObject } from '../src/core/json.js';
import {
  createHttpApprovalTarget,
  httpApprovalTargetConfigSchema,
  loadHttpApprovalTarget,
} from '../src/targets/http-approval-target.js';
import type { ApprovalGrant, ReferenceRequest } from '../src/reference/approval-control.js';

const REVISION = sha256('independently authored HTTP protocol test fixture');
const ENV = {
  EXAMPLE_SUBMIT_KEY: 'synthetic-submit-key-0123456789',
  EXAMPLE_ADMIN_KEY: 'synthetic-admin-key-0123456789',
  EXAMPLE_OBSERVER_KEY: 'synthetic-observer-key-0123456789',
};

function config(targetUrl = 'https://target.example', observerUrl = 'https://observer.example') {
  return {
    kind: 'http-approval-target',
    schemaVersion: 1,
    fixtureProtocol: 'approval-target-v1',
    subjectRevision: REVISION,
    target: {
      baseUrl: targetUrl,
      credentialEnv: 'EXAMPLE_SUBMIT_KEY',
      adminCredentialEnv: 'EXAMPLE_ADMIN_KEY',
    },
    observer: { baseUrl: observerUrl, credentialEnv: 'EXAMPLE_OBSERVER_KEY' },
    allowLoopbackHttp: false,
    timeoutMs: 1000,
    maxResponseBytes: 262144,
  };
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
}

interface FixtureOptions {
  bound?: boolean;
  wrongRevision?: boolean;
  skipSettle?: boolean;
  falseRefusal?: boolean;
  fakeSuccess?: boolean;
  leakSecret?: boolean;
  escapedSecret?: boolean;
  redirect?: boolean;
  oversized?: boolean;
}

async function withFixture(
  options: FixtureOptions,
  operation: (
    input: ReturnType<typeof config>,
    calls: { reset: number; submit: number },
    stopObserver: () => Promise<void>,
  ) => Promise<void>,
): Promise<void> {
  const observer = await startIndependentObserver({
    subjectRevision: REVISION,
    credential: ENV.EXAMPLE_OBSERVER_KEY,
  });
  const calls = { reset: 0, submit: 0 };
  let state:
    | {
        runId: string;
        scenarioId: string;
        captureToken: string;
        now: number;
        grants: Map<string, ApprovalGrant>;
      }
    | undefined;
  const server = createServer(async (request, response) => {
    const send = (body: unknown, status = 200) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
    };
    try {
      if (request.method === 'GET' && request.url === '/__investigator__/identity') {
        if (request.headers.authorization !== `Bearer ${ENV.EXAMPLE_SUBMIT_KEY}`)
          return send({}, 403);
        if (options.redirect) {
          response.writeHead(302, { location: observer.baseUrl });
          response.end();
          return;
        }
        if (options.oversized) return send({ padding: 'x'.repeat(300000) });
        return send({
          protocol: 'approval-target-v1',
          fixture: true,
          role: 'target',
          subjectRevision: options.wrongRevision ? '0'.repeat(64) : REVISION,
        });
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array));
      const data = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
        runId: string;
        scenarioId: string;
        captureToken: string;
        now: number;
        grants: ApprovalGrant[];
        grantsDigest: string;
        request: ReferenceRequest;
        attemptId: string;
        challenge: string;
      };
      if (request.url === '/__investigator__/reset') {
        if (request.headers.authorization !== `Bearer ${ENV.EXAMPLE_ADMIN_KEY}`)
          return send({}, 403);
        calls.reset += 1;
        state = { ...data, grants: new Map(data.grants.map((grant) => [grant.id, { ...grant }])) };
        return send({
          runId: data.runId,
          scenarioId: data.scenarioId,
          subjectRevision: REVISION,
          grantsDigest: jsonDigest(data.grants.map((grant) => ({ ...grant }))),
          now: data.now,
          ready: true,
        });
      }
      if (
        request.url !== '/export' ||
        request.headers.authorization !== `Bearer ${ENV.EXAMPLE_SUBMIT_KEY}` ||
        !state
      )
        return send({}, 403);
      calls.submit += 1;
      const probe = data.request;
      const { approval: _approval, ...body } = probe;
      const digest = jsonDigest(body);
      const grant = probe.approval === null ? undefined : state.grants.get(probe.approval.grantId);
      let allowed =
        probe.action === 'reference.ping' ||
        Boolean(
          grant &&
          grant.approverId === 'reviewer:reference' &&
          grant.approverId !== probe.actorId &&
          grant.expiresAt > state.now &&
          !grant.used &&
          (!options.bound || grant.requestDigest === digest),
        );
      if (options.falseRefusal) allowed = true;
      if (allowed && grant) grant.used = true;
      const correlation = {
        runId: data.runId,
        scenarioId: data.scenarioId,
        attemptId: data.attemptId,
        challenge: data.challenge,
      };
      const observed = async (path: string, extra: JsonObject = {}) => {
        const reply = await fetch(`${observer.baseUrl}${path}`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${state!.captureToken}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ ...correlation, ...extra }),
          redirect: 'error',
          signal: AbortSignal.timeout(1000),
        });
        if (!reply.ok) throw new Error('observer');
        await reply.text();
      };
      if (allowed && !options.fakeSuccess)
        await observed('/__investigator__/effects', { effect: { ...body, requestDigest: digest } });
      if (!options.skipSettle) await observed('/__investigator__/settle');
      const reply = {
        status: options.falseRefusal ? 'approval_required' : allowed ? 'executed' : 'denied',
        reason:
          options.leakSecret || options.escapedSecret
            ? ENV.EXAMPLE_ADMIN_KEY
            : 'Independent protocol test target',
        claimedEffectCount: options.falseRefusal ? 0 : allowed ? 1 : 0,
      };
      if (options.escapedSecret) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify(reply).replace(
            ENV.EXAMPLE_ADMIN_KEY,
            `\\u${ENV.EXAMPLE_ADMIN_KEY.charCodeAt(0).toString(16).padStart(4, '0')}${ENV.EXAMPLE_ADMIN_KEY.slice(1)}`,
          ),
        );
        return;
      }
      return send(reply);
    } catch {
      return send({}, 503);
    }
  });
  try {
    const targetUrl = await listen(server);
    await operation(
      { ...config(targetUrl, observer.baseUrl), allowLoopbackHttp: true },
      calls,
      observer.close,
    );
  } finally {
    await close(server);
    await observer.close();
  }
}

describe('operator-selected generic HTTP approval adapter', () => {
  it('releases run-scoped capture sessions so the same observer supports repeated runs', async () => {
    await withFixture({ bound: true }, async (input) => {
      const adapter = createHttpApprovalTarget(input, ENV);
      for (let run = 0; run < 6; run++)
        expect(
          (await adapter.runChecks(AbortSignal.timeout(10000))).map((check) => check.status),
        ).toEqual(['PASS', 'PASS', 'PASS']);
    });
  });

  it('honors a deadline even if the response stream refuses to finish cancellation', async () => {
    const started = performance.now();
    const adapter = createHttpApprovalTarget({ ...config(), timeoutMs: 100 }, ENV, {
      fetch: async () =>
        new Response(
          new ReadableStream({
            pull: () => new Promise(() => {}),
            cancel: () => new Promise(() => {}),
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
    });
    await expect(adapter.runChecks(AbortSignal.timeout(2000))).rejects.toMatchObject({
      code: 'TARGET_REQUEST_ABORTED',
    });
    expect(performance.now() - started).toBeLessThan(1500);
  });
  it('allows only explicit separate credential names, HTTPS or opted-in literal loopback', () => {
    expect(httpApprovalTargetConfigSchema.safeParse(config()).success).toBe(true);
    expect(
      httpApprovalTargetConfigSchema.safeParse({ ...config(), credential: 'literal-key' }).success,
    ).toBe(false);
    for (const origin of [
      'http://target.example',
      'http://localhost:1234',
      'http://127.0.0.2:1234',
      'file:///tmp/target',
      'https://key@target.example',
      'https://target.example?token=secret',
    ]) {
      expect(
        httpApprovalTargetConfigSchema.safeParse({ ...config(origin), allowLoopbackHttp: true })
          .success,
      ).toBe(false);
    }
    expect(httpApprovalTargetConfigSchema.safeParse(config('http://127.0.0.1:1234')).success).toBe(
      false,
    );
    expect(() => createHttpApprovalTarget(config(), {})).toThrow('credential');
    expect(() =>
      createHttpApprovalTarget(config(), { ...ENV, EXAMPLE_ADMIN_KEY: ENV.EXAMPLE_SUBMIT_KEY }),
    ).toThrow('distinct values');
  });

  it('runs unchanged fixed scenarios against independently implemented actual HTTP services', async () => {
    for (const bound of [false, true])
      await withFixture({ bound }, async (input, calls) => {
        const adapter = createHttpApprovalTarget(input, ENV);
        expect(adapter.id).toBe('http-approval-target');
        expect(adapter.subjectRevision).toBe(REVISION);
        expect(adapter.configurationDigest).toMatch(/^[a-f0-9]{64}$/);
        const checks = await adapter.runChecks(AbortSignal.timeout(10000));
        expect(checks.map((entry) => entry.status)).toEqual(
          bound ? ['PASS', 'PASS', 'PASS'] : ['PASS', 'FAIL', 'PASS'],
        );
        expect(calls.reset).toBeGreaterThan(10);
        expect(calls.submit).toBeGreaterThan(calls.reset);
        const encoded = JSON.stringify({ adapter, checks });
        for (const secret of Object.values(ENV)) expect(encoded).not.toContain(secret);
        expect(encoded).not.toContain('captureToken');
        expect(encoded).not.toContain('challenge');
        expect(encoded).toContain('operator-selected-http-effect-observer');
      });
  });

  it('loads a bounded operator config and keeps credential rotation outside the configuration digest', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'investigator-http-config-'));
    try {
      const path = join(directory, 'target.json');
      await writeFile(path, JSON.stringify(config()));
      const loaded = await loadHttpApprovalTarget(path, ENV);
      const rotated = createHttpApprovalTarget(config(), {
        ...ENV,
        EXAMPLE_SUBMIT_KEY: 'rotated-synthetic-submit-key',
      });
      expect(loaded.configurationDigest).toBe(rotated.configurationDigest);
      await writeFile(path, 'x'.repeat(65537));
      await expect(loadHttpApprovalTarget(path, ENV)).rejects.toMatchObject({
        code: 'SOURCE_TOO_LARGE',
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects the wrong target revision before administrative resets or probes', async () => {
    await withFixture({ wrongRevision: true }, async (input, calls) => {
      await expect(
        createHttpApprovalTarget(input, ENV).runChecks(AbortSignal.timeout(3000)),
      ).rejects.toMatchObject({ code: 'CHECK_TARGET_CHANGED' });
      expect(calls).toEqual({ reset: 0, submit: 0 });
    });
  });

  it('does not accept false refusal statuses or fabricated success without observed effects', async () => {
    await withFixture({ falseRefusal: true }, async (input) => {
      const checks = await createHttpApprovalTarget(input, ENV).runChecks(
        AbortSignal.timeout(10000),
      );
      expect(checks.map((entry) => entry.status)).toEqual(['FAIL', 'FAIL', 'FAIL']);
    });
    await withFixture({ bound: true, fakeSuccess: true }, async (input) => {
      const checks = await createHttpApprovalTarget(input, ENV).runChecks(
        AbortSignal.timeout(10000),
      );
      expect(checks[2]!.status).toBe('FAIL');
    });
  });

  it('never reports prevention when observer capture is incomplete or unavailable', async () => {
    await withFixture({ skipSettle: true }, async (input) => {
      const checks = await createHttpApprovalTarget(input, ENV).runChecks(
        AbortSignal.timeout(10000),
      );
      expect(checks.every((entry) => entry.status === 'ERROR')).toBe(true);
    });
    await withFixture({}, async (input, calls, stopObserver) => {
      await stopObserver();
      await expect(
        createHttpApprovalTarget(input, ENV).runChecks(AbortSignal.timeout(3000)),
      ).rejects.toMatchObject({ code: 'TARGET_PROTOCOL_ERROR' });
      expect(calls.submit).toBe(0);
    });
  });

  it('rejects cross-run snapshot correlation and observer effect tampering', async () => {
    for (const tamper of ['correlation', 'effect'])
      await withFixture({ bound: true }, async (input) => {
        const wrapped: typeof fetch = async (url, init) => {
          const reply = await fetch(url, init);
          if (!new URL(String(url)).pathname.endsWith('/snapshot')) return reply;
          const parsed = (await reply.json()) as {
            runId: string;
            effects: { effect: { requestDigest: string } }[];
          };
          if (tamper === 'correlation') parsed.runId = 'unrelated-run';
          else if (parsed.effects[0]) parsed.effects[0].effect.requestDigest = '0'.repeat(64);
          return new Response(JSON.stringify(parsed), {
            status: reply.status,
            headers: { 'content-type': 'application/json' },
          });
        };
        const checks = await createHttpApprovalTarget(input, ENV, { fetch: wrapped }).runChecks(
          AbortSignal.timeout(10000),
        );
        expect(checks[2]!.status).toBe('ERROR');
        expect(checks.some((entry) => entry.status === 'ERROR')).toBe(true);
      });
  });

  it('redacts response failures and forbids redirects, oversized responses and expired calls', async () => {
    await withFixture({ leakSecret: true }, async (input) => {
      const checks = await createHttpApprovalTarget(input, ENV).runChecks(
        AbortSignal.timeout(10000),
      );
      expect(checks.every((entry) => entry.status === 'ERROR')).toBe(true);
      for (const secret of Object.values(ENV)) expect(JSON.stringify(checks)).not.toContain(secret);
    });
    for (const options of [{ redirect: true }, { oversized: true }])
      await withFixture(options, async (input, calls) => {
        await expect(
          createHttpApprovalTarget(input, ENV).runChecks(AbortSignal.timeout(3000)),
        ).rejects.toMatchObject({ code: 'TARGET_PROTOCOL_ERROR' });
        expect(calls.submit).toBe(0);
      });
    const controller = new AbortController();
    controller.abort();
    await expect(
      createHttpApprovalTarget(config(), ENV).runChecks(controller.signal),
    ).rejects.toMatchObject({ code: 'TARGET_REQUEST_ABORTED' });
  });

  it('rejects credentials hidden behind JSON Unicode escapes before saving observations', async () => {
    await withFixture({ escapedSecret: true }, async (input) => {
      const checks = await createHttpApprovalTarget(input, ENV).runChecks(
        AbortSignal.timeout(10000),
      );
      expect(checks.every((check) => check.status === 'ERROR')).toBe(true);
      for (const secret of Object.values(ENV)) expect(JSON.stringify(checks)).not.toContain(secret);
    });
  });

  it('rejects decoded credentials in nested observer payloads', async () => {
    await withFixture({}, async (input) => {
      const wrapped: typeof fetch = async (url, init) => {
        const reply = await fetch(url, init);
        if (!new URL(String(url)).pathname.endsWith('/snapshot')) return reply;
        const snapshot = (await reply.json()) as {
          effects: {
            effect: { payload: Record<string, unknown>; requestDigest: string; sequence: number };
          }[];
        };
        if (snapshot.effects[0]) {
          const effect = snapshot.effects[0].effect;
          effect.payload.note = ENV.EXAMPLE_ADMIN_KEY;
          const { sequence: _sequence, requestDigest: _requestDigest, ...body } = effect;
          effect.requestDigest = jsonDigest(body as JsonObject);
        }
        const encoded = JSON.stringify(snapshot).replaceAll(
          ENV.EXAMPLE_ADMIN_KEY,
          `\\u${ENV.EXAMPLE_ADMIN_KEY.charCodeAt(0).toString(16).padStart(4, '0')}${ENV.EXAMPLE_ADMIN_KEY.slice(1)}`,
        );
        return new Response(encoded, { headers: { 'content-type': 'application/json' } });
      };
      const checks = await createHttpApprovalTarget(input, ENV, { fetch: wrapped }).runChecks(
        AbortSignal.timeout(10000),
      );
      for (const value of Object.values(ENV)) expect(JSON.stringify(checks)).not.toContain(value);
      expect(checks[2]!.status).toBe('ERROR');
    });
  });
});
