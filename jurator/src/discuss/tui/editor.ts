// Owner: DS-B. The input editor as a pure state machine: (state, key, context) -> (state, action). No terminal here;
// the app turns actions into sends, cancels and redraws, and `renderEditor` lays the state out for a width.
import { completeSlash, DISCUSS_LIMITS, isSlashLine } from '../contract.js';
import type { Key } from './keys.js';
import { charWidth } from '../../ui/text.js';

export interface PasteEntry {
  readonly marker: string;
  readonly text: string;
}

export interface EditorState {
  /** Logical lines (at least one). */
  readonly lines: readonly string[];
  readonly row: number;
  /** Cursor column in code points. */
  readonly col: number;
  /** Sent texts, oldest first. */
  readonly history: readonly string[];
  /** Index into history while browsing it (null: editing the draft). */
  readonly historyIndex: number | null;
  readonly draft: readonly string[] | null;
  /** Long pastes shown as markers, expanded on send. */
  readonly pastes: readonly PasteEntry[];
  readonly pasteCount: number;
  /** When an empty-editor Ctrl-C armed exit (ms), else null. */
  readonly exitArmedAt: number | null;
}

export type EditorAction =
  | { readonly type: 'none' }
  | { readonly type: 'submit'; readonly text: string }
  | { readonly type: 'cancel-turn' }
  | { readonly type: 'exit' }
  | { readonly type: 'redraw' }
  /** A short line for the status row (completion choices, "Esc to stop", "Ctrl-C again to exit"). */
  | { readonly type: 'hint'; readonly text: string };

export interface EditorContext {
  /** A turn is running. */
  readonly busy: boolean;
  /** Clock in ms (for the double Ctrl-C). */
  readonly now: number;
}

export interface EditorStep {
  readonly state: EditorState;
  readonly action: EditorAction;
}

const NONE: EditorAction = { type: 'none' };
const MARKER_AT_END = /\[paste #\d+ \+\d+ lines\]$/u;

export function emptyEditor(history: readonly string[] = []): EditorState {
  return { lines: [''], row: 0, col: 0, history, historyIndex: null, draft: null, pastes: [], pasteCount: 0, exitArmedAt: null };
}

const chars = (s: string): string[] => [...s];
const len = (s: string): number => chars(s).length;
const cut = (s: string, a: number, b?: number): string => chars(s).slice(a, b).join('');

/** The editor's text as typed (paste markers not expanded). */
export function editorText(state: EditorState): string {
  return state.lines.join('\n');
}

/** The text that is sent: every paste marker replaced by what was pasted. */
export function expandPastes(text: string, pastes: readonly PasteEntry[]): string {
  let out = text;
  for (const p of pastes) out = out.split(p.marker).join(p.text);
  return out;
}

function isEmpty(state: EditorState): boolean {
  return state.lines.length === 1 && state.lines[0] === '';
}

function withLines(state: EditorState, lines: string[], row: number, col: number): EditorState {
  return { ...state, lines, row, col, historyIndex: null, draft: null };
}

function insertText(state: EditorState, text: string): EditorState {
  const parts = text.replace(/\t/gu, '  ').split('\n');
  const line = state.lines[state.row] ?? '';
  const before = cut(line, 0, state.col);
  const after = cut(line, state.col);
  const lines = [...state.lines];
  if (parts.length === 1) {
    lines[state.row] = before + parts[0] + after;
    return withLines(state, lines, state.row, state.col + len(parts[0] ?? ''));
  }
  const last = parts[parts.length - 1] ?? '';
  const middle = parts.slice(1, -1);
  lines.splice(state.row, 1, before + (parts[0] ?? ''), ...middle, last + after);
  return withLines(state, lines, state.row + parts.length - 1, len(last));
}

function paste(state: EditorState, text: string): EditorState {
  const clean = text.replace(/\r\n?/gu, '\n');
  const count = clean.split('\n').length;
  if (count <= DISCUSS_LIMITS.pasteMarkerLines) return insertText(state, clean);
  const n = state.pasteCount + 1;
  const marker = `[paste #${n} +${count} lines]`;
  const next = insertText(state, marker);
  return { ...next, pastes: [...state.pastes, { marker, text: clean }], pasteCount: n };
}

function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && /[\p{L}\p{N}_]/u.test(ch);
}
function wordLeft(line: string, col: number): number {
  const c = chars(line);
  let i = col;
  while (i > 0 && !isWordChar(c[i - 1])) i -= 1;
  while (i > 0 && isWordChar(c[i - 1])) i -= 1;
  return i;
}
function wordRight(line: string, col: number): number {
  const c = chars(line);
  let i = col;
  while (i < c.length && !isWordChar(c[i])) i += 1;
  while (i < c.length && isWordChar(c[i])) i += 1;
  return i;
}

function loadHistory(state: EditorState, index: number, atTop: boolean): EditorState {
  const entry = state.history[index] ?? '';
  const lines = entry.split('\n');
  const row = atTop ? 0 : lines.length - 1;
  return { ...state, lines, row, col: len(lines[row] ?? ''), historyIndex: index, draft: state.draft ?? state.lines };
}

function commonPrefix(words: readonly string[]): string {
  if (words.length === 0) return '';
  let p = words[0] ?? '';
  for (const w of words) while (!w.startsWith(p)) p = p.slice(0, -1);
  return p;
}

function complete(state: EditorState): EditorStep {
  const line = state.lines[0] ?? '';
  if (state.lines.length !== 1 || !line.startsWith('/') || /\s/u.test(line) || state.col !== len(line)) {
    return { state, action: NONE };
  }
  const matches = completeSlash(line);
  if (matches.length === 0) return { state, action: { type: 'hint', text: `No command starts with ${line}. /help lists them.` } };
  if (matches.length === 1) {
    const m = matches[0] as (typeof matches)[number];
    const text = `/${m.name}${m.args ? ' ' : ''}`;
    return { state: withLines(state, [text], 0, len(text)), action: m.args ? { type: 'hint', text: `/${m.name} ${m.args} · ${m.summary}` } : NONE };
  }
  const prefix = `/${commonPrefix(matches.map((m) => m.name))}`;
  const next = prefix.length > line.length ? withLines(state, [prefix], 0, len(prefix)) : state;
  return { state: next, action: { type: 'hint', text: matches.map((m) => `/${m.name}`).join('  ') } };
}

/** One key. Pure: the same state, key and context always give the same step. */
export function editorKey(state0: EditorState, key: Key, ctx: EditorContext): EditorStep {
  // Any key but Ctrl-C disarms the exit confirmation.
  const state: EditorState =
    state0.exitArmedAt !== null && !(key.kind === 'key' && key.name === 'ctrl-c') ? { ...state0, exitArmedAt: null } : state0;
  if (key.kind === 'text') return { state: key.text ? insertText(state, key.text) : state, action: NONE };
  if (key.kind === 'paste') return { state: paste(state, key.text), action: NONE };
  const line = state.lines[state.row] ?? '';
  const lastRow = state.lines.length - 1;
  switch (key.name) {
    case 'enter': {
      if (ctx.busy) return { state, action: { type: 'hint', text: 'A turn is running. Esc to stop it; your text is kept.' } };
      const text = expandPastes(editorText(state), state.pastes);
      if (text.trim() === '') return { state, action: NONE };
      const history = state.history[state.history.length - 1] === text ? state.history : [...state.history, text];
      return { state: emptyEditor(history), action: { type: 'submit', text: isSlashLine(text) ? text.trim() : text } };
    }
    case 'newline':
      return { state: insertText(state, '\n'), action: NONE };
    case 'tab':
      return complete(state);
    case 'ctrl-c': {
      if (ctx.busy) return { state, action: { type: 'cancel-turn' } };
      if (!isEmpty(state)) return { state: { ...emptyEditor(state.history) }, action: NONE };
      if (state.exitArmedAt !== null && ctx.now - state.exitArmedAt <= DISCUSS_LIMITS.exitConfirmMs) {
        return { state: { ...state, exitArmedAt: null }, action: { type: 'exit' } };
      }
      return { state: { ...state, exitArmedAt: ctx.now }, action: { type: 'hint', text: 'Ctrl-C again to exit' } };
    }
    case 'ctrl-d':
      if (isEmpty(state)) return { state, action: { type: 'exit' } };
      return editorKey(state, { kind: 'key', name: 'delete' }, ctx);
    case 'escape':
      if (ctx.busy) return { state, action: { type: 'cancel-turn' } };
      return { state: emptyEditor(state.history), action: NONE };
    case 'ctrl-l':
      return { state, action: { type: 'redraw' } };
    case 'backspace': {
      if (state.col > 0) {
        const before = cut(line, 0, state.col);
        const m = MARKER_AT_END.exec(before);
        const n = m ? len(m[0]) : 1;
        const lines = [...state.lines];
        lines[state.row] = cut(line, 0, state.col - n) + cut(line, state.col);
        return { state: withLines(state, lines, state.row, state.col - n), action: NONE };
      }
      if (state.row === 0) return { state, action: NONE };
      const prev = state.lines[state.row - 1] ?? '';
      const lines = [...state.lines];
      lines.splice(state.row - 1, 2, prev + line);
      return { state: withLines(state, lines, state.row - 1, len(prev)), action: NONE };
    }
    case 'delete': {
      if (state.col < len(line)) {
        const lines = [...state.lines];
        lines[state.row] = cut(line, 0, state.col) + cut(line, state.col + 1);
        return { state: withLines(state, lines, state.row, state.col), action: NONE };
      }
      if (state.row === lastRow) return { state, action: NONE };
      const lines = [...state.lines];
      lines.splice(state.row, 2, line + (state.lines[state.row + 1] ?? ''));
      return { state: withLines(state, lines, state.row, state.col), action: NONE };
    }
    case 'left':
      if (state.col > 0) return { state: { ...state, col: state.col - 1 }, action: NONE };
      if (state.row > 0) return { state: { ...state, row: state.row - 1, col: len(state.lines[state.row - 1] ?? '') }, action: NONE };
      return { state, action: NONE };
    case 'right':
      if (state.col < len(line)) return { state: { ...state, col: state.col + 1 }, action: NONE };
      if (state.row < lastRow) return { state: { ...state, row: state.row + 1, col: 0 }, action: NONE };
      return { state, action: NONE };
    case 'home':
      return { state: { ...state, col: 0 }, action: NONE };
    case 'end':
      return { state: { ...state, col: len(line) }, action: NONE };
    case 'word-left':
      return { state: { ...state, col: wordLeft(line, state.col) }, action: NONE };
    case 'word-right':
      return { state: { ...state, col: wordRight(line, state.col) }, action: NONE };
    case 'delete-word-back': {
      if (state.col === 0) return editorKey(state, { kind: 'key', name: 'backspace' }, ctx);
      const to = wordLeft(line, state.col);
      const lines = [...state.lines];
      lines[state.row] = cut(line, 0, to) + cut(line, state.col);
      return { state: withLines(state, lines, state.row, to), action: NONE };
    }
    case 'kill-line-start': {
      const lines = [...state.lines];
      lines[state.row] = cut(line, state.col);
      return { state: withLines(state, lines, state.row, 0), action: NONE };
    }
    case 'kill-line-end': {
      const lines = [...state.lines];
      lines[state.row] = cut(line, 0, state.col);
      return { state: withLines(state, lines, state.row, state.col), action: NONE };
    }
    case 'up': {
      if (state.row > 0) {
        return { state: { ...state, row: state.row - 1, col: Math.min(state.col, len(state.lines[state.row - 1] ?? '')) }, action: NONE };
      }
      if (state.history.length === 0) return { state, action: NONE };
      const index = state.historyIndex === null ? state.history.length - 1 : Math.max(0, state.historyIndex - 1);
      return { state: loadHistory(state, index, true), action: NONE };
    }
    case 'down': {
      if (state.row < lastRow) {
        return { state: { ...state, row: state.row + 1, col: Math.min(state.col, len(state.lines[state.row + 1] ?? '')) }, action: NONE };
      }
      if (state.historyIndex === null) return { state, action: NONE };
      const index = state.historyIndex + 1;
      if (index >= state.history.length) {
        const lines = [...(state.draft ?? [''])];
        const row = lines.length - 1;
        return { state: { ...state, lines, row, col: len(lines[row] ?? ''), historyIndex: null, draft: null }, action: NONE };
      }
      return { state: loadHistory(state, index, false), action: NONE };
    }
  }
}

export interface EditorView {
  /** Visual lines without the prompt (the app adds it), at most `maxLines`. */
  readonly rows: readonly string[];
  /** Cursor position inside `rows`. */
  readonly cursorRow: number;
  readonly cursorCol: number;
  /** Visual lines above the window (scrolled out). */
  readonly hiddenAbove: number;
  readonly hiddenBelow: number;
}

/** Soft-wraps the lines at `width` columns (hard, by character), keeps the cursor row inside a window of maxLines. */
export function renderEditor(state: EditorState, width: number, maxLines: number = DISCUSS_LIMITS.maxEditorLines): EditorView {
  const w = Math.max(4, width);
  const rows: string[] = [];
  let cursorRow = 0;
  let cursorCol = 0;
  state.lines.forEach((line, i) => {
    const c = chars(line);
    let seg = '';
    let segW = 0;
    for (let k = 0; k <= c.length; k += 1) {
      if (i === state.row && k === state.col) {
        // A cursor after a full row starts the next one.
        if (segW >= w) {
          rows.push(seg);
          seg = '';
          segW = 0;
        }
        cursorRow = rows.length;
        cursorCol = segW;
      }
      if (k === c.length) break;
      const ch = c[k] as string;
      const cw = charWidth(ch);
      if (segW + cw > w) {
        rows.push(seg);
        seg = '';
        segW = 0;
      }
      seg += ch;
      segW += cw;
    }
    rows.push(seg);
  });
  const max = Math.max(1, maxLines);
  const start = rows.length <= max ? 0 : Math.min(Math.max(0, cursorRow - max + 1), rows.length - max);
  return {
    rows: rows.slice(start, start + max),
    cursorRow: cursorRow - start,
    cursorCol,
    hiddenAbove: start,
    hiddenBelow: Math.max(0, rows.length - start - max),
  };
}
