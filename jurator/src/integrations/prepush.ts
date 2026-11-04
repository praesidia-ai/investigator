// Owner: WP-D. The git pre-push protocol: which commits are being pushed, and what to compare them against.
import type { CheckRun, CheckResult } from '../contracts.js';

/** One line git writes to a pre-push hook's stdin: `<local ref> <local sha> <remote ref> <remote sha>`. */
export interface PushUpdate {
  readonly localRef: string;
  readonly localSha: string;
  readonly remoteRef: string;
  readonly remoteSha: string;
}

export type CheckTarget = { kind: 'repo'; head: string } | { kind: 'diff'; base: string; head: string };

/** The few git reads the hooks need (src/integrations/git.ts implements it with the git CLI; tests fake it). */
export interface HookGit {
  /** Full sha of the commit a ref names, or null when it does not resolve (or the object is missing). */
  resolveCommit(ref: string): Promise<string | null>;
  mergeBase(a: string, b: string): Promise<string | null>;
}

export const isZeroSha = (sha: string): boolean => /^0+$/u.test(sha);

export function parsePrePushInput(text: string): PushUpdate[] {
  const updates: PushUpdate[] = [];
  for (const raw of text.split(/\r?\n/u)) {
    const parts = raw.trim().split(/\s+/u);
    if (parts.length !== 4) continue;
    const [localRef, localSha, remoteRef, remoteSha] = parts as [string, string, string, string];
    if (!/^[0-9a-f]{4,64}$/u.test(localSha) || !/^[0-9a-f]{4,64}$/u.test(remoteSha)) continue;
    updates.push({ localRef, localSha, remoteRef, remoteSha });
  }
  return updates;
}

/** Branches a new branch is usually cut from, most specific first. */
export function defaultBaseCandidates(remoteName?: string): string[] {
  const remotes = [remoteName, 'origin'].filter((r): r is string => Boolean(r));
  const out: string[] = [];
  for (const branch of ['main', 'master']) {
    for (const remote of remotes) out.push(`${remote}/${branch}`);
    out.push(branch);
  }
  return [...new Set(out)];
}

/**
 * The first candidate whose merge-base with `head` is a real ancestor (not `head` itself) gives a diff target.
 * If none does (for example a first push of main), the whole repo is checked at `head`.
 */
export async function targetFromCandidates(git: HookGit, head: string, candidates: readonly string[]): Promise<CheckTarget> {
  for (const candidate of candidates) {
    const sha = await git.resolveCommit(candidate);
    if (!sha) continue;
    const mergeBase = await git.mergeBase(sha, head);
    if (mergeBase && mergeBase !== head) return { kind: 'diff', base: mergeBase, head };
  }
  return { kind: 'repo', head };
}

/**
 * What to check for one pushed ref, or null to skip it (a deleted branch, a tag, nothing new).
 * Base = the remote sha when git has it locally; for a new branch, the merge-base with origin/main or main.
 */
export async function choosePushTarget(update: PushUpdate, git: HookGit, remoteName?: string): Promise<CheckTarget | null> {
  if (isZeroSha(update.localSha)) return null;
  if (update.localRef.startsWith('refs/tags/') || update.remoteRef.startsWith('refs/tags/')) return null;
  if (update.localSha === update.remoteSha) return null;
  if (!isZeroSha(update.remoteSha)) {
    const known = await git.resolveCommit(update.remoteSha);
    if (known) return { kind: 'diff', base: known, head: update.localSha };
  }
  return targetFromCandidates(git, update.localSha, defaultBaseCandidates(remoteName));
}

/** Results that block: a rule (never an AI read) said BROKEN and the fail mode is block. */
export function blockingResults(run: CheckRun): CheckResult[] {
  if (run.failMode !== 'block') return [];
  return run.results.filter((r) => r.verdict === 'broken' && r.level === 'rule');
}
