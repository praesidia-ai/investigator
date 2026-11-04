// Owner: WP-D. `jurator hook run|install pre-push|claude|muse`.
import { resolve } from 'node:path';
import { terminalWidth } from '../../check/local.js';
import { renderRunText } from '../../render/index.js';
import {
  AGENT_HOOK_TIMEOUT_MS,
  FAIL_CLOSED_FLAG,
  failClosedFrom,
  gitHooksDir,
  gitTopLevel,
  HOOK_KINDS,
  installHook,
  makeHookGit,
  PRE_PUSH_TIMEOUT_MS,
  rulesCheck,
  runAgentHook,
  runPrePush,
  stableNodePath,
  timeoutFrom,
  type HookDeps,
  type HookOptions,
  type HookKind,
} from '../../integrations/index.js';
import type { Command, CommandContext } from '../context.js';
import { BRAND } from '../../brand.js';

const USAGE =
  `${BRAND.command} hook run pre-push|claude|muse [${FAIL_CLOSED_FLAG}] | ` +
  `${BRAND.command} hook install pre-push|claude|muse... [--local] [${FAIL_CLOSED_FLAG}]`;

/** The CLI context has no stdin (contracts gap), so hooks read process.stdin here. A terminal gives ''. */
async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer));
  return Buffer.concat(chunks).toString('utf8');
}

function isKind(value: string | undefined): value is HookKind {
  return value !== undefined && (HOOK_KINDS as readonly string[]).includes(value);
}

function realDeps(ctx: CommandContext): HookDeps {
  return {
    git: (cwd) => makeHookGit(cwd),
    check: (cwd, target) => rulesCheck(cwd, target, ctx.now),
    render: (run, extra) => renderRunText(run, ctx.style, { ...extra, width: terminalWidth(), next: false }),
  };
}

async function runKind(ctx: CommandContext, kind: HookKind, rest: readonly string[]): Promise<number> {
  const stdin = await readStdin();
  const io = { out: ctx.out, err: ctx.err };
  // git passes `<remote name> <remote url>`; our own flags may sit before them (`hook run pre-push --fail-closed "$@"`).
  const positional = rest.filter((a) => a !== FAIL_CLOSED_FLAG);
  let timedOut = false;
  const options: HookOptions = {
    failClosed: failClosedFrom(rest, ctx.env),
    timeoutMs: timeoutFrom(ctx.env, kind === 'pre-push' ? PRE_PUSH_TIMEOUT_MS : AGENT_HOOK_TIMEOUT_MS),
    onTimeout: () => {
      timedOut = true;
    },
  };
  const code =
    kind === 'pre-push'
      ? await runPrePush(stdin, positional[0], ctx.cwd, realDeps(ctx), io, options)
      : await runAgentHook(kind, stdin, ctx.cwd, realDeps(ctx), io, options);
  // The stopped check may still be running: exit once the answer is written, so git or the agent is not kept waiting.
  if (timedOut) setTimeout(() => process.exit(code), 200).unref();
  return code;
}

async function install(ctx: CommandContext, args: readonly string[]): Promise<number> {
  const local = args.includes('--local');
  const failClosed = args.includes(FAIL_CLOSED_FLAG);
  const kinds = args.filter((a) => !a.startsWith('--'));
  if (kinds.length === 0 || !kinds.every(isKind)) {
    ctx.err(`Say which hooks to install: pre-push, claude or muse.\nUsage: ${USAGE}`);
    return 2;
  }
  const repoRoot = await gitTopLevel(ctx.cwd);
  if (!repoRoot) {
    ctx.err('Not inside a git repository. Run this from your repo.');
    return 2;
  }
  const hooksDir = await gitHooksDir(repoRoot);
  const bin = resolve(process.argv[1] ?? 'dist/bin.js');
  for (const kind of kinds) {
    const result = await installHook(kind, { repoRoot, hooksDir, launcher: { node: stableNodePath(process.execPath, ctx.env.PATH), bin }, local, failClosed });
    const mark = result.status === 'manual' ? ctx.style.yellow('!') : ctx.style.green('✓');
    ctx.out(`${mark} ${result.lines[0] ?? ''}`);
    for (const line of result.lines.slice(1)) ctx.out(`  ${line}`);
  }
  ctx.out(`Next: push a branch (or ask your agent to) and ${BRAND.name} checks it with your rules.`);
  return 0;
}

const command: Command = {
  name: 'hook',
  summary: `Run ${BRAND.name} from a git or agent hook`,
  usage: USAGE,
  async run(ctx) {
    const [action, kind, ...rest] = ctx.argv;
    if (action === 'run' && isKind(kind)) return runKind(ctx, kind, rest);
    if (action === 'install') return install(ctx, ctx.argv.slice(1));
    ctx.err(`Usage: ${USAGE}`);
    return 2;
  },
};
export default command;
