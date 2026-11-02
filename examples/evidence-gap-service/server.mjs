import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { executionWitness } from './instrumentation.mjs';

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
function requestDigest(request) {
  const { workId, actorId, destination, payload } = request;
  return createHash('sha256')
    .update(canonical({ workId, actorId, destination, payload }))
    .digest('hex');
}

const adminToken = process.env.EVIDENCE_FIXTURE_ADMIN_TOKEN;
const observerToken = process.env.EVIDENCE_FIXTURE_OBSERVER_TOKEN;
const observerUrl = process.env.EVIDENCE_FIXTURE_OBSERVER_URL;
const deploymentRevision = process.env.EVIDENCE_FIXTURE_REVISION;
const authorization = process.env.EVIDENCE_FIXTURE_AUTHORIZATION;
const policyRevision = 'independent-export-approval.v1';
if (
  !adminToken ||
  !observerToken ||
  !observerUrl ||
  !deploymentRevision ||
  !['safe', 'unsafe'].includes(authorization)
)
  throw new Error('Owned fixture supervisor required');

let grant = null;
let telemetry = [];
const server = createServer(async (request, response) => {
  response.setHeader('Content-Type', 'application/json');
  const send = (status, body) => {
    response.writeHead(status);
    response.end(JSON.stringify(body));
  };
  try {
    if (request.method !== 'POST') return send(405, { error: 'POST required' });
    const chunks = [];
    let bytes = 0;
    for await (const chunk of request) {
      bytes += chunk.length;
      if (bytes > 65536) return send(413, { error: 'Request too large' });
      chunks.push(chunk);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (request.url === '/__test__/configure') {
      if (request.headers.authorization !== `Bearer ${adminToken}`)
        return send(403, { error: 'Supervisor required' });
      grant = body.grant;
      telemetry = [];
      return send(200, { ready: true });
    }
    if (request.url === '/__test__/telemetry') {
      if (request.headers.authorization !== `Bearer ${adminToken}`)
        return send(403, { error: 'Supervisor required' });
      return send(200, { telemetry });
    }
    if (request.url !== '/export') return send(404, { error: 'Unknown route' });
    const recordDecision = (decision) => {
      telemetry.push({
        type: 'decision',
        workId: body.workId,
        grantId: body.grantId ?? null,
        actorId: body.actorId,
        requestDigest: requestDigest(body),
        decision,
        policyRevision,
        deploymentRevision,
        observedAt: new Date().toISOString(),
      });
    };
    const deny = () => {
      recordDecision('denied');
      return send(200, { status: 'denied' });
    };
    if (!grant || body.grantId !== grant.grantId || grant.used) return deny();
    if (grant.actorId !== body.actorId || grant.reviewerId === body.actorId) return deny();
    const digest = requestDigest(body);
    if (authorization === 'safe' && grant.requestDigest !== digest) return deny();
    grant.used = true;
    const executionId = randomUUID();
    const executionObservedAt = new Date().toISOString();
    // The business effect carries synthetic data to a separate supervisor-owned sink.
    // Its receipt is computed from the received request, not the service's claim.
    const observed = await fetch(observerUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${observerToken}`,
      },
      body: JSON.stringify({ executionId, request: body }),
      redirect: 'error',
      signal: AbortSignal.timeout(3000),
    });
    if (!observed.ok) return send(503, { status: 'unavailable' });
    // Deliberately provide only allowed metadata to the telemetry module.
    telemetry.push(
      executionWitness({
        executionId,
        workId: body.workId,
        grantId: grant.grantId,
        actorId: body.actorId,
        requestDigest: digest,
        policyRevision,
        deploymentRevision,
        observedAt: executionObservedAt,
      }),
    );
    recordDecision('executed');
    return send(200, { status: 'executed' });
  } catch {
    if (!response.headersSent) send(400, { error: 'Invalid fixture request' });
    else response.end();
  }
});

server.listen(0, '127.0.0.1', () => {
  const address = server.address();
  if (address && typeof address === 'object') process.send?.({ port: address.port });
});
function stop() {
  server.close(() => {
    if (process.connected) process.disconnect();
  });
  server.closeAllConnections();
}
process.on('SIGTERM', stop);
process.on('disconnect', stop);
