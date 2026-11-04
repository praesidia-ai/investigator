// Owner: WP-D. What `jurator hook run <kind>` does. Every outside effect comes in through deps, so tests use fakes.
import { isAbsolute, relative } from 'node:path';
import { BRAND } from '../brand.js';
import type { CheckRun } from '../contracts.js';
import { decideToolUse, formatDecision, parseToolEvent, type AgentKind, type PushCheckOutcome } from './agent.js';
import type { RulesCheckOutcome } from './checker.js';
import {
  AGENT_HOOK_TIMEOUT_MS,
  failOpenHint,
  PRE_PUSH_TIMEOUT_MS,
  uncheckedLines,
  uncheckedOf,
  withDeadline,
  type HookOptions,
  type Unchecked,
} from './failmode.js';
import {
  blockingResults,
  choosePushTarget,
  parsePrePushInput,
  targetFromCandidates,
  type CheckTarget,
  type HookGit,
} from './prepush.js';

export interface HookIo {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

export interface HookDeps {
  /** Git reads for the repo at `cwd`. */
  git(cwd: string): HookGit;
  /** Rules-only check (aiRead false, no model) of `target` in the repo at `cwd`. */
  check(cwd: string, target: CheckTarget): Promise<RulesCheckOutcome>;
  /** Compact terminal text for a run (the hook prints its own Next line). */
  render(run: CheckRun, extra: RenderExtra): string;
}

export interface RenderExtra {
  /** The saved run.json, relative to the repo when it is inside it. */
  readonly runPath?: string;
  readonly sources?: Readonly<Record<string, string>>;
}

/** `path` relative to `cwd` when it is inside it (shorter on screen), else as is. */
export function displayPath(cwd: string, path: string): string {
  const rel = relative(cwd, path);
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : path;
}

const short = (sha: string): string => sha.slice(0, 7);

function describe(target: CheckTarget): string {
  return target.kind === 'diff' ? `${short(target.head)} vs ${short(target.base)}` : `${short(target.head)} (whole repo)`;
}

/**
 * git pre-push: `stdin` holds one line per pushed ref. Exit 1 when a rule says BROKEN in block mode.
 * When the check cannot finish (a rule error or timeout, a crash, the time limit): fail-open by default (exit 0 with a
 * loud warning), or with fail-closed (`--fail-closed`, JURATOR_FAIL_CLOSED=1) block the push (exit 2).
 */
export async function runPrePush(
  stdin: string,
  remoteName: string | undefined,
  cwd: string,
  deps: HookDeps,
  io: HookIo,
  options: HookOptions = { failClosed: false, timeoutMs: PRE_PUSH_TIMEOUT_MS },
): Promise<number> {
  const unchecked: Unchecked[] = [];
  let broken = 0;
  try {
    const work = (async (): Promise<number | null> => {
      const updates = parsePrePushInput(stdin);
      const git = deps.git(cwd);
      const seen = new Set<string>();
      for (const update of updates) {
        const target = await choosePushTarget(update, git, remoteName);
        if (!target) continue;
        const key = JSON.stringify(target);
        if (seen.has(key)) continue;
        seen.add(key);
        const outcome = await deps.check(cwd, target);
        if (!outcome.run) {
          io.err(`${BRAND.command}: no ${BRAND.folder}/ in this repo, so this push is not checked. Next: ${BRAND.command} init`);
          return 0;
        }
        io.out(`${BRAND.command} pre-push: ${update.localRef.replace(/^refs\/heads\//u, '')} ${describe(target)} (rules only, no AI)`);
        const extra: RenderExtra = {
          ...(outcome.runPath ? { runPath: displayPath(cwd, outcome.runPath) } : {}),
          ...(outcome.sources ? { sources: outcome.sources } : {}),
        };
        io.out(deps.render(outcome.run, extra));
        broken += blockingResults(outcome.run).length;
        unchecked.push(...uncheckedOf(outcome.run));
      }
      return null;
    })();
    const early = await withDeadline(work, options.timeoutMs, options.onTimeout);
    if (early !== null) return early;
  } catch (error) {
    if (options.failClosed) {
      io.err(`${BRAND.command}: push blocked: could not check it (${messageOf(error)}), and fail-closed is on.`);
      io.err(`Next: fix the problem and push again (\`${BRAND.command} check --diff main\` shows it), or ask a person to push.`);
      return 2;
    }
    io.err(`WARNING: ${BRAND.command} could not check this push (${messageOf(error)}); letting it through UNCHECKED.`);
    io.err(failOpenHint());
    return 0;
  }
  if (broken > 0) {
    io.err(`${BRAND.command}: push blocked, ${broken} promise${broken === 1 ? ' is' : 's are'} broken (proved by a rule, no AI).`);
    io.err(`Next: fix the code, or change the policy and run ${BRAND.command} compile; then push again. \`${BRAND.command} check --diff main\` shows the full report.`);
    return 1;
  }
  if (unchecked.length > 0) {
    const n = unchecked.length;
    const what = `${n} promise${n === 1 ? '' : 's'} could not be checked (a rule failed or timed out)`;
    if (options.failClosed) {
      io.err(`${BRAND.command}: push blocked: ${what}, and fail-closed is on.`);
      for (const line of uncheckedLines(unchecked)) io.err(line);
      io.err(`Next: fix the rule (\`${BRAND.command} rule test\` shows the error), then push again.`);
      return 2;
    }
    io.err(`WARNING: ${what}; letting the push through.`);
    for (const line of uncheckedLines(unchecked)) io.err(line);
    io.err(failOpenHint());
  }
  return 0;
}

/** Base for an agent's push: `main...HEAD` (then origin/main, master, the upstream), else the whole repo. */
export async function agentPushTarget(git: HookGit): Promise<CheckTarget | null> {
  const head = await git.resolveCommit('HEAD');
  if (!head) return null;
  return targetFromCandidates(git, head, ['main', 'origin/main', 'master', 'origin/master', '@{upstream}']);
}

/**
 * Claude Code / Muse Code PreToolUse: print a deny decision (JSON) or nothing. Always exit 0. When the hook cannot
 * check (bad input, a crash, the time limit): fail-open by default (allow, with a warning on stderr), or with
 * fail-closed deny the tool call. The agent kills a hook after 60 s and then runs the tool, so the limit is lower.
 */
export async function runAgentHook(
  agent: AgentKind,
  stdin: string,
  cwd: string,
  deps: HookDeps,
  io: HookIo,
  options: HookOptions = { failClosed: false, timeoutMs: AGENT_HOOK_TIMEOUT_MS },
): Promise<number> {
  const deny = (reason: string): void => {
    const text = formatDecision(agent, { kind: 'deny', reason });
    if (text) io.out(text);
  };
  try {
    const event = parseToolEvent(stdin, cwd);
    if (!event) {
      if (options.failClosed) deny(`${BRAND.name}: the hook could not read this tool call, and fail-closed is on.`);
      return 0;
    }
    const decision = await withDeadline(
      decideToolUse(
        event,
        {
          async checkPush(dir): Promise<PushCheckOutcome> {
            const target = await agentPushTarget(deps.git(dir));
            if (!target) return { run: null, runPath: null };
            return deps.check(dir, target);
          },
        },
        { failClosed: options.failClosed },
      ),
      options.timeoutMs,
      options.onTimeout,
    );
    if (decision.kind === 'allow' && decision.warning) io.err(decision.warning);
    const text = formatDecision(agent, decision);
    if (text) io.out(text);
    return 0;
  } catch (error) {
    if (options.failClosed) {
      deny(`${BRAND.name}: could not check this (${messageOf(error)}), and fail-closed is on, so it is denied. Ask a person to run it.`);
      return 0;
    }
    io.err(`WARNING: ${BRAND.command} hook could not check this (${messageOf(error)}); allowing it UNCHECKED. ${failOpenHint()}`);
    return 0;
  }
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return 'code' in error && typeof error.code === 'string' ? `${error.code}: ${error.message}` : error.message;
  return String(error);
}
