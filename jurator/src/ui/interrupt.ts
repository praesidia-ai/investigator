// R5-B: Ctrl-C always works. One process-wide SIGINT handler: it clears every live view (cursor shown again), prints a
// short "stopped" line with what this run spent, and exits 130. A JavaScript signal handler only runs when the main
// thread is free, so code that blocks the thread on purpose (the rule sandbox waits for its worker with Atomics.wait)
// calls `blockingWait`: past a short first slice it drops the JS handlers for the rest of the wait, so the operating
// system's default action stops the process at once (exit by SIGINT, which shells report as 130), cursor shown first.

/** What a live view gives the handler: how to clear itself, and what the run has spent so far. */
export interface InterruptClient {
  /** Clears the live area and shows the cursor again; returns nothing to print. */
  readonly cleanup: () => void;
  /** USD spent so far by what this view tracks. */
  readonly costUsd: () => number;
  /** Writes the cursor-show sequence (for blocking waits); undefined when the view does not hide the cursor. */
  readonly showCursor?: (() => void) | undefined;
  readonly hideCursor?: (() => void) | undefined;
}

const clients = new Set<InterruptClient>();
let installed = false;
let stopping = false;
/** The stream the stopped line goes to (stderr unless a test sets another). */
let out: { write(s: string): unknown } = process.stderr;
/** Exit used by the handler (tests replace it). */
let exit: (code: number) => void = (code) => process.exit(code);

const money = (usd: number): string => (usd === 0 ? '$0' : `$${usd.toFixed(usd < 1 ? 4 : 2)}`);

/** The line printed when Ctrl-C stops a run. */
export function stoppedLine(costUsd: number): string {
  return `Stopped (Ctrl-C). This run spent ${money(costUsd)}; nothing more was started.`;
}

function onSigint(): void {
  if (stopping) {
    exit(130); // a second Ctrl-C while cleaning up: leave now
    return;
  }
  stopping = true;
  let cost = 0;
  for (const c of clients) {
    try {
      c.cleanup();
    } catch {
      /* the terminal may be gone */
    }
    cost += c.costUsd();
  }
  try {
    out.write(`${stoppedLine(Math.round(cost * 1_000_000) / 1_000_000)}\n`);
  } catch {
    /* ignore */
  }
  exit(130);
}

/** Installs the handler once for the process (idempotent). */
export function installInterrupt(): void {
  if (installed) return;
  installed = true;
  process.on('SIGINT', onSigint);
}

/** Adds a live view to what the handler cleans up and counts; returns the function that removes it. */
export function registerInterrupt(client: InterruptClient): () => void {
  installInterrupt();
  clients.add(client);
  return () => {
    clients.delete(client);
  };
}

/** For tests: run the handler as if Ctrl-C was pressed, with a fake stream and exit. */
export function simulateInterrupt(stream: { write(s: string): unknown }, onExit: (code: number) => void): void {
  const prev = { out, exit };
  out = stream;
  exit = onExit;
  try {
    onSigint();
  } finally {
    out = prev.out;
    exit = prev.exit;
    stopping = false;
  }
}

/** First slice of a blocking wait that keeps the JS handlers (most scans end well inside it). */
export const QUICK_WAIT_MS = 50;

/**
 * Waits on `sig[0]` leaving 0 like Atomics.wait, up to `ms`. Past QUICK_WAIT_MS the SIGINT listeners are removed for
 * the rest of the wait (the default action then ends the process at once) and the cursor is shown, then both are put
 * back. Returns Atomics.wait's result.
 */
export function blockingWait(sig: Int32Array, ms: number): 'ok' | 'not-equal' | 'timed-out' {
  const first = Atomics.wait(sig, 0, 0, Math.min(ms, QUICK_WAIT_MS));
  if (first !== 'timed-out' || ms <= QUICK_WAIT_MS) return first;
  const listeners = process.listeners('SIGINT') as Array<(...a: unknown[]) => void>;
  for (const l of listeners) process.removeListener('SIGINT', l);
  for (const c of clients) c.showCursor?.();
  try {
    return Atomics.wait(sig, 0, 0, ms - QUICK_WAIT_MS);
  } finally {
    for (const l of listeners) process.on('SIGINT', l);
    for (const c of clients) c.hideCursor?.();
  }
}
