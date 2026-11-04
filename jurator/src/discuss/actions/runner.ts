// Owner: DS-C. Runs one confirmed Jurator command in-process, the way the user would run it in their shell, with its
// progress lines streamed into the chat (plain live view: JURATOR_PLAIN=1, no colour, no cursor games). Output lines
// are cleaned (no escapes) and masked before anyone sees them. The model's calls are metered through tapModelUsage.
// Scripted sessions run commands against <scripted dir>/actions and never touch the network.
import { join } from 'node:path';
import { tapModelUsage } from '../../model/index.js';
import { maskSecrets } from '../../model/secrets.js';
import { sanitize, stripAnsi } from '../../ui/text.js';
import { JuratorError } from '../../util/errors.js';
import { makeStyle } from '../../util/term.js';

export interface RunOptions {
  readonly root: string;
  readonly env: NodeJS.ProcessEnv;
  /** The command and its arguments, e.g. ['check', '--no-ai']. */
  readonly argv: readonly string[];
  readonly now: () => Date;
  /** Set for a scripted session: model answers come from <dir>/actions, never the network. */
  readonly scriptedDir?: string | undefined;
  /** Each printed line, as it is printed. */
  readonly onLine?: ((line: string) => void) | undefined;
}

export interface RunOutcome {
  readonly exitCode: number;
  readonly usd: number;
  readonly lines: readonly string[];
  readonly ms: number;
}

/** Lines kept per run (the rest are counted, not kept). */
export const MAX_ACTION_LINES = 400;

/** One printed chunk -> clean, masked lines. */
export function cleanLines(chunk: string): string[] {
  const text = maskSecrets(sanitize(stripAnsi(chunk)), '').text;
  return text.split('\n').map((l) => l.replace(/\s+$/u, ''));
}

/** The environment a command runs with inside discuss. */
export function actionEnv(env: NodeJS.ProcessEnv, scriptedDir: string | undefined): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env, JURATOR_PLAIN: '1', NO_COLOR: '1' };
  delete out.JURATOR_UI;
  delete out.JURATOR_VIDEO;
  delete out.FORCE_COLOR;
  if (scriptedDir) {
    out.JURATOR_SCRIPTED_DIR = join(scriptedDir, 'actions');
    delete out.META_API_KEY;
    delete out.MODEL_API_KEY;
  }
  return out;
}

export async function runJurator(o: RunOptions): Promise<RunOutcome> {
  const started = Date.now();
  const lines: string[] = [];
  let dropped = 0;
  const emit = (chunk: string): void => {
    for (const line of cleanLines(chunk)) {
      if (lines.length < MAX_ACTION_LINES) lines.push(line);
      else dropped += 1;
      o.onLine?.(line);
    }
  };
  const name = o.argv[0] ?? '';
  // Loaded when a run starts: the registry pulls in every command, which a chat that never runs one does not need.
  const { COMMANDS } = await import('../../cli/registry.js');
  const command = COMMANDS.find((c) => c.name === name);
  if (!command) {
    emit(`This build has no "${name}" command.`);
    return { exitCode: 2, usd: 0, lines, ms: Date.now() - started };
  }
  let usd = 0;
  const untap = tapModelUsage((u) => {
    usd += u;
  });
  let exitCode = 2;
  try {
    exitCode = await command.run({
      cwd: o.root,
      argv: o.argv.slice(1),
      env: actionEnv(o.env, o.scriptedDir),
      out: emit,
      err: emit,
      style: makeStyle(false),
      now: o.now,
    });
  } catch (error) {
    if (error instanceof JuratorError) emit(`${error.code}: ${error.message}`);
    else emit(`The command failed: ${error instanceof Error ? error.message : String(error)}`);
    exitCode = 2;
  } finally {
    untap();
  }
  if (dropped > 0) lines.push(`[${dropped} more lines not kept]`);
  return { exitCode, usd: Math.round(usd * 1_000_000) / 1_000_000, lines, ms: Date.now() - started };
}
