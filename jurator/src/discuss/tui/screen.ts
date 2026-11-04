// Owner: DS-B. The differential renderer, in pi-mono's way: the main screen (no alternate screen, so the terminal's
// own scrollback and search keep working). Finished blocks are written once above the live region; the live region
// (running turn, status, editor, footer) is redrawn from its first changed line, inside synchronized output
// (CSI ?2026h/l) with the cursor hidden, then the cursor is put back in the editor. Every line is cut to cols - 1 and
// ends with a reset, so a line never wraps and colour never leaks.
import { truncate, width as textWidth } from '../../ui/text.js';

export interface ScreenOut {
  write(chunk: string): unknown;
}

export interface Frame {
  readonly lines: readonly string[];
  /** Where the terminal cursor goes (row inside `lines`, column), or null to keep it hidden. */
  readonly cursor: { readonly row: number; readonly col: number } | null;
}

const SYNC_ON = '\u001b[?2026h';
const SYNC_OFF = '\u001b[?2026l';
const HIDE = '\u001b[?25l';
const SHOW = '\u001b[?25h';
const RESET = '\u001b[0m';
const CLEAR_DOWN = '\u001b[J';

const up = (n: number): string => (n > 0 ? `\u001b[${n}A` : '');
const down = (n: number): string => (n > 0 ? `\u001b[${n}B` : '');
const right = (n: number): string => (n > 0 ? `\u001b[${n}C` : '');

export class Screen {
  private prev: string[] = [];
  /** The row (inside the last frame) the terminal cursor is on now. */
  private cursorRow = 0;
  /** Physical rows between the top of the live region and the cursor, when a resize made `cursorRow` wrong. */
  private rowsUpOverride: number | null = null;
  private width: number;
  /** Bytes written, for tests and the "never flickers" check (each frame is one write). */
  writes = 0;

  private readonly out: ScreenOut;

  constructor(out: ScreenOut, width: number) {
    this.out = out;
    this.width = Math.max(10, width);
  }

  private fitLine(line: string): string {
    return `${truncate(line, this.width - 1, '')}${RESET}`;
  }

  /** Back to the first row of the live region, at column 0. */
  private toTop(): string {
    const n = this.rowsUpOverride ?? this.cursorRow;
    this.rowsUpOverride = null;
    return `${up(n)}\r`;
  }

  private place(frame: Frame, atRow: number): string {
    if (!frame.cursor) {
      this.cursorRow = atRow;
      return '';
    }
    const row = Math.min(Math.max(0, frame.cursor.row), Math.max(0, frame.lines.length - 1));
    this.cursorRow = row;
    return `${up(atRow - row)}\r${right(frame.cursor.col)}${SHOW}`;
  }

  /** Redraws the live region from its first changed line. */
  render(frame: Frame): void {
    this.emit(this.diff(frame));
  }

  private diff(frame: Frame): string {
    const next = frame.lines.map((l) => this.fitLine(l));
    let first = 0;
    while (first < next.length && first < this.prev.length && next[first] === this.prev[first]) first += 1;
    if (first === next.length && first === this.prev.length && this.rowsUpOverride === null) {
      // No line changed; only the cursor may have moved.
      if (!frame.cursor) return '';
      const target = Math.min(Math.max(0, frame.cursor.row), Math.max(0, next.length - 1));
      const move = target < this.cursorRow ? up(this.cursorRow - target) : down(target - this.cursorRow);
      this.cursorRow = target;
      return `${HIDE}${move}\r${right(frame.cursor.col)}${SHOW}`;
    }
    let s = `${HIDE}${this.toTop()}`;
    if (this.prev.length === 0 || first === 0) {
      s += `${CLEAR_DOWN}${next.join('\r\n')}`;
    } else if (first < this.prev.length) {
      s += `${down(first)}${CLEAR_DOWN}${next.slice(first).join('\r\n')}`;
    } else {
      // Only appended lines: go to the end of the last old line and open new rows.
      s += `${down(this.prev.length - 1)}\r\n${CLEAR_DOWN}${next.slice(first).join('\r\n')}`;
    }
    // Where the cursor is now: the last written line, or row `first` after a pure removal at the end.
    const atRow = first >= next.length ? first : next.length - 1;
    this.prev = next;
    return `${s}${this.place(frame, atRow)}`;
  }

  /** Writes finished lines into the scrollback above the live region, then redraws the live region below them. */
  commit(lines: readonly string[], frame: Frame): void {
    let s = `${HIDE}${this.toTop()}${CLEAR_DOWN}`;
    for (const l of lines) s += `${this.fitLine(l)}\r\n`;
    this.prev = [];
    this.cursorRow = 0;
    s += this.diff(frame);
    this.emit(s);
  }

  /**
   * The terminal changed width. Terminals that reflow wrap the old lines, so the way back to the top of the live
   * region is counted in rows at the new width; then the whole live region is drawn again.
   */
  resize(width: number, frame: Frame): void {
    const w = Math.max(10, width);
    if (w < this.width) {
      let rows = 0;
      for (let i = 0; i < this.cursorRow; i += 1) rows += Math.max(1, Math.ceil(textWidth(this.prev[i] ?? '') / w));
      this.rowsUpOverride = rows;
    } else this.rowsUpOverride = this.cursorRow;
    this.width = w;
    this.prev = [];
    this.emit(this.diffFromTop(frame));
  }

  private diffFromTop(frame: Frame): string {
    const s = `${HIDE}${this.toTop()}${CLEAR_DOWN}`;
    this.cursorRow = 0;
    this.prev = [];
    return s + this.diff(frame);
  }

  /** Ctrl-L: clears the screen and its scrollback, then prints `lines` and the live region again. */
  reprint(lines: readonly string[], frame: Frame): void {
    let s = `${HIDE}\u001b[2J\u001b[3J\u001b[H`;
    for (const l of lines) s += `${this.fitLine(l)}\r\n`;
    this.prev = [];
    this.cursorRow = 0;
    this.rowsUpOverride = null;
    s += this.diff(frame);
    this.emit(s);
  }

  /** Removes the live region and shows the cursor (before printing the goodbye lines). */
  clear(): void {
    this.emit(`${this.toTop()}${CLEAR_DOWN}${SHOW}`);
    this.prev = [];
    this.cursorRow = 0;
  }

  private emit(s: string): void {
    if (!s) return;
    this.writes += 1;
    this.out.write(`${SYNC_ON}${s}${SYNC_OFF}`);
  }
}
