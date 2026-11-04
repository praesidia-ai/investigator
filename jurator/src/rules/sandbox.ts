// Owner: WP-R (FX-1). Rule patterns run in a worker thread with a time budget, so no pattern can hang a check or a
// hook. JavaScript cannot stop a regular expression from the thread that runs it, so the engine sends each scan to a
// worker and waits for it with Atomics.wait; past the budget the worker is terminated and the scan fails as an error.
// The worker is self-contained (eval'd source, no imports from this package), so it works from src/ in tests and from
// dist/ in the CLI alike. Program-built patterns (escaped names) do not need it.
import { MessageChannel, receiveMessageOnPort, Worker, type MessagePort } from 'node:worker_threads';
import { JuratorError } from '../util/errors.js';
import { blockingWait } from '../ui/interrupt.js';

/** Default time one scan (one pattern over the files of one rule) may take. */
export const DEFAULT_BUDGET_MS = 2000;
const BOOT_MS = 15_000;
let budgetMs = DEFAULT_BUDGET_MS;

/** For tests: the budget per scan, in milliseconds. Returns the previous value. */
export function setScanBudget(ms: number): number {
  const prev = budgetMs;
  budgetMs = Math.max(1, Math.floor(ms));
  return prev;
}

/** [fileIndex, lineIndex (0-based), matched text]: the first match on each line that matches. */
export type LineHit = readonly [number, number, string];
/** [fileIndex, character index, matched text]: every match over a whole text (at most `max` per text). */
export type TextHit = readonly [number, number, string];

type Job =
  | { readonly kind: 'lines'; readonly pattern: string; readonly flags: string; readonly files: readonly (readonly string[])[] }
  | { readonly kind: 'text'; readonly pattern: string; readonly flags: string; readonly texts: readonly string[]; readonly max: number }
  | { readonly kind: 'replace'; readonly pattern: string; readonly flags: string; readonly texts: readonly string[] };
type Reply = { ok: true; hits?: LineHit[] | TextHit[]; texts?: string[] } | { ok: false; error: string };

const WORKER_SOURCE = `
const { workerData } = require('node:worker_threads');
const port = workerData.port;
const sig = new Int32Array(workerData.signal);
const cache = new Map();
const compile = (p, f) => {
  const k = f + '/' + p;
  let re = cache.get(k);
  if (!re) { re = new RegExp(p, f); cache.set(k, re); }
  re.lastIndex = 0;
  return re;
};
port.on('message', (job) => {
  let out;
  try {
    if (job.kind === 'lines') {
      const re = compile(job.pattern, job.flags);
      const hits = [];
      job.files.forEach((lines, f) => lines.forEach((line, i) => { const m = re.exec(line); if (m) hits.push([f, i, m[0]]); }));
      out = { ok: true, hits };
    } else if (job.kind === 'text') {
      const hits = [];
      job.texts.forEach((t, f) => {
        const re = compile(job.pattern, job.flags + 'g');
        let n = 0;
        for (const m of t.matchAll(re)) { hits.push([f, m.index, m[0]]); n += 1; if (n >= job.max) break; }
      });
      out = { ok: true, hits };
    } else {
      out = { ok: true, texts: job.texts.map((t) => t.replace(compile(job.pattern, job.flags + 'g'), '')) };
    }
  } catch (e) {
    out = { ok: false, error: String((e && e.message) || e) };
  }
  port.postMessage(out);
  Atomics.store(sig, 0, 1);
  Atomics.notify(sig, 0);
});
Atomics.store(sig, 0, 1);
Atomics.notify(sig, 0);
`;

interface Sandbox {
  readonly worker: Worker;
  readonly port: MessagePort;
  readonly sig: Int32Array;
}
let sandbox: Sandbox | null = null;

function boot(): Sandbox {
  const signal = new SharedArrayBuffer(4);
  const sig = new Int32Array(signal);
  const { port1, port2 } = new MessageChannel();
  const worker = new Worker(WORKER_SOURCE, { eval: true, workerData: { port: port2, signal }, transferList: [port2] });
  worker.unref();
  port1.unref();
  worker.on('error', () => undefined); // a crash shows up as a timeout below
  if (Atomics.wait(sig, 0, 0, BOOT_MS) === 'timed-out') {
    void worker.terminate();
    throw new JuratorError('RULE_SANDBOX', 'the rule worker did not start');
  }
  return { worker, port: port1, sig };
}

/** Stops the worker (tests, or after a timeout). The next scan starts a new one. */
export function resetSandbox(): void {
  if (sandbox) void sandbox.worker.terminate();
  sandbox = null;
}

function call(job: Job): Reply & { ok: true } {
  sandbox ??= boot();
  const s = sandbox;
  Atomics.store(s.sig, 0, 0);
  s.port.postMessage(job);
  // R5-B: blockingWait keeps Ctrl-C working while this thread waits (see src/ui/interrupt.ts).
  if (blockingWait(s.sig, budgetMs) === 'timed-out') {
    resetSandbox();
    throw new JuratorError(
      'RULE_TIMEOUT',
      `/${job.pattern}/ took longer than ${budgetMs} ms and was stopped (the pattern is too slow on this code)`,
    );
  }
  const reply = receiveMessageOnPort(s.port)?.message as Reply | undefined;
  if (!reply) {
    resetSandbox();
    throw new JuratorError('RULE_SANDBOX', 'the rule worker gave no answer');
  }
  if (!reply.ok) throw new JuratorError('BAD_PATTERN', `/${job.pattern}/ could not run: ${reply.error}`);
  return reply;
}

/** The first match on each line, for each file's lines. */
export function scanLines(pattern: string, flags: string, files: readonly (readonly string[])[]): LineHit[] {
  if (files.every((f) => f.length === 0)) return [];
  return (call({ kind: 'lines', pattern, flags, files }).hits ?? []) as LineHit[];
}
/** Every match over each whole text (the g flag is added here), at most `max` per text. */
export function scanText(pattern: string, flags: string, texts: readonly string[], max: number): TextHit[] {
  if (texts.length === 0) return [];
  return (call({ kind: 'text', pattern, flags, texts, max }).hits ?? []) as TextHit[];
}
/** Each text with every match removed. */
export function removeMatches(pattern: string, flags: string, texts: readonly string[]): string[] {
  if (texts.length === 0) return [];
  return call({ kind: 'replace', pattern, flags, texts }).texts ?? [...texts];
}
