import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mayDispatch } from './worker-authority.mjs';

const supervisorToken = process.env.CANCELLATION_SUPERVISOR_TOKEN;
const authorityToken = process.env.CANCELLATION_AUTHORITY_TOKEN;
const authorityUrl = process.env.CANCELLATION_AUTHORITY_URL;
const destinationToken = process.env.CANCELLATION_DESTINATION_TOKEN;
const destinationUrl = process.env.CANCELLATION_DESTINATION_URL;
if (!supervisorToken || !authorityToken || !authorityUrl || !destinationToken || !destinationUrl)
  throw new Error('Owned fixture supervisor required');

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
function digest(job) {
  const { rootId, jobId, destination, payload } = job;
  return createHash('sha256')
    .update(canonical({ rootId, jobId, destination, payload }))
    .digest('hex');
}
async function authority(path, body) {
  const response = await fetch(`${authorityUrl}${path}`, {
    method: 'POST',
    redirect: 'error',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authorityToken}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(3000),
  });
  if (!response.ok) throw new Error('Authority unavailable');
  return response.json();
}

const jobs = new Map();
const server = createServer(async (request, response) => {
  response.setHeader('Content-Type', 'application/json');
  const send = (status, body) => {
    response.writeHead(status);
    response.end(JSON.stringify(body));
  };
  try {
    if (request.method !== 'POST' || request.headers.authorization !== `Bearer ${supervisorToken}`)
      return send(403, { error: 'Supervisor required' });
    const chunks = [];
    let bytes = 0;
    for await (const chunk of request) {
      bytes += chunk.length;
      if (bytes > 65536) return send(413, { error: 'Request too large' });
      chunks.push(chunk);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (request.url === '/enqueue') {
      if (jobs.has(body.jobId)) return send(409, { error: 'Job already enqueued' });
      const current = await authority('/state', { rootId: body.rootId });
      if (!current.active) return send(409, { error: 'Active authority required at enqueue' });
      jobs.set(body.jobId, { ...body, authorizedAtEnqueue: current.active, lastState: 'queued' });
      return send(201, { state: 'queued' });
    }
    const job = jobs.get(body.jobId);
    if (!job) return send(404, { error: 'Unknown job' });
    if (request.url === '/status') {
      const current = await authority('/state', { rootId: job.rootId });
      return send(200, {
        rootId: job.rootId,
        jobId: job.jobId,
        state: current.active ? job.lastState : 'cancelled',
      });
    }
    if (request.url !== '/dispatch') return send(404, { error: 'Unknown operation' });
    const requestDigest = digest(job);
    await authority('/dispatch-record', {
      rootId: job.rootId,
      jobId: job.jobId,
      attemptId: body.attemptId,
      requestDigest,
    });
    const current = await authority('/state', { rootId: job.rootId });
    if (!mayDispatch(job, current.active)) {
      job.lastState = 'denied';
      return send(200, { state: 'denied' });
    }
    // Business data goes only to the separately owned loopback destination.
    const accepted = await fetch(destinationUrl, {
      method: 'POST',
      redirect: 'error',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${destinationToken}` },
      body: JSON.stringify({
        rootId: job.rootId,
        jobId: job.jobId,
        attemptId: body.attemptId,
        destination: job.destination,
        payload: job.payload,
      }),
      signal: AbortSignal.timeout(3000),
    });
    if (!accepted.ok) return send(503, { error: 'Destination unavailable' });
    job.lastState = 'accepted';
    return send(200, { state: 'accepted' });
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
