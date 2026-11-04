import { describe, expect, it } from 'vitest';
import { DISCUSS_LIMITS } from '../../../src/discuss/contract.js';
import { editorKey, editorText, emptyEditor, renderEditor, type EditorState, type EditorAction } from '../../../src/discuss/tui/editor.js';
import { KeyDecoder, type Key } from '../../../src/discuss/tui/keys.js';

const idle = { busy: false, now: 1000 };
function keys(state: EditorState, input: string, ctx = idle): { state: EditorState; actions: EditorAction[] } {
  const d = new KeyDecoder();
  const actions: EditorAction[] = [];
  let s = state;
  for (const k of d.feed(input)) {
    const step = editorKey(s, k, ctx);
    s = step.state;
    actions.push(step.action);
  }
  return { state: s, actions };
}
const key = (name: Extract<Key, { kind: 'key' }>['name']): Key => ({ kind: 'key', name });

describe('key decoder', () => {
  it('decodes control keys, arrows, Alt and Shift+Enter forms', () => {
    const d = new KeyDecoder();
    expect(d.feed('ab\r')).toEqual([{ kind: 'text', text: 'ab' }, key('enter')]);
    expect(d.feed('\u001b\r\n\u001b[13;2u\u001b[27;2;13~')).toEqual([key('newline'), key('newline'), key('newline'), key('newline')]);
    expect(d.feed('\u001b[A\u001b[B\u001bOC\u001b[D\u001b[1;5D\u001bf\u001b[3~\u001b[H\u001b[F')).toEqual([
      key('up'),
      key('down'),
      key('right'),
      key('left'),
      key('word-left'),
      key('word-right'),
      key('delete'),
      key('home'),
      key('end'),
    ]);
    expect(d.feed('\u001b')).toEqual([key('escape')]);
    expect(d.feed('\u0003\u0004\u000c\t\u007f\u0017')).toEqual([key('ctrl-c'), key('ctrl-d'), key('ctrl-l'), key('tab'), key('backspace'), key('delete-word-back')]);
  });

  it('joins a bracketed paste that arrives in several chunks', () => {
    const d = new KeyDecoder();
    expect(d.feed('x\u001b[200~one\r\ntw')).toEqual([{ kind: 'text', text: 'x' }]);
    expect(d.feed('o\u001b[201~y')).toEqual([{ kind: 'paste', text: 'one\ntwo' }, { kind: 'text', text: 'y' }]);
  });
});

describe('editor state machine', () => {
  it('Enter sends and records history; empty Enter does nothing', () => {
    const a = keys(emptyEditor(), 'hello\r');
    expect(a.actions.at(-1)).toEqual({ type: 'submit', text: 'hello' });
    expect(editorText(a.state)).toBe('');
    expect(a.state.history).toEqual(['hello']);
    expect(keys(emptyEditor(), '   \r').actions.at(-1)).toEqual({ type: 'none' });
  });

  it('Alt+Enter, Shift+Enter and Ctrl-J add a line; Enter sends all lines', () => {
    const a = keys(emptyEditor(), 'one\u001b\rtwo\u001b[13;2uthree\nfour\r');
    expect(a.actions.at(-1)).toEqual({ type: 'submit', text: 'one\ntwo\nthree\nfour' });
  });

  it('Enter while a turn runs keeps the text and says how to stop', () => {
    const a = keys(emptyEditor(), 'next question\r', { busy: true, now: 0 });
    expect(editorText(a.state)).toBe('next question');
    expect(a.actions.at(-1)).toMatchObject({ type: 'hint', text: expect.stringContaining('Esc') });
  });

  it('Up and Down move between lines, then through history at the edges, and restore the draft', () => {
    let s = emptyEditor(['first', 'second']);
    s = keys(s, 'dra').state;
    s = editorKey(s, key('up'), idle).state;
    expect(editorText(s)).toBe('second');
    s = editorKey(s, key('up'), idle).state;
    expect(editorText(s)).toBe('first');
    s = editorKey(s, key('up'), idle).state;
    expect(editorText(s)).toBe('first');
    s = editorKey(s, key('down'), idle).state;
    s = editorKey(s, key('down'), idle).state;
    expect(editorText(s)).toBe('dra');
    // Inside a multi-line text Up moves a line, not through history.
    let m = keys(emptyEditor(['old']), 'a\nb').state;
    m = editorKey(m, key('up'), idle).state;
    expect([m.row, editorText(m)]).toEqual([0, 'a\nb']);
  });

  it('Ctrl-C: cancels a running turn, clears text, then arms exit and exits on a second press in time', () => {
    expect(editorKey(emptyEditor(), key('ctrl-c'), { busy: true, now: 0 }).action).toEqual({ type: 'cancel-turn' });
    const typed = keys(emptyEditor(), 'abc').state;
    const cleared = editorKey(typed, key('ctrl-c'), idle);
    expect(editorText(cleared.state)).toBe('');
    const armed = editorKey(cleared.state, key('ctrl-c'), { busy: false, now: 5000 });
    expect(armed.action).toEqual({ type: 'hint', text: 'Ctrl-C again to exit' });
    expect(editorKey(armed.state, key('ctrl-c'), { busy: false, now: 5000 + DISCUSS_LIMITS.exitConfirmMs }).action).toEqual({ type: 'exit' });
    // Too late: arms again instead of exiting.
    expect(editorKey(armed.state, key('ctrl-c'), { busy: false, now: 5001 + DISCUSS_LIMITS.exitConfirmMs }).action.type).toBe('hint');
    // Another key in between disarms it.
    const typedAfter = editorKey(armed.state, { kind: 'text', text: 'x' }, idle).state;
    expect(typedAfter.exitArmedAt).toBeNull();
  });

  it('Ctrl-D exits only when empty, Esc cancels or clears, Ctrl-L redraws', () => {
    expect(editorKey(emptyEditor(), key('ctrl-d'), idle).action).toEqual({ type: 'exit' });
    const s = keys(emptyEditor(), 'ab\u001b[D').state;
    expect(editorText(editorKey(s, key('ctrl-d'), idle).state)).toBe('a');
    expect(editorKey(s, key('escape'), { busy: true, now: 0 }).action).toEqual({ type: 'cancel-turn' });
    expect(editorText(editorKey(s, key('escape'), idle).state)).toBe('');
    expect(editorKey(s, key('ctrl-l'), idle).action).toEqual({ type: 'redraw' });
  });

  it('moves and deletes by word and line (Ctrl-A/E, Alt-B/F, Ctrl-W/U/K)', () => {
    let s = keys(emptyEditor(), 'show the code').state;
    s = editorKey(s, key('delete-word-back'), idle).state;
    expect(editorText(s)).toBe('show the ');
    s = editorKey(s, key('word-left'), idle).state;
    expect(s.col).toBe(5);
    s = editorKey(s, key('kill-line-end'), idle).state;
    expect(editorText(s)).toBe('show ');
    s = editorKey(s, key('home'), idle).state;
    s = keys(s, 'please ').state;
    expect(editorText(s)).toBe('please show ');
    s = editorKey(s, key('kill-line-start'), idle).state;
    expect(editorText(s)).toBe('show ');
    s = editorKey(s, key('end'), idle).state;
    expect(s.col).toBe(5);
  });

  it('a paste over the marker limit shows as one marker, deleted as a whole, expanded on send', () => {
    const big = Array.from({ length: DISCUSS_LIMITS.pasteMarkerLines + 2 }, (_, i) => `l${i}`).join('\n');
    let s = keys(emptyEditor(), `see \u001b[200~${big}\u001b[201~`).state;
    expect(editorText(s)).toBe(`see [paste #1 +${DISCUSS_LIMITS.pasteMarkerLines + 2} lines]`);
    const sent = editorKey(s, key('enter'), idle).action;
    expect(sent).toEqual({ type: 'submit', text: `see ${big}` });
    s = editorKey(s, key('backspace'), idle).state;
    expect(editorText(s)).toBe('see ');
    // A short paste goes in as lines.
    const small = keys(emptyEditor(), '\u001b[200~a\nb\u001b[201~').state;
    expect(small.lines).toEqual(['a', 'b']);
  });
});

describe('slash completion with Tab', () => {
  it('one match completes (with a space when the command takes arguments)', () => {
    const a = keys(emptyEditor(), '/he\t');
    expect(editorText(a.state)).toBe('/help');
    const b = keys(emptyEditor(), '/ex\t');
    expect(editorText(b.state)).toBe('/ex');
    expect(b.actions.at(-1)).toEqual({ type: 'hint', text: '/explain  /exit' });
    const c = keys(emptyEditor(), '/expl\t');
    expect(editorText(c.state)).toBe('/explain ');
    expect(c.actions.at(-1)).toMatchObject({ type: 'hint', text: expect.stringContaining('<promise id>') });
  });

  it('several matches extend to the common prefix; none says so; plain text is left alone', () => {
    const a = keys(emptyEditor(), '/p\t');
    expect(editorText(a.state)).toBe('/promises');
    const b = keys(emptyEditor(), '/c\t');
    expect(editorText(b.state)).toBe('/c');
    expect(b.actions.at(-1)).toEqual({ type: 'hint', text: '/cost  /clear' });
    const c = keys(emptyEditor(), '/zz\t');
    expect(c.actions.at(-1)).toMatchObject({ type: 'hint', text: expect.stringContaining('No command') });
    const d = keys(emptyEditor(), 'hello\t');
    expect(d.actions.at(-1)).toEqual({ type: 'none' });
  });
});

describe('editor layout', () => {
  it('wraps long lines, keeps the cursor inside, and scrolls past the line limit', () => {
    const s = keys(emptyEditor(), 'abcdefghij').state;
    const v = renderEditor(s, 4);
    expect(v.rows).toEqual(['abcd', 'efgh', 'ij']);
    expect([v.cursorRow, v.cursorCol]).toEqual([2, 2]);
    const full = keys(emptyEditor(), 'abcd').state;
    expect(renderEditor(full, 4)).toMatchObject({ rows: ['abcd', ''], cursorRow: 1, cursorCol: 0 });
    const many = keys(emptyEditor(), Array.from({ length: 12 }, (_, i) => `r${i}`).join('\n')).state;
    const mv = renderEditor(many, 20, 8);
    expect(mv.rows).toHaveLength(8);
    expect(mv.rows.at(-1)).toBe('r11');
    expect([mv.hiddenAbove, mv.cursorRow]).toEqual([4, 7]);
  });
});
