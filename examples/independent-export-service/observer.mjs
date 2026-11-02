import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';

// This supervisor is the actual synthetic effect destination, not an application log reader.
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
const identifier = (value) =>
  typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,159}$/.test(value);
const hash = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const exactKeys = (value, keys) =>
  value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));

async function body(request) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 262144) throw new Error('bounded request');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export async function startIndependentObserver({ subjectRevision, credential }) {
  if (!hash(subjectRevision) || typeof credential !== 'string' || credential.length < 16)
    throw new Error('Valid fixture revision and observer credential required');
  const sessions = new Map();
  const server = createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json');
    const send = (status, value) => {
      response.writeHead(status);
      response.end(JSON.stringify(value));
    };
    try {
      const url = new URL(request.url, 'http://127.0.0.1');
      const admin = request.headers.authorization === `Bearer ${credential}`;
      if (request.method === 'GET' && url.pathname === '/__investigator__/identity') {
        if (!admin) return send(403, { error: 'Observer credential required' });
        return send(200, {
          protocol: 'approval-target-v1',
          fixture: true,
          role: 'observer',
          subjectRevision,
        });
      }
      if (request.method === 'GET' && url.pathname === '/__investigator__/snapshot') {
        if (!admin) return send(403, { error: 'Observer credential required' });
        const session = sessions.get(
          `${url.searchParams.get('runId')}/${url.searchParams.get('scenarioId')}`,
        );
        if (!session) return send(404, { error: 'Unknown capture' });
        const settled = [...session.attempts.entries()]
          .filter(([, attempt]) => attempt.settled)
          .map(([id]) => id);
        return send(200, {
          runId: session.runId,
          scenarioId: session.scenarioId,
          subjectRevision,
          coverage: settled.length === session.attempts.size ? 'complete' : 'partial',
          settledAttemptIds: settled,
          effects: session.effects,
        });
      }
      if (request.method !== 'POST') return send(405, { error: 'Protocol method required' });
      const data = await body(request);
      if (url.pathname === '/__investigator__/cleanup') {
        if (!admin) return send(403, { error: 'Supervisor required' });
        if (!exactKeys(data, ['runId']) || !identifier(data.runId))
          return send(400, { error: 'Invalid run identity' });
        let removed = 0;
        for (const [key, session] of sessions)
          if (session.runId === data.runId) {
            sessions.delete(key);
            removed++;
          }
        return send(200, { removed });
      }
      if (!identifier(data.runId) || !identifier(data.scenarioId))
        return send(400, { error: 'Invalid correlation' });
      const key = `${data.runId}/${data.scenarioId}`;
      if (url.pathname === '/__investigator__/sessions') {
        if (!admin) return send(403, { error: 'Supervisor required' });
        if (
          data.schemaVersion !== 1 ||
          data.subjectRevision !== subjectRevision ||
          sessions.has(key) ||
          sessions.size >= 64
        )
          return send(409, { error: 'Invalid or duplicate fixture capture' });
        const captureToken = randomBytes(32).toString('hex');
        sessions.set(key, {
          runId: data.runId,
          scenarioId: data.scenarioId,
          captureToken,
          attempts: new Map(),
          effects: [],
        });
        return send(201, {
          runId: data.runId,
          scenarioId: data.scenarioId,
          subjectRevision,
          captureToken,
        });
      }
      const session = sessions.get(key);
      if (!session) return send(404, { error: 'Unknown capture' });
      if (url.pathname === '/__investigator__/attempts') {
        if (!admin) return send(403, { error: 'Supervisor required' });
        if (
          !identifier(data.attemptId) ||
          !hash(data.requestDigest) ||
          session.attempts.has(data.attemptId) ||
          session.attempts.size >= 64
        )
          return send(409, { error: 'Invalid or duplicate attempt' });
        const challenge = randomBytes(32).toString('hex');
        session.attempts.set(data.attemptId, {
          challenge,
          requestDigest: data.requestDigest,
          settled: false,
        });
        return send(201, {
          runId: data.runId,
          scenarioId: data.scenarioId,
          attemptId: data.attemptId,
          requestDigest: data.requestDigest,
          challenge,
        });
      }
      const attempt = session.attempts.get(data.attemptId);
      if (
        request.headers.authorization !== `Bearer ${session.captureToken}` ||
        !attempt ||
        data.challenge !== attempt.challenge ||
        attempt.settled
      )
        return send(403, { error: 'A live attempt capability is required' });
      if (url.pathname === '/__investigator__/effects') {
        const effect = data.effect;
        if (
          !exactKeys(effect, [
            'requestId',
            'action',
            'actorId',
            'destination',
            'payload',
            'requestDigest',
          ]) ||
          !identifier(effect.requestId) ||
          !identifier(effect.actorId) ||
          !['customer.export', 'reference.ping'].includes(effect.action) ||
          typeof effect.destination !== 'string' ||
          effect.destination.length > 1024 ||
          !effect.payload ||
          typeof effect.payload !== 'object' ||
          Array.isArray(effect.payload) ||
          session.effects.length >= 64
        )
          return send(400, { error: 'Invalid effect' });
        const { requestDigest, ...actual } = effect;
        if (requestDigest !== digest(actual))
          return send(400, { error: 'Effect content digest mismatch' });
        session.effects.push({
          attemptId: data.attemptId,
          effect: { sequence: session.effects.length + 1, ...actual, requestDigest },
        });
        return send(201, { stored: true });
      }
      if (url.pathname === '/__investigator__/settle') {
        attempt.settled = true;
        return send(200, { settled: true });
      }
      return send(404, { error: 'Unknown fixture route' });
    } catch {
      if (!response.headersSent) send(400, { error: 'Invalid fixture protocol request' });
      else response.end();
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Observer failed to bind loopback');
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    async close() {
      server.closeAllConnections();
      if (server.listening) await new Promise((resolve) => server.close(resolve));
    },
  };
}
