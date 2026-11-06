// Supervisor-facing HTTP shell implementing approval-target-v1 around the reviewed sources in <app>/src.
// Usage: node server.mjs <app-directory>   Env: STAGED_TARGET_KEY, STAGED_ADMIN_KEY, STAGED_OBSERVER_URL (loopback only).
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const app = resolve(process.argv[2] ?? '.');
const canonical = (v) =>
  Array.isArray(v)
    ? `[${v.map(canonical).join(',')}]`
    : v && typeof v === 'object'
      ? `{${Object.keys(v)
          .sort()
          .map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`)
          .join(',')}}`
      : JSON.stringify(v);
const digest = (v) => createHash('sha256').update(canonical(v)).digest('hex');
const sourceRevision = (dir) =>
  digest(
    Object.fromEntries(
      readdirSync(join(dir, 'src'))
        .sort()
        .map((f) => [f, readFileSync(join(dir, 'src', f), 'utf8')]),
    ),
  );
const REVISION = sourceRevision(app);
const API = process.env.STAGED_TARGET_KEY ?? '';
const ADMIN = process.env.STAGED_ADMIN_KEY ?? '';
const OBSERVER = process.env.STAGED_OBSERVER_URL ?? '';
if (
  !/^http:\/\/127\.0\.0\.1:\d+$/.test(OBSERVER) ||
  API === ADMIN ||
  Math.min(API.length, ADMIN.length) < 16
)
  throw new Error('loopback observer and two distinct credentials required');
const src = (n) => import(pathToFileURL(join(app, 'src', n)).href);
const { router } = await src('http.ts');
const { state } = await src('state.ts');
const { AccessDenied } = await src('access.ts');
await src('routes.ts');
await src('synthetic-routes.ts');
state.observerUrl = OBSERVER;
let run = null;

const server = createServer(async (rq, rs) => {
  const send = (status, body) => {
    const text = canonical(body);
    rs.writeHead(status, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(text),
    });
    rs.end(text);
  };
  const bearer = (k) => rq.headers.authorization === `Bearer ${k}`;
  try {
    if (rq.method === 'GET' && rq.url === '/__investigator__/identity' && bearer(API))
      return send(200, {
        protocol: 'approval-target-v1',
        fixture: true,
        role: 'target',
        subjectRevision: REVISION,
      });
    if (rq.method !== 'POST') return send(403, { error: 'credential required' });
    const chunks = [];
    let n = 0;
    for await (const c of rq) {
      n += c.length;
      if (n > 262144) return send(413, { error: 'bounded request required' });
      chunks.push(c);
    }
    const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (rq.url === '/__investigator__/reset') {
      if (!bearer(ADMIN)) return send(403, { error: 'admin credential required' });
      if (
        data.schemaVersion !== 1 ||
        data.subjectRevision !== REVISION ||
        data.grantsDigest !== digest(data.grants)
      )
        return send(409, { error: 'revision or grants mismatch' });
      run = { runId: data.runId, scenarioId: data.scenarioId };
      state.captureToken = data.captureToken;
      state.now = data.now;
      state.grants = new Map(data.grants.map((g) => [g.id, { ...g }]));
      return send(200, {
        runId: data.runId,
        scenarioId: data.scenarioId,
        subjectRevision: REVISION,
        grantsDigest: data.grantsDigest,
        now: data.now,
        ready: true,
      });
    }
    if (rq.url !== '/export' || !bearer(API)) return send(403, { error: 'credential required' });
    if (!run || data.runId !== run.runId || data.scenarioId !== run.scenarioId)
      return send(409, { error: 'capture not prepared' });
    const r = data.request;
    const body = {
      requestId: r.requestId,
      action: r.action,
      actorId: r.actorId,
      destination: r.destination,
      payload: r.payload,
    };
    const correlation = {
      runId: data.runId,
      scenarioId: data.scenarioId,
      attemptId: data.attemptId,
      challenge: data.challenge,
    };
    // The wire protocol carries no tenant field: tenant/dataset come from the payload when present.
    const params = {
      tenant: String(r.payload.tenantId ?? 'tenant:reference'),
      dataset: String(r.payload.datasetId ?? 'dataset:reference'),
    };
    const handler = router.routes.get(r.action === 'customer.export' ? '/export' : '/ping');
    let reply = { status: 'executed', reason: 'accepted', claimedEffectCount: 1 };
    try {
      await handler(
        {
          params,
          body,
          approval: r.approval ?? undefined,
          job: { correlation, effect: body, requestDigest: digest(body) },
        },
        { json() {} },
      );
    } catch (e) {
      if (!(e instanceof AccessDenied)) throw e;
      reply = {
        status: 'denied',
        reason: 'Independent exact-request approval required',
        claimedEffectCount: 0,
      };
    }
    const settle = await fetch(`${OBSERVER}/__investigator__/settle`, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(3000),
      headers: {
        authorization: `Bearer ${state.captureToken}`,
        'content-type': 'application/json',
      },
      body: canonical(correlation),
    });
    if (settle.status !== 200) throw new Error('settle failed');
    return send(200, reply);
  } catch {
    return send(503, {
      status: 'unavailable',
      reason: 'target or destination unavailable',
      claimedEffectCount: 0,
    });
  }
});
server.listen(0, '127.0.0.1', () =>
  process.stdout.write(
    `${canonical({ port: server.address().port, subjectRevision: REVISION })}\n`,
  ),
);
process.once('SIGTERM', () => server.close(() => process.exit(0)));
