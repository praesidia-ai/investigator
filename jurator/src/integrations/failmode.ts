// Owner: FU-3. Fail-closed or fail-open: what a hook does when it cannot check (a rule error, a timeout, a crash).
// Config-free on purpose: `--fail-closed` on the hook command line, or JURATOR_FAIL_CLOSED=1 in its environment.
import { BRAND } from '../brand.js';
import type { CheckRun } from '../contracts.js';

export const FAIL_CLOSED_FLAG = '--fail-closed';
export const FAIL_CLOSED_ENV = 'JURATOR_FAIL_CLOSED';
/** Overrides the hook's own time limit (milliseconds). */
export const HOOK_TIMEOUT_ENV = 'JURATOR_HOOK_TIMEOUT_MS';

/** Agent hooks are killed by the agent after 60 s (templates/hooks), and a killed hook lets the tool run: stop first. */
export const AGENT_HOOK_TIMEOUT_MS = 45_000;
export const PRE_PUSH_TIMEOUT_MS = 120_000;

export interface HookOptions {
  /** Block (pre-push) or deny (agent) when the check cannot finish, instead of letting it through with a warning. */
  readonly failClosed: boolean;
  /** Give up after this long; null means no limit. */
  readonly timeoutMs: number | null;
  /** Called when the time limit was hit (the CLI then exits even though the check is still running). */
  readonly onTimeout?: () => void;
}

export function failClosedFrom(argv: readonly string[], env: Readonly<Record<string, string | undefined>>): boolean {
  if (argv.includes(FAIL_CLOSED_FLAG)) return true;
  const v = (env[FAIL_CLOSED_ENV] ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

export function timeoutFrom(env: Readonly<Record<string, string | undefined>>, fallback: number): number {
  const n = Number(env[HOOK_TIMEOUT_ENV]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export class HookTimeoutError extends Error {
  constructor(ms: number) {
    super(`the check took longer than ${ms >= 1000 ? `${Math.round(ms / 1000)} s` : `${ms} ms`} and was stopped`);
    this.name = 'HookTimeoutError';
  }
}

/** Resolves with `work`, or rejects with HookTimeoutError after `ms` (the work itself keeps running). */
export async function withDeadline<T>(work: Promise<T>, ms: number | null, onTimeout?: () => void): Promise<T> {
  if (ms === null) return work;
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      onTimeout?.();
      reject(new HookTimeoutError(ms));
    }, ms);
    timer.unref?.();
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** A promise the check could not decide because a rule (or the run itself) failed: never counted as checked. */
export interface Unchecked {
  readonly promiseId: string;
  readonly why: string;
}

/**
 * What the run could not check: promises whose rules errored or timed out (and no rule said BROKEN), plus the run
 * itself when it says it failed or is incomplete. Promises with no rule are not counted: that is coverage, not an error.
 */
export function uncheckedOf(run: CheckRun): Unchecked[] {
  const out: Unchecked[] = [];
  for (const r of run.results) {
    if (r.verdict === 'broken') continue;
    const errors = (r.ruleResults ?? []).filter((x) => x.outcome === 'error');
    if (errors.length > 0) out.push({ promiseId: r.promiseId, why: errors.map((x) => x.message).join(' ') });
  }
  if (out.length === 0 && run.status !== 'completed') {
    out.push({ promiseId: '(run)', why: `the check is ${run.status}` });
  }
  return out;
}

export function failOpenHint(): string {
  return `To block instead: ${BRAND.command} hook run ... ${FAIL_CLOSED_FLAG}, or ${FAIL_CLOSED_ENV}=1.`;
}

/** Lines naming what could not be checked (short: these also show in 100-column recordings). */
export function uncheckedLines(items: readonly Unchecked[], max = 5): string[] {
  const lines = items.slice(0, max).map((u) => `- ${u.promiseId} NOT CHECKED: ${u.why}`);
  if (items.length > max) lines.push(`- ... and ${items.length - max} more`);
  return lines;
}
