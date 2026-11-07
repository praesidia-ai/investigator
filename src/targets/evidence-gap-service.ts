import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { InvestigatorError } from '../core/errors.js';
import { jsonDigest } from '../core/json.js';
import { readRequestText } from '../core/http-body.js';
import { parseInput, parseJson } from '../core/parse.js';
import { digestSchema } from '../core/schemas.js';
import { decodeUtf8, readBoundedFile } from '../io/read-file.js';
import {
  BOUND_EVIDENCE_PRODUCER,
  LEGACY_EVIDENCE_PRODUCER,
  type EvidenceGapSources,
} from '../remediation/evidence-recipe.js';
import {
  acceptObserverRequest,
  closeServer,
  postLoopbackJson,
  stopChild,
  waitForChildPort,
} from './process-lifecycle.js';

const idSchema = z.string().min(1).max(160);
const timeSchema = z.iso.datetime();
export const EVIDENCE_GAP_POLICY_REVISION = 'independent-export-approval.v1';
export const SYNTHETIC_CUSTOMER_CANARY =
  'INVESTIGATOR_SYNTHETIC_CUSTOMER_CONTENT_do_not_collect_7a92';
export const EVIDENCE_GAP_SCENARIOS = [
  { id: 'permitted', expectation: 'executed' },
  { id: 'wrong-request', expectation: 'denied' },
  { id: 'self-approval', expectation: 'denied' },
  { id: 'no-approval', expectation: 'denied' },
] as const;

export const approvalWitnessSchema = z
  .object({
    workId: idSchema,
    grantId: idSchema,
    actorId: idSchema,
    reviewerId: idSchema,
    requestDigest: digestSchema,
    policyRevision: idSchema,
    deploymentRevision: digestSchema,
    observedAt: timeSchema,
  })
  .strict();
export const executionWitnessSchema = z
  .object({
    type: z.literal('execution'),
    executionId: idSchema,
    workId: idSchema,
    grantId: idSchema,
    actorId: idSchema,
    requestDigest: digestSchema,
    policyRevision: idSchema,
    deploymentRevision: digestSchema,
    observedAt: timeSchema,
  })
  .strict();
export const decisionWitnessSchema = z
  .object({
    type: z.literal('decision'),
    workId: idSchema,
    grantId: idSchema.nullable(),
    actorId: idSchema,
    requestDigest: digestSchema,
    decision: z.enum(['executed', 'denied']),
    policyRevision: idSchema,
    deploymentRevision: digestSchema,
    observedAt: timeSchema,
  })
  .strict();
export const legacyExecutionSchema = z
  .object({
    type: z.literal('legacy-execution'),
    executionId: idSchema,
    deploymentRevision: digestSchema,
    observedAt: timeSchema,
  })
  .strict();
export const effectReceiptSchema = z
  .object({
    executionId: idSchema,
    requestDigest: digestSchema,
    observedAt: timeSchema,
  })
  .strict();
export const attemptWitnessSchema = z
  .object({
    workId: idSchema,
    actorId: idSchema,
    grantId: idSchema.nullable(),
    requestDigest: digestSchema,
  })
  .strict();
export const evidenceGapScenarioSchema = z
  .object({
    id: z.enum(['permitted', 'wrong-request', 'self-approval', 'no-approval']),
    workId: idSchema,
    expectation: z.enum(['executed', 'denied']),
    attempt: attemptWitnessSchema,
    approval: approvalWitnessSchema.nullable(),
    telemetry: z
      .array(
        z.discriminatedUnion('type', [
          executionWitnessSchema,
          decisionWitnessSchema,
          legacyExecutionSchema,
        ]),
      )
      .max(8),
    effects: z.array(effectReceiptSchema).max(8),
    responseStatus: z.enum(['executed', 'denied']),
  })
  .strict();
export const evidenceGapRunSchema = z
  .object({
    schemaVersion: z.literal(1),
    authorization: z.enum(['safe', 'unsafe']),
    instrumentation: z.enum(['legacy', 'bound']),
    sourceRevision: digestSchema,
    startedAt: timeSchema,
    finishedAt: timeSchema,
    capture: z
      .object({
        status: z.literal('complete'),
        scope: z.literal('isolated-authored-workload'),
        sinkClosed: z.literal(true),
      })
      .strict(),
    scenarios: z.array(evidenceGapScenarioSchema).length(4),
    businessDigest: digestSchema,
  })
  .strict();
export type ApprovalWitness = z.infer<typeof approvalWitnessSchema>;
export type ExecutionWitness = z.infer<typeof executionWitnessSchema>;
export type DecisionWitness = z.infer<typeof decisionWitnessSchema>;
export type EffectReceipt = z.infer<typeof effectReceiptSchema>;
export type AttemptWitness = z.infer<typeof attemptWitnessSchema>;
export type EvidenceGapScenario = z.infer<typeof evidenceGapScenarioSchema>;
export type EvidenceGapRun = z.infer<typeof evidenceGapRunSchema>;

const businessRequestSchema = z
  .object({
    workId: idSchema,
    actorId: idSchema,
    destination: z.string().min(1).max(256),
    payload: z.object({ customerContent: z.string().max(4096) }).strict(),
    grantId: idSchema.nullable(),
  })
  .strict();
type BusinessRequest = z.infer<typeof businessRequestSchema>;
const effectEnvelopeSchema = z
  .object({ executionId: idSchema, request: businessRequestSchema })
  .strict();
const responseSchema = z.object({ status: z.enum(['executed', 'denied']) }).strict();
const telemetryResponseSchema = z
  .object({ telemetry: evidenceGapScenarioSchema.shape.telemetry })
  .strict();
const FILES = ['server.mjs', 'instrumentation.mjs'] as const;

function bundledFile(file: (typeof FILES)[number]): string {
  return fileURLToPath(new URL(`../../examples/evidence-gap-service/${file}`, import.meta.url));
}

/** Copy only this shipped fixture. No repository checkout or arbitrary user code is executed. */
export async function copyEvidenceGapService(directory: string): Promise<void> {
  for (const file of FILES) await copyFile(bundledFile(file), join(directory, file), 1);
}

export async function evidenceGapServiceSources(directory: string): Promise<EvidenceGapSources> {
  return {
    'server.mjs': decodeUtf8(await readBoundedFile(join(directory, 'server.mjs'), 65_536)),
    'instrumentation.mjs': decodeUtf8(
      await readBoundedFile(join(directory, 'instrumentation.mjs'), 65_536),
    ),
  };
}

export async function evidenceGapServiceRevision(directory: string): Promise<string> {
  return jsonDigest({ ...(await evidenceGapServiceSources(directory)) });
}

/** The declared business request commitment excludes transport grant ID and includes business data. */
function requestDigest(request: BusinessRequest): string {
  const { workId, actorId, destination, payload } = request;
  return jsonDigest({ workId, actorId, destination, payload });
}

/** Compare actual outcomes, not random receipt IDs or changing instrumentation revisions. */
export function evidenceGapBusinessDigest(scenarios: readonly EvidenceGapScenario[]): string {
  return jsonDigest(
    scenarios.map((scenario) => ({
      id: scenario.id,
      attempt: scenario.attempt,
      approval: scenario.approval
        ? {
            workId: scenario.approval.workId,
            grantId: scenario.approval.grantId,
            actorId: scenario.approval.actorId,
            reviewerId: scenario.approval.reviewerId,
            requestDigest: scenario.approval.requestDigest,
            policyRevision: scenario.approval.policyRevision,
          }
        : null,
      responseStatus: scenario.responseStatus,
      effects: scenario.effects.map((effect) => ({ requestDigest: effect.requestDigest })),
    })),
  );
}

async function readResponse(response: Response): Promise<unknown> {
  if (!response.ok || !response.body)
    throw new InvestigatorError(
      'EVIDENCE_TARGET_UNAVAILABLE',
      'The authored fixture request failed.',
    );
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      total += result.value.byteLength;
      if (total > 65_536)
        throw new InvestigatorError(
          'EVIDENCE_RESPONSE_TOO_LARGE',
          'Fixture response is too large.',
        );
      chunks.push(result.value);
    }
    return parseJson(decodeUtf8(Buffer.concat(chunks)), 'INVALID_EVIDENCE_RESPONSE');
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/**
 * Execute the finite shipped application against a separate loopback destination.
 * This is an owned test workload, not OS sandboxing or a production completeness claim.
 */
export async function runEvidenceGapService(options: {
  readonly directory: string;
  readonly authorization: 'safe' | 'unsafe';
  readonly signal?: AbortSignal;
}): Promise<EvidenceGapRun> {
  const authorization = parseInput(
    z.enum(['safe', 'unsafe']),
    options.authorization,
    'INVALID_EVIDENCE_AUTHORIZATION',
    'Fixture authorization mode',
  );
  const signal = AbortSignal.any([
    AbortSignal.timeout(30_000),
    ...(options.signal ? [options.signal] : []),
  ]);
  signal.throwIfAborted();
  const sources = await evidenceGapServiceSources(options.directory);
  const shippedServer = decodeUtf8(await readBoundedFile(bundledFile('server.mjs'), 65_536));
  if (
    sources['server.mjs'] !== shippedServer ||
    ![LEGACY_EVIDENCE_PRODUCER, BOUND_EVIDENCE_PRODUCER].includes(sources['instrumentation.mjs'])
  )
    throw new InvestigatorError(
      'EVIDENCE_TARGET_CHANGED',
      'Only the authored application and supported evidence producer may run in this fixture.',
    );
  const sourceRevision = jsonDigest({ ...sources });
  const instrumentation =
    sources['instrumentation.mjs'] === BOUND_EVIDENCE_PRODUCER ? 'bound' : 'legacy';
  const startedAt = new Date().toISOString();
  const adminToken = randomBytes(32).toString('hex');
  const observerToken = randomBytes(32).toString('hex');
  const allEffects: EffectReceipt[] = [];
  const scenarios: EvidenceGapScenario[] = [];
  let sinkFailure = false;
  const sink = createServer(async (request, response) => {
    if (!acceptObserverRequest(request, response, observerToken)) return;
    try {
      const envelope = parseInput(
        effectEnvelopeSchema,
        parseJson(await readRequestText(request)),
        'INVALID_EVIDENCE_EFFECT',
        'Effect envelope',
      );
      // Do not save or return the raw received business payload.
      allEffects.push({
        executionId: envelope.executionId,
        requestDigest: requestDigest(envelope.request),
        observedAt: new Date().toISOString(),
      });
      response.writeHead(201);
      response.end();
    } catch {
      sinkFailure = true;
      response.writeHead(400);
      response.end();
    }
  });
  let child: ChildProcess | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      sink.once('error', reject);
      sink.listen(0, '127.0.0.1', resolve);
    });
    const address = sink.address();
    if (!address || typeof address === 'string')
      throw new InvestigatorError(
        'EVIDENCE_TARGET_UNAVAILABLE',
        'The independent sink could not start.',
      );
    child = spawn(process.execPath, [join(options.directory, 'server.mjs')], {
      cwd: options.directory,
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      env: {
        EVIDENCE_FIXTURE_ADMIN_TOKEN: adminToken,
        EVIDENCE_FIXTURE_OBSERVER_TOKEN: observerToken,
        EVIDENCE_FIXTURE_OBSERVER_URL: `http://127.0.0.1:${address.port}/effects`,
        EVIDENCE_FIXTURE_REVISION: sourceRevision,
        EVIDENCE_FIXTURE_AUTHORIZATION: authorization,
      },
    });
    const port = await waitForChildPort(child, signal, [
      'EVIDENCE_TARGET_UNAVAILABLE',
      'The authored service could not start.',
    ]);
    const post = async (path: string, body: unknown, admin = false): Promise<unknown> =>
      readResponse(
        await postLoopbackJson(port, path, body, signal, admin ? adminToken : undefined),
      );
    for (const scenario of EVIDENCE_GAP_SCENARIOS) {
      signal.throwIfAborted();
      const workId = `work:${scenario.id}`;
      const grantId = `grant:${scenario.id}`;
      const request: BusinessRequest = {
        workId,
        actorId: 'agent:export',
        destination: scenario.id === 'wrong-request' ? 'customer:unexpected' : 'customer:approved',
        payload: { customerContent: SYNTHETIC_CUSTOMER_CANARY },
        grantId: scenario.id === 'no-approval' ? null : grantId,
      };
      const approvedRequest = { ...request, destination: 'customer:approved' };
      const approval: ApprovalWitness | null =
        scenario.id === 'no-approval'
          ? null
          : {
              workId,
              grantId,
              actorId: request.actorId,
              reviewerId:
                scenario.id === 'self-approval' ? request.actorId : 'reviewer:control-owner',
              requestDigest: requestDigest(approvedRequest),
              policyRevision: EVIDENCE_GAP_POLICY_REVISION,
              deploymentRevision: sourceRevision,
              observedAt: new Date().toISOString(),
            };
      const configured = await post('/__test__/configure', { grant: approval }, true);
      parseInput(
        z.object({ ready: z.literal(true) }).strict(),
        configured,
        'INVALID_EVIDENCE_RESPONSE',
        'Configuration',
      );
      const effectStart = allEffects.length;
      // This supervisor-owned commitment records the actual attempted business operation before
      // the application can claim that it denied or executed it. Raw payloads are not retained.
      const attempt: AttemptWitness = {
        workId: request.workId,
        actorId: request.actorId,
        grantId: request.grantId,
        requestDigest: requestDigest(request),
      };
      const response = parseInput(
        responseSchema,
        await post('/export', request),
        'INVALID_EVIDENCE_RESPONSE',
        'Export response',
      );
      const observed = parseInput(
        telemetryResponseSchema,
        await post('/__test__/telemetry', {}, true),
        'INVALID_EVIDENCE_RESPONSE',
        'Telemetry',
      );
      scenarios.push({
        id: scenario.id,
        workId,
        expectation: scenario.expectation,
        attempt,
        approval,
        telemetry: observed.telemetry,
        effects: structuredClone(allEffects.slice(effectStart)),
        responseStatus: response.status,
      });
    }
    if (sinkFailure || (await evidenceGapServiceRevision(options.directory)) !== sourceRevision)
      throw new InvestigatorError(
        'EVIDENCE_CAPTURE_FAILED',
        'The source or independent capture changed during the workload.',
      );
  } finally {
    await stopChild(child);
    await closeServer(sink);
  }
  return parseInput(
    evidenceGapRunSchema,
    {
      schemaVersion: 1,
      authorization,
      instrumentation,
      sourceRevision,
      startedAt,
      finishedAt: new Date().toISOString(),
      capture: { status: 'complete', scope: 'isolated-authored-workload', sinkClosed: true },
      scenarios,
      businessDigest: evidenceGapBusinessDigest(scenarios),
    },
    'INVALID_EVIDENCE_RUN',
    'Evidence capture',
  );
}
