// Owner: R4-UI. What the terminal can do, decided once from the stream, the environment and the command line.
// Live (redrawn) views only on a real terminal; plain one-line-per-event output in CI, pipes, --json, NO_COLOR and
// JURATOR_PLAIN=1. Colour depth: truecolor, 256 colours, 16 colours or none. Unicode symbols unless the terminal
// cannot show them. JURATOR_NO_ANIMATION=1 keeps the same lines without a spinner.

/** The parts of a write stream the interface reads (process.stdout / process.stderr, or a fake in tests). */
export interface UiStream {
  write(chunk: string): unknown;
  readonly isTTY?: boolean | undefined;
  readonly columns?: number | undefined;
  readonly rows?: number | undefined;
}

export type ColorDepth = 'truecolor' | '256' | '16' | 'none';

export interface Caps {
  /** Redraw in place (a terminal, nothing asking for plain output). */
  readonly live: boolean;
  readonly color: ColorDepth;
  readonly unicode: boolean;
  /** Spinners and per-frame motion (false with JURATOR_NO_ANIMATION=1). */
  readonly animate: boolean;
  /** Columns to lay out in (the terminal's, else COLUMNS, else 80), at least 40. */
  readonly width: number;
  /** Rows of the terminal (else LINES, else 24), at least 8. */
  readonly height: number;
  /** --verbose on the command line, or JURATOR_VERBOSE=1. */
  readonly verbose: boolean;
}

export interface CapsInput {
  readonly stream?: UiStream | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly argv?: readonly string[] | undefined;
}

const on = (v: string | undefined): boolean => v !== undefined && v !== '' && v !== '0' && v.toLowerCase() !== 'false';

/** Why output must be plain (null: a live view is fine). */
export function plainReason(input: CapsInput): string | null {
  const env = input.env ?? {};
  const argv = input.argv ?? [];
  if (on(env.JURATOR_PLAIN)) return 'JURATOR_PLAIN';
  if (argv.includes('--json')) return '--json';
  if (env.NO_COLOR !== undefined) return 'NO_COLOR';
  if (env.CI !== undefined && env.CI !== 'false' && env.CI !== '0') return 'CI';
  if (env.TERM === 'dumb') return 'TERM=dumb';
  if (!input.stream?.isTTY) return 'not a terminal';
  return null;
}

/** Colour depth: NO_COLOR and CI win, then FORCE_COLOR (0-3), then plain-output requests, then the terminal. */
export function colorDepth(input: CapsInput): ColorDepth {
  const env = input.env ?? {};
  const argv = input.argv ?? [];
  if (env.NO_COLOR !== undefined) return 'none';
  if (env.CI !== undefined && env.CI !== 'false' && env.CI !== '0') return 'none';
  const force = env.FORCE_COLOR;
  if (force !== undefined) {
    if (force === '0' || force.toLowerCase() === 'false') return 'none';
    if (force === '3') return 'truecolor';
    if (force === '2') return '256';
    return sniffDepth(env, '16');
  }
  if (on(env.JURATOR_PLAIN) || argv.includes('--json') || env.TERM === 'dumb') return 'none';
  if (!input.stream?.isTTY) return 'none';
  return sniffDepth(env, '16');
}

function sniffDepth(env: NodeJS.ProcessEnv, fallback: ColorDepth): ColorDepth {
  const ct = (env.COLORTERM ?? '').toLowerCase();
  if (ct === 'truecolor' || ct === '24bit') return 'truecolor';
  const program = env.TERM_PROGRAM ?? '';
  if (['iTerm.app', 'WezTerm', 'vscode', 'ghostty', 'Hyper', 'Tabby', 'rio'].includes(program)) return 'truecolor';
  if (env.WT_SESSION) return 'truecolor';
  const term = env.TERM ?? '';
  if (/-direct|truecolor/u.test(term)) return 'truecolor';
  if (/256/u.test(term)) return '256';
  return fallback;
}

/** Unicode symbols unless asked otherwise (JURATOR_ASCII=1) or the terminal is a bare console. */
export function unicodeOk(env: NodeJS.ProcessEnv): boolean {
  if (on(env.JURATOR_ASCII)) return false;
  if (env.TERM === 'linux' || env.TERM === 'dumb') return false;
  const locale = env.LC_ALL || env.LC_CTYPE || env.LANG;
  if (locale && locale !== 'C.UTF-8' && /^(C|POSIX)$/u.test(locale)) return false;
  return true;
}

export function detectCaps(input: CapsInput = {}): Caps {
  const env = input.env ?? {};
  const argv = input.argv ?? [];
  const cols = input.stream?.columns || Number(env.COLUMNS) || 80;
  const rows = input.stream?.rows || Number(env.LINES) || 24;
  return {
    live: plainReason(input) === null,
    color: colorDepth(input),
    unicode: unicodeOk(env),
    animate: !on(env.JURATOR_NO_ANIMATION),
    width: Math.max(40, Math.floor(cols)),
    height: Math.max(8, Math.floor(rows)),
    verbose: argv.includes('--verbose') || on(env.JURATOR_VERBOSE),
  };
}
