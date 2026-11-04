// Owner: DS-B. Light markdown for Jurator's answers: paragraphs, **bold**, `inline code`, fenced code (marked as model
// text, never evidence), lists and headings; cite markers `[[path:12-14]]` show as a dim `path:12-14`. Every line is
// wrapped to the width; model text is cleaned of escape sequences first.
import type { Theme, Symbols } from '../../ui/theme.js';
import { charWidth, sanitize, stripAnsi, truncate, width as textWidth } from '../../ui/text.js';

export type SegKind = 'plain' | 'bold' | 'code' | 'cite';
export interface Seg {
  readonly text: string;
  readonly kind: SegKind;
}

/** Untrusted text (model, repository, policy) made safe: no escapes at all, not even colour, tabs as spaces. */
export function clean(s: string, singleLine = false): string {
  return stripAnsi(sanitize(s, singleLine));
}

const INLINE = /(\*\*[^*\n]+\*\*)|(`[^`\n]+`)|(\[\[[^\]\s:]+:\d{1,7}(?:-\d{1,7})?\]\])/gu;

export function parseInline(s: string): Seg[] {
  const out: Seg[] = [];
  let last = 0;
  for (const m of s.matchAll(INLINE)) {
    const at = m.index ?? 0;
    if (at > last) out.push({ text: s.slice(last, at), kind: 'plain' });
    const t = m[0];
    if (m[1]) out.push({ text: t.slice(2, -2), kind: 'bold' });
    else if (m[2]) out.push({ text: t.slice(1, -1), kind: 'code' });
    else out.push({ text: t.slice(2, -2), kind: 'cite' });
    last = at + t.length;
  }
  if (last < s.length) out.push({ text: s.slice(last), kind: 'plain' });
  return out;
}

type Word = Seg[];

/** Greedy word wrap over styled segments; words longer than a line are broken hard. */
export function wrapSegs(segs: readonly Seg[], max: number): Seg[][] {
  const m = Math.max(1, max);
  const words: Word[] = [];
  let cur: Word = [];
  for (const seg of segs) {
    const parts = seg.text.split(/(\s+)/u);
    for (const p of parts) {
      if (p === '') continue;
      if (/^\s+$/u.test(p)) {
        if (cur.length) words.push(cur);
        cur = [];
      } else cur.push({ text: p, kind: seg.kind });
    }
  }
  if (cur.length) words.push(cur);
  const wordWidth = (w: Word): number => w.reduce((n, s) => n + textWidth(s.text), 0);
  const lines: Seg[][] = [];
  let line: Seg[] = [];
  let lineW = 0;
  const pushLine = (): void => {
    lines.push(line);
    line = [];
    lineW = 0;
  };
  for (let word of words) {
    while (wordWidth(word) > m) {
      // Hard break: fill what is left of the line (or a whole fresh line).
      if (lineW > 0) pushLine();
      const head: Seg[] = [];
      let used = 0;
      const rest: Seg[] = [];
      for (const s of word) {
        if (used >= m) {
          rest.push(s);
          continue;
        }
        let take = '';
        let left = '';
        for (const ch of s.text) {
          if (left === '' && used + charWidth(ch) <= m) {
            take += ch;
            used += charWidth(ch);
          } else left += ch;
        }
        if (take) head.push({ text: take, kind: s.kind });
        if (left) rest.push({ text: left, kind: s.kind });
      }
      lines.push(head);
      word = rest;
    }
    if (word.length === 0) continue;
    const ww = wordWidth(word);
    if (lineW > 0 && lineW + 1 + ww > m) pushLine();
    if (lineW > 0) {
      line.push({ text: ' ', kind: 'plain' });
      lineW += 1;
    }
    line.push(...word);
    lineW += ww;
  }
  if (line.length || lines.length === 0) lines.push(line);
  return lines;
}

export function paintSegs(segs: readonly Seg[], theme: Theme): string {
  return segs
    .map((s) => {
      switch (s.kind) {
        case 'bold':
          return theme.bold(s.text);
        case 'code':
          return theme.style.blue(s.text);
        case 'cite':
          return theme.muted(s.text);
        default:
          return s.text;
      }
    })
    .join('');
}

export interface MarkdownLook {
  readonly theme: Theme;
  readonly sym: Symbols;
  /** Columns available for the text (prefixes not included). */
  readonly width: number;
}

/** Renders markdown into lines of at most `look.width` columns (no prefix). */
export function renderMarkdown(text: string, look: MarkdownLook): string[] {
  const { theme, sym } = look;
  const w = Math.max(10, look.width);
  const src = clean(text).split('\n');
  const out: string[] = [];
  let para: string[] = [];
  const flush = (): void => {
    if (para.length === 0) return;
    for (const l of wrapSegs(parseInline(para.join(' ')), w)) out.push(paintSegs(l, theme));
    para = [];
  };
  for (let i = 0; i < src.length; i += 1) {
    const line = src[i] as string;
    const fence = /^\s*(```|~~~)/u.exec(line);
    if (fence) {
      flush();
      const close = fence[1] as string;
      const code: string[] = [];
      i += 1;
      while (i < src.length && !(src[i] as string).trimStart().startsWith(close)) {
        code.push(src[i] as string);
        i += 1;
      }
      out.push(`${theme.faint(sym.gutter)} ${theme.muted(theme.italic('model text, not evidence'))}`);
      for (const c of code) out.push(`${theme.faint(sym.gutter)} ${truncate(c, w - 2)}`);
      continue;
    }
    if (line.trim() === '') {
      flush();
      if (out.length && out[out.length - 1] !== '') out.push('');
      continue;
    }
    const heading = /^\s{0,3}#{1,6}\s+(.*)$/u.exec(line);
    if (heading) {
      flush();
      for (const l of wrapSegs([{ text: heading[1] ?? '', kind: 'bold' }], w)) out.push(paintSegs(l, theme));
      continue;
    }
    const item = /^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/u.exec(line);
    if (item) {
      flush();
      const depth = Math.min(3, Math.floor((item[1] ?? '').length / 2));
      const marker = /^\d/u.test(item[2] ?? '') ? (item[2] as string) : sym.bullet;
      const indent = '  '.repeat(depth);
      const hang = ' '.repeat(textWidth(marker) + 1);
      const body = wrapSegs(parseInline(item[3] ?? ''), w - indent.length - hang.length);
      body.forEach((l, k) => out.push(`${indent}${k === 0 ? `${marker} ` : hang}${paintSegs(l, theme)}`));
      continue;
    }
    para.push(line.trim());
  }
  flush();
  while (out.length && out[out.length - 1] === '') out.pop();
  return out;
}
