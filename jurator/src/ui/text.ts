// Owner: R4-UI. Text measuring for the terminal: colour codes take no columns, wide characters (CJK, emoji) take two,
// and text from repositories or models is cleaned before it reaches the screen (no cursor moves, no bidi overrides).

/** SGR colour codes only: the one kind of escape sequence the interface itself writes into text. */
const SGR = /\u001b\[[0-9;:]*m/gu;
/** Every escape sequence: CSI (cursor moves, clears), OSC (titles, links), and the two-byte forms. */
const ANY_ESCAPE = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[@-Z\\-_])/gu;
/** C0 and C1 control characters except newline and the ESC that starts an SGR code. */
const CONTROLS = /[\u0000-\u0009\u000b-\u001a\u001c-\u001f\u007f-\u009f]/gu;
/** Bidi overrides and isolates: they reorder what a reader sees (Trojan Source). */
const BIDI = /[‪-‮⁦-⁩]/gu;

/** Removes every colour code. */
export function stripAnsi(s: string): string {
  return s.replace(SGR, '');
}

/**
 * Makes untrusted text safe to print: tabs become two spaces, colour codes stay, every other escape sequence and
 * control character is removed, and bidi overrides are dropped. `singleLine` also folds newlines into spaces.
 */
export function sanitize(s: string, singleLine = false): string {
  let out = s.replace(/\r\n?/gu, '\n').replace(/\t/gu, '  ');
  out = out.replace(ANY_ESCAPE, (m) => (/^\u001b\[[0-9;:]*m$/u.test(m) ? m : ''));
  out = out.replace(CONTROLS, '').replace(BIDI, '');
  out = out.replace(/\u001b(?!\[[0-9;:]*m)/gu, '');
  return singleLine ? out.replace(/\s*\n\s*/gu, ' ') : out;
}

function isZeroWidth(cp: number): boolean {
  return (
    (cp >= 0x0300 && cp <= 0x036f) || // combining diacritics
    (cp >= 0x200b && cp <= 0x200f) || // zero-width space, joiners, marks
    (cp >= 0xfe00 && cp <= 0xfe0f) || // variation selectors
    (cp >= 0x1ab0 && cp <= 0x1aff) ||
    (cp >= 0x20d0 && cp <= 0x20ff) ||
    (cp >= 0xe0100 && cp <= 0xe01ef)
  );
}
function isWide(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x1fa70 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  );
}
/** Columns one character takes. */
export function charWidth(ch: string): number {
  const cp = ch.codePointAt(0) ?? 0;
  if (isZeroWidth(cp)) return 0;
  return isWide(cp) ? 2 : 1;
}

/** Columns a single line takes on screen. */
export function width(s: string): number {
  let w = 0;
  for (const ch of stripAnsi(s)) w += charWidth(ch);
  return w;
}

/** Splits a string into colour codes and visible characters, in order. */
function tokens(s: string): { code: boolean; text: string }[] {
  const out: { code: boolean; text: string }[] = [];
  let last = 0;
  for (const m of s.matchAll(SGR)) {
    const at = m.index ?? 0;
    for (const ch of s.slice(last, at)) out.push({ code: false, text: ch });
    out.push({ code: true, text: m[0] });
    last = at + m[0].length;
  }
  for (const ch of s.slice(last)) out.push({ code: false, text: ch });
  return out;
}

/**
 * Cuts a line to at most `max` columns, ending in `ellipsis` when something was cut. Colour codes are kept (and
 * closed with a reset when the line was cut inside a coloured span).
 */
export function truncate(s: string, max: number, ellipsis = '…'): string {
  if (max <= 0) return '';
  if (width(s) <= max) return s;
  const room = Math.max(0, max - width(ellipsis));
  let used = 0;
  let out = '';
  let coloured = false;
  for (const t of tokens(s)) {
    if (t.code) {
      out += t.text;
      coloured = t.text !== '\u001b[0m';
      continue;
    }
    const w = charWidth(t.text);
    if (used + w > room) break;
    out += t.text;
    used += w;
  }
  const end = ellipsis.length > 0 && width(ellipsis) <= max ? ellipsis : '';
  return `${out}${coloured ? '\u001b[0m' : ''}${end}`;
}

/** Pads with spaces on the right to `w` columns (no cut). */
export function padEnd(s: string, w: number): string {
  const n = w - width(s);
  return n > 0 ? s + ' '.repeat(n) : s;
}
/** Pads with spaces on the left to `w` columns (no cut). */
export function padStart(s: string, w: number): string {
  const n = w - width(s);
  return n > 0 ? ' '.repeat(n) + s : s;
}
/** Exactly `w` columns: cut with … or padded. */
export function fit(s: string, w: number, align: 'left' | 'right' = 'left', ellipsis = '…'): string {
  const cut = truncate(s, w, ellipsis);
  return align === 'right' ? padStart(cut, w) : padEnd(cut, w);
}

/**
 * Folds text into lines of at most `max` columns at spaces; a word longer than a line (a regex, a path) is broken
 * hard. Plain text only (call it before colouring). `limit` keeps at most that many lines, the last one cut with ….
 */
export function wrap(s: string, max: number, limit = Number.POSITIVE_INFINITY, ellipsis = '…'): string[] {
  const m = Math.max(1, Math.floor(max));
  const out: string[] = [];
  for (const para of s.split('\n')) {
    const words = para.replace(/\s+/gu, ' ').trim().split(' ').filter(Boolean);
    let line = '';
    for (let word of words) {
      while (width(word) > m) {
        if (line) {
          out.push(line);
          line = '';
        }
        let head = '';
        let w = 0;
        let i = 0;
        const chars = [...word];
        for (; i < chars.length; i += 1) {
          const cw = charWidth(chars[i] as string);
          if (w + cw > m) break;
          head += chars[i];
          w += cw;
        }
        out.push(head);
        word = chars.slice(i).join('');
      }
      if (!word) continue;
      if (line && width(line) + 1 + width(word) > m) {
        out.push(line);
        line = word;
      } else line = line ? `${line} ${word}` : word;
    }
    out.push(line);
  }
  while (out.length > 1 && out[out.length - 1] === '') out.pop();
  const n = Math.max(1, Math.floor(limit));
  if (out.length > n) {
    const kept = out.slice(0, n);
    const rest = out.slice(n - 1).join(' ');
    kept[n - 1] = width(rest) > m ? truncate(rest, m, ellipsis) : truncate(`${rest}${ellipsis}`, m, ellipsis);
    return kept;
  }
  return out;
}

/** "$1.32" (four decimals under a cent, so a tiny cost is not shown as $0.00). */
export function money(usd: number): string {
  return usd > 0 && usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}

/** "850ms", "8.2s", "1m 12s", "1h 03m". */
export function duration(ms: number): string {
  const v = Math.max(0, ms);
  if (v < 1000) return `${Math.round(v)}ms`;
  if (v < 10_000) return `${(Math.floor(v / 100) / 10).toFixed(1)}s`;
  const s = Math.floor(v / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

/**
 * R5-B: a list of promise ids as a short phrase: up to 3 are listed; longer lists become ranges per source
 * ("documents.01 to documents.32"), and more than 3 ranges become the first two and a count ("... and 9 more").
 */
export function idRange(ids: readonly string[]): string {
  if (ids.length <= 3) return ids.join(' ');
  const parsed = ids.map((id) => {
    const m = /^(.*)\.(\d+)$/u.exec(id);
    return m ? { id, prefix: m[1] as string, n: Number(m[2]) } : { id, prefix: id, n: Number.NaN };
  });
  const runs: Array<{ first: string; last: string; count: number }> = [];
  let prev: (typeof parsed)[number] | undefined;
  for (const p of parsed) {
    const run = runs[runs.length - 1];
    if (run && prev && prev.prefix === p.prefix && Number.isFinite(p.n) && p.n === prev.n + 1) {
      run.last = p.id;
      run.count += 1;
    } else runs.push({ first: p.id, last: p.id, count: 1 });
    prev = p;
  }
  const text = (r: (typeof runs)[number]): string => (r.count === 1 ? r.first : r.count === 2 ? `${r.first} ${r.last}` : `${r.first} to ${r.last}`);
  if (runs.length <= 3) return runs.map(text).join(', ');
  const shown = runs.slice(0, 2);
  const rest = ids.length - shown.reduce((n, r) => n + r.count, 0);
  return `${shown.map(text).join(', ')} and ${rest} more`;
}
