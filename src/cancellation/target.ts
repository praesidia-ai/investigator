import { spawn, type ChildProcess } from 'node:child_process';
import { constants } from 'node:fs';
import { copyFile, writeFile } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, type Server, type IncomingMessage } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { InvestigatorError } from '../core/errors.js';
import { jsonDigest } from '../core/json.js';
import { readRequestText, readResponseText } from '../core/http-body.js';
import { parseInput, parseJson } from '../core/parse.js';
import { decodeUtf8, readBoundedFile } from '../io/read-file.js';
import {
  BLOCKED_WORKER_SOURCE,
  CACHED_WORKER_SOURCE,
  CURRENT_WORKER_SOURCE,
  type CancellationServiceSources,
} from './recipe.js';
import {
  cancellationCaptureSchema,
  cancellationExperimentIdSchema,
  type CancellationCapture,
  type CancellationExperimentId,
} from './schemas.js';

export const CANCELLATION_CONTENT_CANARY =
  'INVESTIGATOR_SYNTHETIC_CANCELLATION_CONTENT_do_not_collect_05bf';
export const cancellationFixtureModeSchema = z.enum([
  'cached-worker',
  'current-worker',
  'capture-gap',
  'block-all',
]);
export type CancellationFixtureMode = z.infer<typeof cancellationFixtureModeSchema>;

const rootSchema = z.enum(['root:retired', 'root:independent']);
const id = z.string().min(1).max(160);
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const jobSchema = z
  .object({
    rootId: rootSchema,
    jobId: id,
    destination: z.literal('synthetic:export-destination'),
    payload: z.object({ customerContent: z.string().min(1).max(4096) }).strict(),
  })
  .strict();
type Job = z.infer<typeof jobSchema>;
const dispatchRecordSchema = z
  .object({ rootId: rootSchema, jobId: id, attemptId: id, requestDigest: digestSchema })
  .strict();
const effectSchema = jobSchema.extend({ attemptId: id }).strict();
const captureControlSchema = z.object({ status: z.enum(['complete', 'partial']) }).strict();
const statusSchema = z
  .object({
    rootId: rootSchema,
    jobId: id,
    state: z.enum(['queued', 'cancelled', 'accepted', 'denied']),
  })
  .strict();
const FILES = ['server.mjs', 'worker-authority.mjs'] as const;

function bundled(file: (typeof FILES)[number]): string {
  return fileURLToPath(new URL(`../../examples/cancellation-service/${file}`, import.meta.url));
}

/** Copy the authored application only. Operator capture control is never model evidence. */
export async function prepareCancellationService(
  directory: string,
  modeInput: CancellationFixtureMode,
): Promise<void> {
  const mode = parseInput(
    cancellationFixtureModeSchema,
    modeInput,
    'INVALID_CANCELLATION_MODE',
    'Fixture selection',
  );
  await copyFile(bundled('server.mjs'), join(directory, 'server.mjs'), constants.COPYFILE_EXCL);
  const worker =
    mode === 'current-worker'
      ? CURRENT_WORKER_SOURCE
      : mode === 'block-all'
        ? BLOCKED_WORKER_SOURCE
        : CACHED_WORKER_SOURCE;
  await writeFile(join(directory, 'worker-authority.mjs'), worker, { flag: 'wx', mode: 0o600 });
  await writeFile(
    join(directory, '.capture-control.json'),
    JSON.stringify({ status: mode === 'capture-gap' ? 'partial' : 'complete' }),
    { flag: 'wx', mode: 0o600 },
  );
}

export async function cancellationServiceSources(
  directory: string,
): Promise<CancellationServiceSources> {
  return {
    'server.mjs': decodeUtf8(await readBoundedFile(join(directory, 'server.mjs'), 65_536)),
    'worker-authority.mjs': decodeUtf8(
      await readBoundedFile(join(directory, 'worker-authority.mjs'), 65_536),
    ),
  };
}
export async function cancellationServiceRevision(directory: string): Promise<string> {
  return jsonDigest({ ...(await cancellationServiceSources(directory)) });
}

function jobDigest(job: Job): string {
  return jsonDigest({
    rootId: job.rootId,
    jobId: job.jobId,
    destination: job.destination,
    payload: job.payload,
  });
}

async function requestJson(request: IncomingMessage): Promise<unknown> {
  return parseJson(await readRequestText(request), 'INVALID_CANCELLATION_REQUEST');
}

async function responseJson(response: Response): Promise<unknown> {
  return parseJson(
    await readResponseText(response, {
      unavailable: ['CANCELLATION_TARGET_UNAVAILABLE', 'The authored workflow request failed.'],
      tooLarge: [
        'CANCELLATION_RESPONSE_TOO_LARGE',
        'The authored workflow response exceeded its bound.',
      ],
    }),
    'INVALID_CANCELLATION_RESPONSE',
  );
}

async function startServer(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new InvestigatorError(
      'CANCELLATION_TARGET_UNAVAILABLE',
      'A supervisor-owned service could not start.',
    );
  return address.port;
}
async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
}
async function stopChild(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    const kill = setTimeout(() => {
      child.kill('SIGKILL');
    }, 1200);
    const deadline = setTimeout(() => {
      cleanup();
      reject(
        new InvestigatorError(
          'CANCELLATION_CAPTURE_OPEN',
          'The worker did not close within the capture deadline.',
        ),
      );
    }, 3000);
    const cleanup = () => {
      clearTimeout(kill);
      clearTimeout(deadline);
      child.off('exit', stopped);
    };
    const stopped = () => {
      cleanup();
      resolve();
    };
    child.once('exit', stopped);
    child.kill('SIGTERM');
  });
}

/**
 * Run one finite sequential experiment. A child queue/worker uses real HTTP authority
 * reads and a separate destination. This is not a sandbox or distributed fence protocol.
 */
export async function runCancellationExperiment(options: {
  readonly directory: string;
  readonly experimentId: CancellationExperimentId;
  readonly signal?: AbortSignal;
}): Promise<CancellationCapture> {
  const experimentId = parseInput(
    cancellationExperimentIdSchema,
    options.experimentId,
    'INVALID_CANCELLATION_EXPERIMENT',
    'Experiment',
  );
  const signal = AbortSignal.any([
    AbortSignal.timeout(30_000),
    ...(options.signal ? [options.signal] : []),
  ]);
  signal.throwIfAborted();
  const sources = await cancellationServiceSources(options.directory);
  const shippedServer = decodeUtf8(await readBoundedFile(bundled('server.mjs'), 65_536));
  if (
    sources['server.mjs'] !== shippedServer ||
    ![CACHED_WORKER_SOURCE, CURRENT_WORKER_SOURCE, BLOCKED_WORKER_SOURCE].includes(
      sources['worker-authority.mjs'],
    )
  )
    throw new InvestigatorError(
      'CANCELLATION_TARGET_CHANGED',
      'Only the shipped application and known worker predicates may execute.',
    );
  const controlBytes = await readBoundedFile(
    join(options.directory, '.capture-control.json'),
    4096,
  );
  const captureControl = parseInput(
    captureControlSchema,
    parseJson(decodeUtf8(controlBytes)),
    'INVALID_CANCELLATION_CAPTURE',
    'Operator capture boundary',
  );
  const subjectRevision = jsonDigest({ ...sources });
  const startedAt = new Date().toISOString();
  const runId = randomUUID();
  const supervisorToken = randomBytes(32).toString('hex');
  const authorityToken = randomBytes(32).toString('hex');
  const destinationToken = randomBytes(32).toString('hex');
  let sequence = 0;
  let revoked = false;
  let cut: CancellationCapture['cut'] = null;
  let captureFailure = false;
  const attempts: CancellationCapture['attempts'] = [];
  const effects: CancellationCapture['effects'] = [];
  const workerClaims: CancellationCapture['workerClaims'] = [];
  const jobs = new Map<string, { job: Job; enqueueSequence: number; requestDigest: string }>();
  const pendingAttempts = new Map<
    string,
    { rootId: Job['rootId']; jobId: string; requestDigest: string; enqueueSequence: number }
  >();
  const seenAttempts = new Set<string>();

  const authority = createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json');
    const send = (status: number, body: unknown) => {
      response.writeHead(status);
      response.end(JSON.stringify(body));
    };
    try {
      if (request.method !== 'POST') return send(405, {});
      if (request.url === '/revoke') {
        if (request.headers.authorization !== `Bearer ${supervisorToken}`) return send(403, {});
        const body = z
          .object({ rootId: z.literal('root:retired') })
          .strict()
          .parse(await requestJson(request));
        if (cut) return send(409, {});
        revoked = true;
        cut = {
          rootId: body.rootId,
          ackSequence: ++sequence,
          observedAt: new Date().toISOString(),
        };
        return send(200, cut);
      }
      if (request.headers.authorization !== `Bearer ${authorityToken}`) return send(403, {});
      if (request.url === '/state') {
        const body = z
          .object({ rootId: rootSchema })
          .strict()
          .parse(await requestJson(request));
        return send(200, { active: body.rootId === 'root:independent' || !revoked });
      }
      if (request.url !== '/dispatch-record') return send(404, {});
      const body = dispatchRecordSchema.parse(await requestJson(request));
      const pending = pendingAttempts.get(body.attemptId);
      if (
        !pending ||
        seenAttempts.has(body.attemptId) ||
        pending.rootId !== body.rootId ||
        pending.jobId !== body.jobId ||
        pending.requestDigest !== body.requestDigest
      )
        throw new Error('correlation');
      const dispatchSequence = ++sequence;
      attempts.push({ ...pending, attemptId: body.attemptId, dispatchSequence });
      seenAttempts.add(body.attemptId);
      return send(200, { dispatchSequence });
    } catch {
      captureFailure = true;
      return send(400, {});
    }
  });
  const destination = createServer(async (request, response) => {
    if (
      request.method !== 'POST' ||
      request.url !== '/accept' ||
      request.headers.authorization !== `Bearer ${destinationToken}`
    ) {
      response.writeHead(403);
      response.end();
      return;
    }
    try {
      const body = effectSchema.parse(await requestJson(request));
      const job = jobs.get(body.jobId);
      const attempt = attempts.find((item) => item.attemptId === body.attemptId);
      const requestDigest = jobDigest(body);
      if (
        !job ||
        !attempt ||
        attempt.rootId !== body.rootId ||
        attempt.jobId !== body.jobId ||
        attempt.requestDigest !== requestDigest ||
        effects.some((effect) => effect.attemptId === body.attemptId)
      )
        throw new Error('correlation');
      // The independent destination computes its commitment from the received business request.
      // Raw synthetic customer content is not saved in the receipt or capture report.
      effects.push({
        rootId: body.rootId,
        jobId: body.jobId,
        attemptId: body.attemptId,
        requestDigest,
        acceptSequence: ++sequence,
        observedAt: new Date().toISOString(),
      });
      response.writeHead(201);
      response.end();
    } catch {
      captureFailure = true;
      response.writeHead(400);
      response.end();
    }
  });
  let child: ChildProcess | undefined;
  try {
    const authorityPort = await startServer(authority);
    const destinationPort = await startServer(destination);
    child = spawn(process.execPath, [join(options.directory, 'server.mjs')], {
      cwd: options.directory,
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      env: {
        CANCELLATION_SUPERVISOR_TOKEN: supervisorToken,
        CANCELLATION_AUTHORITY_TOKEN: authorityToken,
        CANCELLATION_AUTHORITY_URL: `http://127.0.0.1:${authorityPort}`,
        CANCELLATION_DESTINATION_TOKEN: destinationToken,
        CANCELLATION_DESTINATION_URL: `http://127.0.0.1:${destinationPort}/accept`,
      },
    });
    const target = child;
    const port = await new Promise<number>((resolve, reject) => {
      const fail = () => {
        cleanup();
        reject(
          new InvestigatorError(
            'CANCELLATION_TARGET_UNAVAILABLE',
            'The authored queue/worker could not start.',
          ),
        );
      };
      const ready = (input: unknown) => {
        const parsed = z
          .object({ port: z.number().int().min(1).max(65535) })
          .strict()
          .safeParse(input);
        if (parsed.success) {
          cleanup();
          resolve(parsed.data.port);
        }
      };
      const timer = setTimeout(fail, 5000);
      const cleanup = () => {
        clearTimeout(timer);
        target.off('error', fail);
        target.off('exit', fail);
        target.off('message', ready);
        signal.removeEventListener('abort', fail);
      };
      target.once('error', fail);
      target.once('exit', fail);
      target.on('message', ready);
      signal.addEventListener('abort', fail, { once: true });
      if (signal.aborted) fail();
    });
    const post = async (url: string, body: unknown, token: string) =>
      responseJson(await fetchResponse(url, body, token, signal));
    const servicePost = async (path: string, body: unknown) =>
      responseJson(
        await fetchResponse(`http://127.0.0.1:${port}${path}`, body, supervisorToken, signal),
      );
    const enqueue = async (rootId: Job['rootId'], jobId: string) => {
      const job: Job = {
        rootId,
        jobId,
        destination: 'synthetic:export-destination',
        payload: { customerContent: CANCELLATION_CONTENT_CANARY },
      };
      const enqueueSequence = ++sequence;
      jobs.set(jobId, { job, enqueueSequence, requestDigest: jobDigest(job) });
      const response = await servicePost('/enqueue', job);
      parseInput(
        z.object({ state: z.literal('queued') }).strict(),
        response,
        'INVALID_CANCELLATION_RESPONSE',
        'Enqueue acknowledgement',
      );
    };
    const status = async (jobId: string) => {
      workerClaims.push(
        parseInput(
          statusSchema,
          await servicePost('/status', { jobId }),
          'INVALID_CANCELLATION_RESPONSE',
          'Worker state',
        ),
      );
    };
    const dispatch = async (jobId: string, attemptId: string) => {
      const job = jobs.get(jobId)!;
      pendingAttempts.set(attemptId, {
        rootId: job.job.rootId,
        jobId,
        requestDigest: job.requestDigest,
        enqueueSequence: job.enqueueSequence,
      });
      parseInput(
        z.object({ state: z.enum(['accepted', 'denied']) }).strict(),
        await servicePost('/dispatch', { jobId, attemptId }),
        'INVALID_CANCELLATION_RESPONSE',
        'Worker response',
      );
      if (!seenAttempts.has(attemptId))
        throw new InvestigatorError(
          'CANCELLATION_CAPTURE_INCOMPLETE',
          'The supervisor did not observe the attempted dispatch.',
        );
      await status(jobId);
    };
    const revoke = async () => {
      const response = await post(
        `http://127.0.0.1:${authorityPort}/revoke`,
        { rootId: 'root:retired' },
        supervisorToken,
      );
      parseInput(
        z
          .object({
            rootId: z.literal('root:retired'),
            ackSequence: z.number().int().positive(),
            observedAt: z.iso.datetime(),
          })
          .strict(),
        response,
        'INVALID_CANCELLATION_RESPONSE',
        'Revocation acknowledgement',
      );
    };
    await enqueue('root:retired', 'job:primary');
    if (experimentId === 'independent-root') await enqueue('root:independent', 'job:independent');
    if (experimentId === 'accepted-before-revoke') await dispatch('job:primary', 'attempt:initial');
    await revoke();
    await status('job:primary');
    if (experimentId !== 'accepted-before-revoke') await dispatch('job:primary', 'attempt:initial');
    if (experimentId === 'retry-after-revoke') await dispatch('job:primary', 'attempt:retry');
    if (experimentId === 'independent-root')
      await dispatch('job:independent', 'attempt:independent');
    if (
      captureFailure ||
      !cut ||
      (await cancellationServiceRevision(options.directory)) !== subjectRevision ||
      !controlBytes.equals(
        await readBoundedFile(join(options.directory, '.capture-control.json'), 4096),
      )
    )
      throw new InvestigatorError(
        'CANCELLATION_CAPTURE_FAILED',
        'The source or supervisor capture changed during the finite workload.',
      );
  } finally {
    try {
      await stopChild(child);
    } finally {
      await closeServer(authority);
      await closeServer(destination);
    }
  }
  return parseInput(
    cancellationCaptureSchema,
    {
      schemaVersion: 1,
      experimentId,
      runId,
      subjectRevision,
      startedAt,
      finishedAt: new Date().toISOString(),
      scope: 'authored-loopback-workflow',
      observation: {
        status: captureControl.status,
        windowClosed: true,
        limitations:
          captureControl.status === 'partial'
            ? [
                'The selected export omits the trusted revocation acknowledgement; its boundary cannot be established.',
              ]
            : [
                'Capture covers only this finite sequential authored loopback workload, not arbitrary distributed races or external paths.',
              ],
      },
      cut: captureControl.status === 'partial' ? null : cut,
      attempts,
      effects,
      workerClaims,
    },
    'INVALID_CANCELLATION_CAPTURE',
    'Cancellation capture',
  );
}

async function fetchResponse(
  url: string,
  body: unknown,
  token: string,
  signal: AbortSignal,
): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    redirect: 'error',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
    signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
  });
}
