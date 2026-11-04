// Owner: WP-P. Locating policy quotes in the policy text (principle 3: the program finds every quote itself).

/** One-to-one character folds applied to both the text and the quote (curly quotes, dashes, odd spaces). */
const FOLD: Readonly<Record<string, string>> = {
  '‘': "'",
  '’': "'",
  '“': '"',
  '”': '"',
  '–': '-',
  '—': '-',
  ' ': ' ',
};
/** Markdown emphasis characters ignored on both sides. */
const EMPHASIS = new Set(['*', '_', '`']);
const LIST_MARKER = /^\s*(?:[-*+]|\d{1,3}[.)])\s+/u;

interface Folded {
  readonly text: string;
  /** map[i] = index in the raw text of folded character i. */
  readonly map: number[];
}

function fold(raw: string): Folded {
  let text = '';
  const map: number[] = [];
  let inSpace = false;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = FOLD[raw[i] as string] ?? (raw[i] as string);
    if (EMPHASIS.has(ch)) continue;
    if (/\s/u.test(ch)) {
      if (inSpace) continue;
      inSpace = true;
      text += ' ';
      map.push(i);
      continue;
    }
    inSpace = false;
    text += ch;
    map.push(i);
  }
  return { text, map };
}

function quoteForms(quote: string): { base: string; noMarker: string; unwrapped: string } {
  const base = fold(quote).text.trim();
  const noMarker = base.replace(LIST_MARKER, '').trim();
  const unwrapped = noMarker.replace(/^["']+|["']+$/gu, '').trim();
  return { base, noMarker, unwrapped };
}
/** Candidate needles, best first: without list marker, without wrapping quotes, then as given. */
function cleanQuote(quote: string): string[] {
  const f = quoteForms(quote);
  return [...new Set([f.noMarker, f.unwrapped, f.base])].filter((q) => q.length > 0);
}

/**
 * Finds `quote` in `text` with whitespace runs collapsed on both sides (also ignoring a leading list marker, markdown
 * emphasis and curly quotes). Returns raw UTF-16 offsets (end exclusive) and the 1-based line of the start.
 */
export function locateQuote(text: string, quote: string): { start: number; end: number; line: number } | null {
  const hay = fold(text);
  for (const needle of cleanQuote(quote)) {
    const at = hay.text.indexOf(needle);
    if (at < 0) continue;
    const start = hay.map[at] as number;
    const end = (hay.map[at + needle.length - 1] as number) + 1;
    return { start, end, line: lineAt(text, start) };
  }
  return null;
}

export function lineAt(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i += 1) if (text.charCodeAt(i) === 10) line += 1;
  return line;
}

/** The program's own copy of a located quote: the raw span with whitespace runs collapsed. */
export function copySpan(text: string, start: number, end: number): string {
  return text.slice(start, end).replace(/\s+/gu, ' ').trim();
}

/** Key used for stable ids: two quotes are "the same" when their keys are equal (spacing, case, emphasis ignored). */
export function quoteKey(quote: string): string {
  return quoteForms(quote).unwrapped.toLowerCase().replace(/[.;:!?,]+$/u, '').trim();
}

/** Resolves an RFC 6901 JSON pointer; `found: false` when any segment is missing. */
export function resolveJsonPointer(root: unknown, pointer: string): { found: boolean; value: unknown } {
  if (pointer === '') return { found: true, value: root };
  if (!pointer.startsWith('/')) return { found: false, value: undefined };
  let node: unknown = root;
  for (const raw of pointer.slice(1).split('/')) {
    const key = raw.replace(/~1/gu, '/').replace(/~0/gu, '~');
    if (Array.isArray(node)) {
      if (!/^\d+$/u.test(key) || Number(key) >= node.length) return { found: false, value: undefined };
      node = node[Number(key)];
    } else if (node && typeof node === 'object' && Object.prototype.hasOwnProperty.call(node, key)) {
      node = (node as Record<string, unknown>)[key];
    } else return { found: false, value: undefined };
  }
  return { found: true, value: node };
}

/** True when `quoteText` is the setting's value (as a string or as JSON), or one element of an array value. */
export function jsonValueMatches(value: unknown, quoteText: string): boolean {
  const want = quoteText.trim();
  const forms = (v: unknown): string[] => (typeof v === 'string' ? [v, JSON.stringify(v)] : [JSON.stringify(v)]);
  if (forms(value).includes(want)) return true;
  if (Array.isArray(value)) return value.some((v) => forms(v).includes(want));
  return false;
}

/** 1-based line of the last key of a JSON pointer in the raw JSON text (for `file:line` display), else undefined. */
export function jsonPointerLine(text: string, pointer: string): number | undefined {
  const segments = pointer.split('/').filter((s) => s.length > 0 && !/^\d+$/u.test(s));
  const key = segments[segments.length - 1];
  if (!key) return undefined;
  const at = text.indexOf(JSON.stringify(key.replace(/~1/gu, '/').replace(/~0/gu, '~')));
  return at < 0 ? undefined : lineAt(text, at);
}
