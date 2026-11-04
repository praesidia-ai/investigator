// Owner: R4-UI. The look: Praesidia amber as the one accent, slate greys for everything secondary, and green and red
// only for kept and broken. Truecolor when the terminal has it, the nearest 256-colour codes next, then the 16 basic
// colours, then nothing at all (not one escape code). Symbols are Unicode with an ASCII set for bare consoles.
import type { Style } from '../util/term.js';
import type { ColorDepth } from './caps.js';

type Paint = (s: string) => string;

export interface Theme {
  readonly depth: ColorDepth;
  /** Praesidia amber: the mark, section titles, the progress bar, the Next line. */
  readonly accent: Paint;
  /** Kept: HOLDS, LOOKS KEPT, a finished step. */
  readonly kept: Paint;
  /** Broken: BROKEN, BROKEN NOW, LOOKS BROKEN, a failed step. */
  readonly broken: Paint;
  /** Slate: labels, borders, timings, secondary text. */
  readonly muted: Paint;
  /** A darker slate for rules and tracks. */
  readonly faint: Paint;
  readonly bold: Paint;
  readonly dim: Paint;
  readonly italic: Paint;
  /** Filled chips (a badge on a coloured background). */
  readonly chip: { readonly accent: Paint; readonly kept: Paint; readonly broken: Paint; readonly muted: Paint };
  /** The same theme as the older `Style` interface, for renderers written against src/util/term.ts. */
  readonly style: Style;
}

interface Rgb {
  readonly hex: string;
  readonly c256: number;
  readonly c16: number;
}
const C = {
  amber: { hex: '#f59e0b', c256: 214, c16: 33 },
  green: { hex: '#22c55e', c256: 41, c16: 32 },
  red: { hex: '#ef4444', c256: 203, c16: 31 },
  slate: { hex: '#64748b', c256: 244, c16: 90 },
  slateDark: { hex: '#475569', c256: 240, c16: 90 },
  blue: { hex: '#60a5fa', c256: 75, c16: 34 },
  // chip backgrounds and their text
  amberBg: { hex: '#f59e0b', c256: 214, c16: 43 },
  greenBg: { hex: '#16a34a', c256: 28, c16: 42 },
  redBg: { hex: '#dc2626', c256: 160, c16: 41 },
  slateBg: { hex: '#475569', c256: 240, c16: 100 },
  ink: { hex: '#0f172a', c256: 16, c16: 30 },
  paper: { hex: '#ffffff', c256: 231, c16: 97 },
} as const satisfies Record<string, Rgb>;

function rgb(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function fgCode(depth: ColorDepth, c: Rgb): string {
  if (depth === 'truecolor') return `38;2;${rgb(c.hex).join(';')}`;
  if (depth === '256') return `38;5;${c.c256}`;
  return String(c.c16);
}
function bgCode(depth: ColorDepth, c: Rgb): string {
  if (depth === 'truecolor') return `48;2;${rgb(c.hex).join(';')}`;
  if (depth === '256') return `48;5;${c.c256}`;
  return String(c.c16);
}

export function makeTheme(depth: ColorDepth): Theme {
  const none = depth === 'none';
  const sgr =
    (open: string, close: string): Paint =>
    (s) =>
      none || s === '' ? s : `\u001b[${open}m${s}\u001b[${close}m`;
  const fg = (c: Rgb): Paint => sgr(fgCode(depth, c), '39');
  // 16 colours: slate is "bright black", which some dark schemes hide; use dim there instead.
  const slate: Paint = depth === '16' ? sgr('2', '22') : fg(C.slate);
  const slateDark: Paint = depth === '16' ? sgr('2', '22') : fg(C.slateDark);
  const chip = (bg: Rgb, text: Rgb): Paint => sgr(`${bgCode(depth, bg)};${fgCode(depth, text)};1`, '22;39;49');
  const bold = sgr('1', '22');
  const dim = sgr('2', '22');
  const theme: Omit<Theme, 'style'> = {
    depth,
    accent: fg(C.amber),
    kept: fg(C.green),
    broken: fg(C.red),
    muted: slate,
    faint: slateDark,
    bold,
    dim,
    italic: sgr('3', '23'),
    chip: {
      accent: chip(C.amberBg, C.ink),
      kept: chip(C.greenBg, depth === '16' ? C.ink : C.paper),
      broken: chip(C.redBg, C.paper),
      muted: chip(C.slateBg, C.paper),
    },
  };
  const style: Style = {
    color: !none,
    green: theme.kept,
    red: theme.broken,
    yellow: theme.accent,
    blue: fg(C.blue),
    dim,
    bold,
  };
  return { ...theme, style };
}

export interface Symbols {
  readonly mark: string;
  readonly done: string;
  readonly failed: string;
  readonly skipped: string;
  readonly waiting: string;
  /** A running step when there is no spinner (reduced motion). */
  readonly running: string;
  readonly arrow: string;
  readonly dot: string;
  readonly bullet: string;
  readonly ellipsis: string;
  readonly spinner: readonly string[];
  readonly bar: { readonly full: string; readonly half: string; readonly empty: string };
  readonly rule: string;
  readonly heavy: Box;
  readonly round: Box;
  readonly gutter: string;
}
export interface Box {
  readonly tl: string;
  readonly tr: string;
  readonly bl: string;
  readonly br: string;
  readonly h: string;
  readonly v: string;
}

export const UNICODE: Symbols = {
  mark: '◆',
  done: '✓',
  failed: '✗',
  skipped: '–',
  waiting: '○',
  running: '▸',
  arrow: '→',
  dot: '·',
  bullet: '•',
  ellipsis: '…',
  spinner: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'],
  bar: { full: '━', half: '╸', empty: '─' },
  rule: '─',
  heavy: { tl: '┏', tr: '┓', bl: '┗', br: '┛', h: '━', v: '┃' },
  round: { tl: '╭', tr: '╮', bl: '╰', br: '╯', h: '─', v: '│' },
  gutter: '│',
};
export const ASCII: Symbols = {
  mark: '*',
  done: '+',
  failed: 'x',
  skipped: '-',
  waiting: '.',
  running: '>',
  arrow: '->',
  dot: '-',
  bullet: '*',
  ellipsis: '...',
  spinner: ['|', '/', '-', '\\'],
  bar: { full: '#', half: '#', empty: '-' },
  rule: '-',
  heavy: { tl: '+', tr: '+', bl: '+', br: '+', h: '=', v: '|' },
  round: { tl: '+', tr: '+', bl: '+', br: '+', h: '-', v: '|' },
  gutter: '|',
};
