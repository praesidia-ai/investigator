// Owner: DS-B. `jurator discuss`: talk with Jurator about this workspace's promises, rules, checks and code, in a
// light pi-mono-style terminal interface (or plain lines when stdin/stdout is not a terminal). Read-only: the agent
// looks things up and explains; only the user runs commands. The agent core (DS-A) is loaded lazily from
// src/discuss/core/index.ts; JURATOR_DISCUSS_FAKE=1 drives the interface from a fake session instead (no store, no
// network), for tests and recordings.
import { createInterface } from 'node:readline';
import { BRAND } from '../../brand.js';
import { JuratorError } from '../../util/errors.js';
import type { DiscussModel, OpenDiscussOptions, OpenDiscussSession } from '../../discuss/contract.js';
import { createFakeSession, runInteractive, runPlain } from '../../discuss/tui/index.js';
import type { Command } from '../context.js';

const USAGE = `${BRAND.command} discuss ["<goal>"] [--model wonder|spark] [--budget <usd>] [--scripted <dir>] [--plain] [--json] [--no-save]`;

export interface DiscussArgs {
  model?: DiscussModel;
  budgetUsd?: number;
  scriptedDir?: string;
  plain: boolean;
  json: boolean;
  save: boolean;
  /** DS-C: a goal to start from, e.g. "check that clipboard documents stay in memory" (the agent plans the steps). */
  goal?: string;
}

export function parseDiscussArgs(argv: readonly string[]): DiscussArgs {
  const out: DiscussArgs = { plain: false, json: false, save: true };
  const value = (i: number, flag: string): string => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) throw new JuratorError('BAD_ARGS', `${flag} needs a value. Usage: ${USAGE}`);
    return v;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i] as string;
    const [flag, inline] = a.startsWith('--') && a.includes('=') ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a, undefined];
    const take = (): string => {
      if (inline !== undefined) return inline;
      const v = value(i, flag);
      i += 1;
      return v;
    };
    switch (flag) {
      case '--model': {
        const m = take();
        if (m !== 'wonder' && m !== 'spark') throw new JuratorError('BAD_ARGS', `--model is wonder or spark, not "${m}".`);
        out.model = m;
        break;
      }
      case '--budget': {
        const raw = take();
        const n = Number(raw.replace(/^\$/u, ''));
        if (!Number.isFinite(n) || n <= 0) throw new JuratorError('BAD_ARGS', `--budget is an amount in dollars, e.g. 3 (got "${raw}").`);
        out.budgetUsd = n;
        break;
      }
      case '--scripted':
        out.scriptedDir = take();
        break;
      case '--plain':
        out.plain = true;
        break;
      case '--json':
        out.json = true;
        break;
      case '--no-save':
        out.save = false;
        break;
      default:
        if (!a.startsWith('-')) {
          out.goal = out.goal ? `${out.goal} ${a}` : a;
          break;
        }
        throw new JuratorError('BAD_ARGS', `Unknown option "${a}". Usage: ${USAGE}`);
    }
  }
  return out;
}

/** The agent core's opener (DS-A), loaded when the command runs. */
async function loadOpener(env: NodeJS.ProcessEnv): Promise<OpenDiscussSession> {
  if (env.JURATOR_DISCUSS_FAKE === '1') {
    return async (o: OpenDiscussOptions) =>
      createFakeSession({ delayMs: Number(env.JURATOR_DISCUSS_FAKE_DELAY ?? 120), ...(o.budgetUsd !== undefined ? { budgetUsd: o.budgetUsd } : {}), ...(o.model ? { model: o.model } : {}), root: o.cwd, ...(o.save === false ? { transcriptPath: null } : {}) });
  }
  // Loaded lazily so other commands do not pay for the agent core at startup; a load error is a real error.
  const core = await import('../../discuss/core/index.js');
  return core.openDiscussSession;
}

const command: Command = {
  name: 'discuss',
  summary: 'Talk with Jurator about your promises, rules, checks and code; it proposes steps, you confirm',
  usage: USAGE,
  async run(ctx) {
    const args = parseDiscussArgs(ctx.argv);
    const open = await loadOpener(ctx.env);
    const session = await open({
      cwd: ctx.cwd,
      env: ctx.env,
      ...(args.model ? { model: args.model } : {}),
      ...(args.budgetUsd !== undefined ? { budgetUsd: args.budgetUsd } : {}),
      ...(args.scriptedDir !== undefined ? { scriptedDir: args.scriptedDir } : {}),
      save: args.save,
      now: ctx.now,
    });
    const plainEnv = ctx.env.JURATOR_PLAIN !== undefined && ctx.env.JURATOR_PLAIN !== '' && ctx.env.JURATOR_PLAIN !== '0';
    const interactive = !args.plain && !args.json && !plainEnv && ctx.env.TERM !== 'dumb' && Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY);
    if (interactive) return runInteractive(session, { input: process.stdin, output: process.stdout, env: ctx.env, goal: args.goal });
    const rl = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY, terminal: false });
    try {
      return await runPlain(
        session,
        {
          lines: rl,
          write: (s) => process.stdout.write(s),
          note: (s) => process.stderr.write(`${s}\n`),
          onInterrupt: (fn) => {
            process.on('SIGINT', fn);
            return () => process.off('SIGINT', fn);
          },
          exit: (code) => process.exit(code),
        },
        { json: args.json, goal: args.goal },
      );
    } finally {
      rl.close();
    }
  },
};

export default command;
