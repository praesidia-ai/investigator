// A tiny terminal emulator for tests: enough of VT100 to replay what the discuss screen writes (CR, LF with scroll
// into scrollback, cursor up/down/forward, erase below, clear screen) and read back the visible text.
import { charWidth } from '../../../src/ui/text.js';

export class Vt {
  screen: string[][];
  scrollback: string[] = [];
  row = 0;
  col = 0;
  cursorVisible = true;

  readonly cols: number;
  readonly rows: number;

  constructor(cols: number, rows: number) {
    this.cols = cols;
    this.rows = rows;
    this.screen = Array.from({ length: rows }, () => []);
  }

  private lf(): void {
    if (this.row === this.rows - 1) {
      this.scrollback.push(this.line(0));
      this.screen.shift();
      this.screen.push([]);
    } else this.row += 1;
  }

  private line(i: number): string {
    return (this.screen[i] ?? []).map((c) => c ?? ' ').join('').replace(/\s+$/u, '');
  }

  write(s: string): void {
    let i = 0;
    while (i < s.length) {
      const ch = s[i] as string;
      if (ch === '\u001b') {
        const m = /^\u001b\[([?0-9;]*)([A-Za-z])/u.exec(s.slice(i));
        if (!m) {
          i += 1;
          continue;
        }
        const p = m[1] ?? '';
        const n = Number(p.replace('?', '')) || 0;
        switch (m[2]) {
          case 'A':
            this.row = Math.max(0, this.row - (n || 1));
            break;
          case 'B':
            this.row = Math.min(this.rows - 1, this.row + (n || 1));
            break;
          case 'C':
            this.col = Math.min(this.cols - 1, this.col + (n || 1));
            break;
          case 'D':
            this.col = Math.max(0, this.col - (n || 1));
            break;
          case 'J':
            if (p === '2') this.screen = Array.from({ length: this.rows }, () => []);
            else if (p === '3') this.scrollback = [];
            else {
              this.screen[this.row] = (this.screen[this.row] ?? []).slice(0, this.col);
              for (let r = this.row + 1; r < this.rows; r += 1) this.screen[r] = [];
            }
            break;
          case 'K':
            this.screen[this.row] = (this.screen[this.row] ?? []).slice(0, this.col);
            break;
          case 'H':
            this.row = 0;
            this.col = 0;
            break;
          case 'h':
            if (p === '?25') this.cursorVisible = true;
            break;
          case 'l':
            if (p === '?25') this.cursorVisible = false;
            break;
          default:
            break;
        }
        i += m[0].length;
        continue;
      }
      if (ch === '\r') {
        this.col = 0;
        i += 1;
        continue;
      }
      if (ch === '\n') {
        this.lf();
        i += 1;
        continue;
      }
      const cp = s.codePointAt(i) ?? 0;
      const c = String.fromCodePoint(cp);
      const w = charWidth(c);
      if (this.col + w > this.cols) {
        // Autowrap (the screen never relies on it; a test fails when a line is too long).
        this.col = 0;
        this.lf();
      }
      const line = this.screen[this.row] ?? [];
      while (line.length < this.col) line.push(' ');
      line[this.col] = c;
      if (w === 2) line[this.col + 1] = '';
      this.screen[this.row] = line;
      this.col += w;
      i += c.length;
    }
  }

  /** The visible screen, trailing blank lines dropped. */
  text(): string[] {
    const out = this.screen.map((_, i) => this.line(i));
    while (out.length && out[out.length - 1] === '') out.pop();
    return out;
  }

  /** Scrollback plus screen. */
  all(): string[] {
    return [...this.scrollback, ...this.text()];
  }
}
