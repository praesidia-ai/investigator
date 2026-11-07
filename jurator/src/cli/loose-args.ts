import { JuratorError } from '../util/errors.js';

export interface LooseArgs {
  readonly positional: string[];
  readonly flags: ReadonlySet<string>;
  readonly values: Readonly<Record<string, string>>;
}

/** Lenient argv scan: listed options take a value, other `--x` are flags (no unknown-option error). */
export function scanArgs(argv: readonly string[], valueOptions: readonly string[], rename: Readonly<Record<string, string>> = {}): LooseArgs {
  const positional: string[] = [];
  const flags = new Set<string>();
  const values: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i] as string;
    if (valueOptions.includes(a)) {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) throw new JuratorError('BAD_INPUT', `${a} needs a value`);
      values[rename[a] ?? a.slice(2)] = v;
      i += 1;
    } else if (a.startsWith('--')) flags.add(a.slice(2));
    else positional.push(a);
  }
  return { positional, flags, values };
}
