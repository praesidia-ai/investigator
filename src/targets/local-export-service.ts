import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFile, lstat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { ControlCheckAdapter } from '../core/control-target.js';
import { InvestigatorError } from '../core/errors.js';
import { jsonDigest } from '../core/json.js';
import { readRequestText, readResponseText } from '../core/http-body.js';
import { parseInput, parseJson } from '../core/parse.js';
import { jsonValueSchema } from '../core/schemas.js';
import { decodeUtf8, readBoundedFile } from '../io/read-file.js';
import {
  runExternalApprovalChecks,
  type ApprovalProbeDriver,
  type SinkEffect,
} from '../reference/approval-control.js';
import { closeServer, stopChild } from './process-lifecycle.js';

const FILES = ['authorization.mjs', 'server.mjs'] as const;
const responseSchema = z
  .object({
    status: z.enum(['executed', 'approval_required', 'denied', 'unavailable']),
    reason: z.string().max(1024),
    claimedEffectCount: z.number().int().nonnegative(),
  })
  .strict();
const effectSchema = z
  .object({
    requestId: z.string().max(256),
    action: z.enum(['customer.export', 'reference.ping']),
    actorId: z.string().max(256),
    destination: z.string().max(1024),
    payload: z.record(z.string(), jsonValueSchema),
    requestDigest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

/** Copy only this authored fixture; no installation or arbitrary repository execution. */
export async function copyExportService(directory: string): Promise<void> {
  for (const file of FILES)
    await copyFile(
      fileURLToPath(new URL(`../../examples/export-service/${file}`, import.meta.url)),
      join(directory, file),
    );
}

export async function exportServiceRevision(directory: string): Promise<string> {
  const files: Record<string, string> = {};
  for (const file of FILES) {
    const path = join(directory, file);
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new InvestigatorError(
        'INVALID_TARGET',
        'The fixture must contain ordinary source files.',
      );
    files[file] = decodeUtf8(await readBoundedFile(path, 65_536));
  }
  return jsonDigest(files);
}

async function boundedResponse(response: Response): Promise<unknown> {
  return parseJson(
    await readResponseText(response, {
      unavailable: ['TARGET_UNAVAILABLE', 'The fixture request failed.'],
      tooLarge: ['TARGET_RESPONSE_TOO_LARGE', 'The fixture response exceeded its limit.'],
    }),
    'INVALID_TARGET_RESPONSE',
  );
}

/** Explicit local fixture adapter. Never use it to execute untrusted checkout code. */
export class LocalExportServiceAdapter implements ControlCheckAdapter {
  readonly id = 'local-http-export';
  readonly version = 1;

  constructor(
    readonly directory: string,
    readonly subjectRevision: string,
  ) {}

  async runChecks(signal: AbortSignal) {
    signal.throwIfAborted();
    if ((await exportServiceRevision(this.directory)) !== this.subjectRevision)
      throw new InvestigatorError(
        'CHECK_TARGET_CHANGED',
        'The application source changed after its revision was frozen.',
      );
    const adminToken = randomBytes(32).toString('hex');
    const observerToken = randomBytes(32).toString('hex');
    const effects: SinkEffect[] = [];
    const observer = createServer(async (request, response) => {
      if (
        request.method !== 'POST' ||
        request.url !== '/effects' ||
        request.headers.authorization !== `Bearer ${observerToken}`
      ) {
        response.writeHead(403);
        response.end();
        return;
      }
      try {
        const effect = parseInput(
          effectSchema,
          parseJson(await readRequestText(request)),
          'INVALID_EFFECT',
          'Effect',
        );
        effects.push({ ...effect, sequence: effects.length + 1 });
        response.writeHead(201);
        response.end();
      } catch {
        response.writeHead(400);
        response.end();
      }
    });
    let child: ChildProcess | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        observer.once('error', reject);
        observer.listen(0, '127.0.0.1', resolve);
      });
      const address = observer.address();
      if (!address || typeof address === 'string')
        throw new InvestigatorError('TARGET_UNAVAILABLE', 'The observer could not start.');
      child = spawn(process.execPath, [join(this.directory, 'server.mjs')], {
        cwd: this.directory,
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        env: {
          FIXTURE_ADMIN_TOKEN: adminToken,
          FIXTURE_OBSERVER_TOKEN: observerToken,
          FIXTURE_OBSERVER_URL: `http://127.0.0.1:${address.port}/effects`,
        },
      });
      const target = child;
      const port = await new Promise<number>((resolve, reject) => {
        const fail = () => {
          cleanup();
          reject(
            new InvestigatorError(
              'TARGET_UNAVAILABLE',
              'The isolated application could not start.',
            ),
          );
        };
        const timer = setTimeout(fail, 5000);
        const cleanup = () => {
          clearTimeout(timer);
          signal.removeEventListener('abort', fail);
          target.off('error', fail);
          target.off('exit', fail);
          target.off('message', ready);
        };
        const ready = (message: unknown) => {
          const parsed = z
            .object({ port: z.number().int().min(1).max(65535) })
            .strict()
            .safeParse(message);
          if (parsed.success) {
            cleanup();
            resolve(parsed.data.port);
          }
        };
        signal.addEventListener('abort', fail, { once: true });
        target.once('error', fail);
        target.once('exit', fail);
        target.on('message', ready);
        if (signal.aborted) fail();
      });
      const post = async (path: string, body: unknown, admin = false, callSignal = signal) =>
        boundedResponse(
          await fetch(`http://127.0.0.1:${port}${path}`, {
            method: 'POST',
            redirect: 'error',
            headers: {
              'Content-Type': 'application/json',
              ...(admin ? { Authorization: `Bearer ${adminToken}` } : {}),
            },
            body: JSON.stringify(body),
            signal: AbortSignal.any([callSignal, AbortSignal.timeout(5000)]),
          }),
        );
      const driver: ApprovalProbeDriver = {
        reset: async (grants, now, callSignal) => {
          await post('/__test__/reset', { grants, now }, true, callSignal);
        },
        submit: async (request, callSignal) =>
          parseInput(
            responseSchema,
            await post('/export', request, false, callSignal),
            'INVALID_TARGET_RESPONSE',
            'Application response',
          ),
        effects: () => structuredClone(effects),
      };
      const checks = await runExternalApprovalChecks(driver, signal);
      if ((await exportServiceRevision(this.directory)) !== this.subjectRevision)
        throw new InvestigatorError(
          'CHECK_TARGET_CHANGED',
          'The source changed during application checks.',
        );
      return checks;
    } finally {
      await stopChild(child);
      await closeServer(observer);
    }
  }
}
