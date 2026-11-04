import type { Style } from '../util/term.js';

/** Everything a command needs from the outside world; commands never touch process.* directly. */
export interface CommandContext {
  readonly cwd: string;
  readonly argv: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
  readonly style: Style;
  readonly now: () => Date;
}
export interface Command {
  readonly name: string;
  readonly summary: string;
  readonly usage: string;
  /** Returns the process exit code: 0 ok, 1 a promise is broken (or drift found), 2 the tool failed / bad input. */
  run(ctx: CommandContext): Promise<number>;
}
