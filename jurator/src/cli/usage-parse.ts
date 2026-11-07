import type { CommandContext } from './context.js';

/** Runs an argv parse; on a parse error prints it with the usage and returns undefined (the caller exits 2). */
export function parseOrUsage<T>(ctx: Pick<CommandContext, 'err'>, usage: string, parse: () => T): T | undefined {
  try {
    return parse();
  } catch (error) {
    ctx.err(`${error instanceof Error ? error.message : String(error)}\nUsage: ${usage}`);
    return undefined;
  }
}
