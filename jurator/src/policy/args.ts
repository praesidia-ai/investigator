// Owner: WP-P. Tiny argv parser for the policy commands (no dependency).
import { JuratorError } from '../util/errors.js';

export interface ParsedArgs {
  readonly flags: ReadonlySet<string>;
  readonly values: ReadonlyMap<string, string[]>;
  readonly positionals: string[];
}
export interface ArgSpec {
  /** Boolean options, e.g. ['json', 'all']. */
  readonly flags?: readonly string[];
  /** Options that take one value, e.g. ['scripted', 'alias']. */
  readonly values?: readonly string[];
  /** Options that take every following non-option word, e.g. ['for']. */
  readonly lists?: readonly string[];
}

export function parseArgs(argv: readonly string[], spec: ArgSpec, usage: string): ParsedArgs {
  const flags = new Set<string>();
  const values = new Map<string, string[]>();
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (!arg.startsWith('--')) {
      positionals.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    const name = eq > 0 ? arg.slice(2, eq) : arg.slice(2);
    const inline = eq > 0 ? arg.slice(eq + 1) : undefined;
    if (spec.flags?.includes(name)) {
      flags.add(name);
    } else if (spec.values?.includes(name)) {
      const value = inline ?? argv[i + 1];
      if (value === undefined || (inline === undefined && value.startsWith('--'))) {
        throw new JuratorError('BAD_INPUT', `--${name} needs a value. Usage: ${usage}`);
      }
      if (inline === undefined) i += 1;
      values.set(name, [...(values.get(name) ?? []), value]);
    } else if (spec.lists?.includes(name)) {
      const list = values.get(name) ?? [];
      if (inline !== undefined) list.push(inline);
      while (argv[i + 1] !== undefined && !(argv[i + 1] as string).startsWith('--')) {
        list.push(argv[i + 1] as string);
        i += 1;
      }
      if (!list.length) throw new JuratorError('BAD_INPUT', `--${name} needs at least one value. Usage: ${usage}`);
      values.set(name, list);
    } else {
      throw new JuratorError('BAD_INPUT', `Unknown option ${arg}. Usage: ${usage}`);
    }
  }
  return { flags, values, positionals };
}

export function one(args: ParsedArgs, name: string): string | undefined {
  const v = args.values.get(name);
  return v ? v[v.length - 1] : undefined;
}
