import type { ChildProcess } from 'node:child_process';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { z } from 'zod';
import { InvestigatorError } from '../core/errors.js';

/** True for an authenticated POST /effects; otherwise answers 403 and returns false. */
export function acceptObserverRequest(
  request: IncomingMessage,
  response: ServerResponse,
  observerToken: string,
): boolean {
  if (
    request.method === 'POST' &&
    request.url === '/effects' &&
    request.headers.authorization === `Bearer ${observerToken}`
  )
    return true;
  response.writeHead(403);
  response.end();
  return false;
}

/** Wait up to 5 s for the child's IPC readiness message carrying its listening port. */
export function waitForChildPort(
  target: ChildProcess,
  signal: AbortSignal,
  unavailable: readonly [code: string, message: string],
): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const fail = () => {
      cleanup();
      reject(new InvestigatorError(...unavailable));
    };
    const ready = (input: unknown) => {
      const parsed = z
        .object({ port: z.number().int().min(1).max(65535) })
        .strict()
        .safeParse(input);
      if (!parsed.success) return;
      cleanup();
      resolve(parsed.data.port);
    };
    const timer = setTimeout(fail, 5000);
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', fail);
      target.off('error', fail);
      target.off('exit', fail);
      target.off('message', ready);
    };
    target.once('error', fail);
    target.once('exit', fail);
    target.on('message', ready);
    signal.addEventListener('abort', fail, { once: true });
    if (signal.aborted) fail();
  });
}

/** Loopback JSON POST with an optional bearer token and a 5 s cap. */
export function postLoopbackJson(
  port: number,
  path: string,
  body: unknown,
  signal: AbortSignal,
  bearer?: string,
): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    redirect: 'error',
    headers: {
      'Content-Type': 'application/json',
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
  });
}

export async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
}

export async function stopChild(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, 1500);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill('SIGTERM');
  });
}
