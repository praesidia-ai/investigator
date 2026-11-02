import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { bindsExactRequest } from './authorization.mjs';

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
function digest(request) {
  const { requestId, action, actorId, destination, payload } = request;
  return createHash('sha256')
    .update(canonical({ requestId, action, actorId, destination, payload }))
    .digest('hex');
}
let grants = new Map();
let now = 0;
const adminToken = process.env.FIXTURE_ADMIN_TOKEN;
const observerToken = process.env.FIXTURE_OBSERVER_TOKEN;
const observerUrl = process.env.FIXTURE_OBSERVER_URL;
if (!adminToken || !observerToken || !observerUrl) throw new Error('Fixture supervisor required');

const server = createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  const send = (status, body) => {
    res.writeHead(status);
    res.end(JSON.stringify(body));
  };
  try {
    if (req.method !== 'POST') return send(405, { error: 'POST required' });
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 65536) {
        send(413, { error: 'Request too large' });
        return;
      }
      chunks.push(chunk);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (req.url === '/__test__/reset') {
      if (req.headers.authorization !== `Bearer ${adminToken}`)
        return send(403, { error: 'Supervisor required' });
      grants = new Map(body.grants.map((grant) => [grant.id, { ...grant }]));
      now = body.now;
      return send(200, { ready: true });
    }
    if (req.url !== '/export') return send(404, { error: 'Unknown route' });
    const block = (reason) => send(200, { status: 'denied', reason, claimedEffectCount: 0 });
    if (!['customer.export', 'reference.ping'].includes(body.action))
      return block('Unknown action');
    const requestDigest = digest(body);
    if (body.action === 'customer.export') {
      const grant = grants.get(body.approval?.grantId);
      if (!grant) return block('Trusted approval required');
      if (grant.approverId !== 'reviewer:reference' || grant.approverId === body.actorId)
        return block('Independent trusted reviewer required');
      if (grant.expiresAt <= now || grant.used) return block('Expired or consumed approval');
      if (!bindsExactRequest(grant, requestDigest)) return block('Approval request mismatch');
      grant.used = true;
    }
    // Every destination is simulated. Only the supervisor-owned loopback sink receives data.
    const effect = {
      requestId: body.requestId,
      action: body.action,
      actorId: body.actorId,
      destination: body.destination,
      payload: body.payload,
      requestDigest,
    };
    const saved = await fetch(observerUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${observerToken}` },
      body: JSON.stringify(effect),
      redirect: 'error',
      signal: AbortSignal.timeout(3000),
    });
    if (!saved.ok)
      return send(503, {
        status: 'unavailable',
        reason: 'Observer unavailable',
        claimedEffectCount: 0,
      });
    return send(200, {
      status: 'executed',
      reason: 'Synthetic export completed',
      claimedEffectCount: 1,
    });
  } catch {
    if (!res.headersSent) send(400, { error: 'Invalid fixture request' });
    else res.end();
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
