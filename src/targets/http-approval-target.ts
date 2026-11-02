import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ControlCheckAdapter } from '../core/control-target.js';
import { InvestigatorError } from '../core/errors.js';
import { jsonDigest, type JsonObject } from '../core/json.js';
import { parseInput, parseJson } from '../core/parse.js';
import { jsonValueSchema } from '../core/schemas.js';
import { decodeUtf8, readBoundedFile } from '../io/read-file.js';
import {
  runExternalApprovalChecks,
  type ApprovalProbeDriver,
  type SinkEffect,
} from '../reference/approval-control.js';

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const idSchema = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/);
const envNameSchema = z.string().regex(/^[A-Z_][A-Z0-9_]{0,127}$/);
const baseUrlSchema = z
  .string()
  .max(2048)
  .superRefine((value, context) => {
    try {
      const url = new URL(value);
      if (
        !['https:', 'http:'].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        !['', '/'].includes(url.pathname)
      )
        throw new Error();
    } catch {
      context.addIssue({
        code: 'custom',
        message: 'Expected an HTTP(S) origin without credentials',
      });
    }
  });

/** Operator configuration only: credentials are environment names, never literal values. */
export const httpApprovalTargetConfigSchema = z
  .object({
    kind: z.literal('http-approval-target'),
    schemaVersion: z.literal(1),
    fixtureProtocol: z.literal('approval-target-v1'),
    subjectRevision: digestSchema,
    target: z
      .object({
        baseUrl: baseUrlSchema,
        credentialEnv: envNameSchema,
        adminCredentialEnv: envNameSchema,
      })
      .strict(),
    observer: z.object({ baseUrl: baseUrlSchema, credentialEnv: envNameSchema }).strict(),
    allowLoopbackHttp: z.boolean().default(false),
    timeoutMs: z.number().int().min(100).max(30_000).default(5000),
    maxResponseBytes: z.number().int().min(4096).max(1_048_576).default(262_144),
  })
  .strict()
  .superRefine((config, context) => {
    for (const [name, endpoint] of [
      ['target', config.target],
      ['observer', config.observer],
    ] as const) {
      let url: URL;
      try {
        url = new URL(endpoint.baseUrl);
      } catch {
        continue;
      }
      if (
        url.protocol === 'http:' &&
        (!config.allowLoopbackHttp || !['127.0.0.1', '[::1]'].includes(url.hostname))
      ) {
        context.addIssue({
          code: 'custom',
          path: [name, 'baseUrl'],
          message: 'HTTPS is required except explicitly selected literal loopback HTTP',
        });
      }
    }
    const names = [
      config.target.credentialEnv,
      config.target.adminCredentialEnv,
      config.observer.credentialEnv,
    ];
    if (new Set(names).size !== names.length) {
      context.addIssue({
        code: 'custom',
        path: ['target'],
        message:
          'Submit, fixture admin and observer credentials must have separate environment names',
      });
    }
    try {
      if (new URL(config.target.baseUrl).origin === new URL(config.observer.baseUrl).origin) {
        context.addIssue({
          code: 'custom',
          path: ['observer'],
          message: 'The effect observer must use a separate origin',
        });
      }
    } catch {
      /* Individual URL validation already records the invalid origin. */
    }
  });
export type HttpApprovalTargetConfig = z.infer<typeof httpApprovalTargetConfigSchema>;

const identitySchema = z
  .object({
    protocol: z.literal('approval-target-v1'),
    fixture: z.literal(true),
    role: z.enum(['target', 'observer']),
    subjectRevision: digestSchema,
  })
  .strict();
const sessionSchema = z
  .object({
    runId: idSchema,
    scenarioId: idSchema,
    subjectRevision: digestSchema,
    captureToken: z.string().min(32).max(256),
  })
  .strict();
const attemptSchema = z
  .object({
    runId: idSchema,
    scenarioId: idSchema,
    attemptId: idSchema,
    requestDigest: digestSchema,
    challenge: z.string().min(32).max(256),
  })
  .strict();
const resetSchema = z
  .object({
    runId: idSchema,
    scenarioId: idSchema,
    subjectRevision: digestSchema,
    grantsDigest: digestSchema,
    now: z.number().int(),
    ready: z.literal(true),
  })
  .strict();
const responseSchema = z
  .object({
    status: z.enum(['executed', 'approval_required', 'denied', 'unavailable']),
    reason: z.string().max(1024),
    claimedEffectCount: z.number().int().min(0).max(64),
  })
  .strict();
const effectSchema = z
  .object({
    sequence: z.number().int().min(1).max(64),
    requestId: z.string().min(1).max(256),
    action: z.enum(['customer.export', 'reference.ping']),
    actorId: z.string().min(1).max(256),
    destination: z.string().min(1).max(1024),
    payload: z.record(z.string(), jsonValueSchema),
    requestDigest: digestSchema,
  })
  .strict();
const snapshotSchema = z
  .object({
    runId: idSchema,
    scenarioId: idSchema,
    subjectRevision: digestSchema,
    coverage: z.literal('complete'),
    settledAttemptIds: z.array(idSchema).max(64),
    effects: z.array(z.object({ attemptId: idSchema, effect: effectSchema }).strict()).max(64),
  })
  .strict();

function failure(code = 'TARGET_PROTOCOL_ERROR'): InvestigatorError {
  return new InvestigatorError(
    code,
    'The selected target or independent observer did not provide complete matching fixture evidence.',
  );
}

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(failure('TARGET_REQUEST_ABORTED'));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    operation
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', abort))
      .catch(() => {});
  });
}

function credential(env: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = env[name];
  if (!value || value.length < 16 || value.length > 4096 || /[\r\n]/.test(value)) {
    throw new InvestigatorError(
      'TARGET_CREDENTIAL_REQUIRED',
      'Set each selected target and observer credential to a distinct secret of at least 16 characters.',
    );
  }
  return value;
}

export function createHttpApprovalTarget(
  input: unknown,
  env: Readonly<Record<string, string | undefined>>,
  options: { fetch?: typeof fetch } = {},
): ControlCheckAdapter {
  const config = parseInput(
    httpApprovalTargetConfigSchema,
    input,
    'INVALID_TARGET_CONFIG',
    'HTTP target configuration',
  );
  const submitCredential = credential(env, config.target.credentialEnv);
  const adminCredential = credential(env, config.target.adminCredentialEnv);
  const observerCredential = credential(env, config.observer.credentialEnv);
  if (new Set([submitCredential, adminCredential, observerCredential]).size !== 3) {
    throw new InvestigatorError(
      'INVALID_TARGET_CONFIG',
      'Submit, fixture admin and observer credentials must have distinct values.',
    );
  }
  const configurationDigest = jsonDigest(config);
  const privateValues = new Set([submitCredential, adminCredential, observerCredential]);
  const transport = options.fetch ?? fetch;
  let running = false;

  async function request(
    base: string,
    path: string,
    secret: string,
    signal: AbortSignal,
    body?: JsonObject,
  ): Promise<unknown> {
    const callSignal = AbortSignal.any([signal, AbortSignal.timeout(config.timeoutMs)]);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      callSignal.throwIfAborted();
      const encoded = body === undefined ? undefined : JSON.stringify(body);
      if (encoded !== undefined && Buffer.byteLength(encoded) > config.maxResponseBytes)
        throw failure();
      const reply = await abortable(
        transport(new URL(path, base), {
          method: body === undefined ? 'GET' : 'POST',
          redirect: 'error',
          headers: {
            Authorization: `Bearer ${secret}`,
            Accept: 'application/json',
            ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          },
          ...(encoded === undefined ? {} : { body: encoded }),
          signal: callSignal,
        }),
        callSignal,
      );
      if (
        !reply.ok ||
        reply.redirected ||
        !reply.body ||
        !reply.headers.get('content-type')?.toLowerCase().startsWith('application/json')
      )
        throw failure();
      const declaredSize = reply.headers.get('content-length');
      if (
        declaredSize !== null &&
        (!/^\d+$/.test(declaredSize) || Number(declaredSize) > config.maxResponseBytes)
      )
        throw failure();
      reader = reply.body.getReader();
      let size = 0;
      const chunks: Uint8Array[] = [];
      for (;;) {
        const next = await abortable(reader.read(), callSignal);
        if (next.done) break;
        size += next.value.byteLength;
        if (size > config.maxResponseBytes) throw failure();
        chunks.push(next.value);
      }
      callSignal.throwIfAborted();
      const text = decodeUtf8(Buffer.concat(chunks));
      if ([...privateValues].some((secretValue) => text.includes(secretValue)))
        throw failure('PRIVATE_TARGET_RESPONSE');
      const document = parseJson(text, 'INVALID_TARGET_RESPONSE');
      const pending: [unknown, number][] = [[document, 0]];
      let nodes = 0;
      while (pending.length) {
        const [value, depth] = pending.pop()!;
        if (++nodes > 50_000 || depth > 48) throw failure();
        if (
          typeof value === 'string' &&
          [...privateValues].some((secretValue) => value.includes(secretValue))
        )
          throw failure('PRIVATE_TARGET_RESPONSE');
        if (Array.isArray(value)) for (const child of value) pending.push([child, depth + 1]);
        else if (value !== null && typeof value === 'object')
          for (const [key, child] of Object.entries(value)) {
            if ([...privateValues].some((secretValue) => key.includes(secretValue)))
              throw failure('PRIVATE_TARGET_RESPONSE');
            pending.push([child, depth + 1]);
          }
      }
      return document;
    } catch {
      throw failure(callSignal.aborted ? 'TARGET_REQUEST_ABORTED' : 'TARGET_PROTOCOL_ERROR');
    } finally {
      if (reader) {
        void reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    }
  }

  async function verifyIdentity(signal: AbortSignal): Promise<void> {
    for (const [role, endpoint, secret] of [
      ['target', config.target, submitCredential],
      ['observer', config.observer, observerCredential],
    ] as const) {
      const identity = parseInput(
        identitySchema,
        await request(endpoint.baseUrl, '/__investigator__/identity', secret, signal),
        'INVALID_TARGET_IDENTITY',
        'Fixture identity',
      );
      if (identity.role !== role || identity.subjectRevision !== config.subjectRevision)
        throw failure('CHECK_TARGET_CHANGED');
    }
  }

  return Object.freeze({
    id: 'http-approval-target',
    version: 1 as const,
    subjectRevision: config.subjectRevision,
    configurationDigest,
    async runChecks(signal: AbortSignal) {
      if (running) throw failure('TARGET_ALREADY_RUNNING');
      running = true;
      const runId = randomUUID();
      let scenarioId = '';
      let captureToken = '';
      let lastAttemptId = '';
      let cache: SinkEffect[] = [];
      let sessionCreated = false;
      const attempts = new Map<string, string>();
      const context = (): JsonObject => ({
        protocol: config.fixtureProtocol,
        runId,
        scenarioId,
        attemptId: lastAttemptId,
        subjectRevision: config.subjectRevision,
        configurationDigest,
        scope: 'operator-selected-authored-fixture',
      });
      const refresh = async (callSignal: AbortSignal) => {
        const path = `/__investigator__/snapshot?${new URLSearchParams({ runId, scenarioId })}`;
        const snapshot = parseInput(
          snapshotSchema,
          await request(config.observer.baseUrl, path, observerCredential, callSignal),
          'INVALID_OBSERVER_SNAPSHOT',
          'Independent observer snapshot',
        );
        if (
          snapshot.runId !== runId ||
          snapshot.scenarioId !== scenarioId ||
          snapshot.subjectRevision !== config.subjectRevision ||
          snapshot.settledAttemptIds.length !== attempts.size ||
          new Set(snapshot.settledAttemptIds).size !== attempts.size ||
          snapshot.settledAttemptIds.some((id) => !attempts.has(id))
        )
          throw failure('INCOMPLETE_OBSERVER_CAPTURE');
        const effects = snapshot.effects.map(({ attemptId, effect }, index) => {
          if (!attempts.has(attemptId) || effect.sequence !== index + 1)
            throw failure('INVALID_OBSERVER_CAPTURE');
          if (index >= cache.length && attemptId !== lastAttemptId)
            throw failure('INVALID_OBSERVER_CAPTURE');
          const { sequence: _sequence, requestDigest: observedDigest, ...body } = effect;
          if (jsonDigest(body) !== observedDigest) throw failure('INVALID_OBSERVER_CAPTURE');
          return effect;
        });
        if (
          effects.length < cache.length ||
          jsonDigest(effects.slice(0, cache.length)) !==
            jsonDigest(cache.map((effect) => ({ ...effect })))
        )
          throw failure('INVALID_OBSERVER_CAPTURE');
        cache = effects;
      };
      const driver: ApprovalProbeDriver = {
        observerDescription: 'operator-selected-http-effect-observer',
        observationContext: context,
        async reset(grants, now, callSignal) {
          scenarioId = randomUUID();
          lastAttemptId = '';
          attempts.clear();
          cache = [];
          const session = parseInput(
            sessionSchema,
            await request(
              config.observer.baseUrl,
              '/__investigator__/sessions',
              observerCredential,
              callSignal,
              {
                schemaVersion: 1,
                runId,
                scenarioId,
                subjectRevision: config.subjectRevision,
              },
            ),
            'INVALID_OBSERVER_SESSION',
            'Observer session',
          );
          if (
            session.runId !== runId ||
            session.scenarioId !== scenarioId ||
            session.subjectRevision !== config.subjectRevision
          )
            throw failure();
          sessionCreated = true;
          captureToken = session.captureToken;
          privateValues.add(captureToken);
          const grantsJson = grants.map((grant) => ({ ...grant }));
          const grantsDigest = jsonDigest(grantsJson);
          const acknowledgement = parseInput(
            resetSchema,
            await request(
              config.target.baseUrl,
              '/__investigator__/reset',
              adminCredential,
              callSignal,
              {
                schemaVersion: 1,
                runId,
                scenarioId,
                subjectRevision: config.subjectRevision,
                grants: grantsJson,
                grantsDigest,
                now,
                captureToken,
              },
            ),
            'INVALID_TARGET_RESET',
            'Fixture reset',
          );
          if (
            acknowledgement.runId !== runId ||
            acknowledgement.scenarioId !== scenarioId ||
            acknowledgement.subjectRevision !== config.subjectRevision ||
            acknowledgement.grantsDigest !== grantsDigest ||
            acknowledgement.now !== now
          )
            throw failure();
          await refresh(callSignal);
        },
        async submit(probe, callSignal) {
          lastAttemptId = randomUUID();
          const { approval: _approval, ...body } = probe;
          const digest = jsonDigest(body);
          const attempt = parseInput(
            attemptSchema,
            await request(
              config.observer.baseUrl,
              '/__investigator__/attempts',
              observerCredential,
              callSignal,
              {
                runId,
                scenarioId,
                attemptId: lastAttemptId,
                requestDigest: digest,
              },
            ),
            'INVALID_OBSERVER_ATTEMPT',
            'Observer attempt',
          );
          if (
            attempt.runId !== runId ||
            attempt.scenarioId !== scenarioId ||
            attempt.attemptId !== lastAttemptId ||
            attempt.requestDigest !== digest
          )
            throw failure();
          privateValues.add(attempt.challenge);
          attempts.set(lastAttemptId, digest);
          const result = parseInput(
            responseSchema,
            await request(config.target.baseUrl, '/export', submitCredential, callSignal, {
              runId,
              scenarioId,
              attemptId: lastAttemptId,
              challenge: attempt.challenge,
              request: {
                ...probe,
                approval: probe.approval === null ? null : { ...probe.approval },
              },
            }),
            'INVALID_TARGET_RESPONSE',
            'Target response',
          );
          await refresh(callSignal);
          return result;
        },
        effects: () => structuredClone(cache),
      };
      try {
        await verifyIdentity(signal);
        const results = await runExternalApprovalChecks(driver, signal);
        await verifyIdentity(signal);
        return results;
      } finally {
        if (sessionCreated)
          await request(
            config.observer.baseUrl,
            '/__investigator__/cleanup',
            observerCredential,
            AbortSignal.timeout(Math.min(1000, config.timeoutMs)),
            { runId },
          ).catch(() => {});
        privateValues.clear();
        for (const value of [submitCredential, adminCredential, observerCredential])
          privateValues.add(value);
        running = false;
      }
    },
  });
}

export async function loadHttpApprovalTarget(
  path: string,
  env: Readonly<Record<string, string | undefined>>,
): Promise<ControlCheckAdapter> {
  const config = parseJson(
    decodeUtf8(await readBoundedFile(path, 65_536)),
    'INVALID_TARGET_CONFIG',
  );
  return createHttpApprovalTarget(config, env);
}
