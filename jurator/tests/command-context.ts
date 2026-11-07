import type { CommandContext } from '../src/cli/context.js';
import { makeStyle } from '../src/util/term.js';

/** Test-only: a plain-style CommandContext that captures stdout and stderr lines separately. */
export function makeCtx(cwd: string, argv: string[], now = () => new Date('2026-11-04T04:00:00.000Z')) {
  const out: string[] = [];
  const err: string[] = [];
  const c: CommandContext = {
    cwd,
    argv,
    env: {},
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    style: makeStyle(false),
    now,
  };
  return { c, out, err };
}
