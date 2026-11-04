import { BRAND } from '../brand.js';
import { withFileCredentials } from '../util/credentials.js';
import { JuratorError } from '../util/errors.js';
import { makeStyle, wantsColor } from '../util/term.js';
import type { CommandContext } from './context.js';
import { COMMANDS } from './registry.js';

function help(style: ReturnType<typeof makeStyle>): string {
  const width = Math.max(...COMMANDS.map((c) => c.name.length));
  const lines = COMMANDS.map((c) => `  ${style.bold(c.name.padEnd(width))}  ${c.summary}`);
  return [
    `${style.bold(BRAND.name)} ${BRAND.version}: a linter for your company's promises`,
    '',
    `Usage: ${BRAND.command} <command> [options]`,
    '',
    ...lines,
    '',
    `Run ${BRAND.command} <command> --help for one command.`,
  ].join('\n');
}

export async function main(argv: readonly string[], rawEnv: NodeJS.ProcessEnv = process.env): Promise<number> {
  const env = withFileCredentials(rawEnv);
  const style = makeStyle(wantsColor(process.stdout, env));
  const [name, ...rest] = argv;
  if (!name || name === '--help' || name === '-h' || name === 'help') {
    process.stdout.write(`${help(style)}\n`);
    return 0;
  }
  if (name === '--version' || name === '-v') {
    process.stdout.write(`${BRAND.version}\n`);
    return 0;
  }
  const command = COMMANDS.find((c) => c.name === name);
  if (!command) {
    const close = COMMANDS.filter((c) => c.name.startsWith(name.slice(0, 3))).map((c) => c.name);
    process.stderr.write(
      `Unknown command "${name}".${close.length ? ` Did you mean: ${close.join(', ')}?` : ''} Run ${BRAND.command} --help.\n`,
    );
    return 2;
  }
  if (rest.includes('--help') || rest.includes('-h')) {
    process.stdout.write(`${command.summary}\n\nUsage: ${command.usage}\n`);
    return 0;
  }
  const ctx: CommandContext = {
    cwd: process.cwd(),
    argv: rest,
    env,
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
    style,
    now: () => new Date(),
  };
  try {
    return await command.run(ctx);
  } catch (error) {
    if (error instanceof JuratorError) {
      process.stderr.write(`${error.code}: ${error.message}\n`);
      return 2;
    }
    throw error;
  }
}
