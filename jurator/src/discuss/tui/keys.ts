// Owner: DS-B. Raw terminal input to key events: control bytes, CSI/SS3 sequences, Alt (ESC prefix), the kitty /
// xterm "modifyOtherKeys" forms of Shift+Enter, and bracketed paste (which may arrive split over several chunks).

/** The keys /help lists (what this editor does). */
export const DISCUSS_KEYS: ReadonlyArray<{ readonly key: string; readonly does: string }> = [
  { key: 'Enter', does: 'Send (a line starting with / runs a command)' },
  { key: 'Alt+Enter, Shift+Enter, Ctrl-J', does: 'New line' },
  { key: 'Up / Down', does: 'Move between lines; at the edges, earlier questions' },
  { key: 'Tab', does: 'Complete a /command' },
  { key: 'Esc, Ctrl-C', does: 'Stop the running turn (the session stays)' },
  { key: 'Ctrl-C twice, Ctrl-D', does: 'Exit (on an empty line)' },
  { key: 'Ctrl-L', does: 'Clear the screen and print the conversation again' },
  { key: 'Ctrl-A/E, Alt-B/F, Ctrl-W/U/K', does: 'Move and delete as usual' },
];

export type KeyName =
  | 'enter'
  | 'newline'
  | 'tab'
  | 'backspace'
  | 'delete'
  | 'up'
  | 'down'
  | 'left'
  | 'right'
  | 'home'
  | 'end'
  | 'word-left'
  | 'word-right'
  | 'delete-word-back'
  | 'kill-line-start'
  | 'kill-line-end'
  | 'escape'
  | 'ctrl-c'
  | 'ctrl-d'
  | 'ctrl-l';

export type Key =
  | { readonly kind: 'key'; readonly name: KeyName }
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'paste'; readonly text: string };

const PASTE_START = '\u001b[200~';
const PASTE_END = '\u001b[201~';

const CSI_FINAL: Readonly<Record<string, KeyName>> = { A: 'up', B: 'down', C: 'right', D: 'left', H: 'home', F: 'end' };
const TILDE: Readonly<Record<string, KeyName>> = { '1': 'home', '7': 'home', '4': 'end', '8': 'end', '3': 'delete' };

const CONTROL: Readonly<Record<string, KeyName>> = {
  '\r': 'enter',
  '\n': 'newline',
  '\t': 'tab',
  '\u007f': 'backspace',
  '\b': 'backspace',
  '\u0003': 'ctrl-c',
  '\u0004': 'ctrl-d',
  '\u000c': 'ctrl-l',
  '\u0001': 'home',
  '\u0005': 'end',
  '\u0002': 'left',
  '\u0006': 'right',
  '\u0010': 'up',
  '\u000e': 'down',
  '\u0017': 'delete-word-back',
  '\u0015': 'kill-line-start',
  '\u000b': 'kill-line-end',
};

/**
 * A stateful decoder: feed it chunks as they arrive from stdin, get keys back. Text typed in one chunk comes back as
 * one `text` key; a bracketed paste comes back as one `paste` key even when it spans chunks.
 */
export class KeyDecoder {
  private paste: string | null = null;

  feed(chunk: string): Key[] {
    const out: Key[] = [];
    let s = chunk;
    while (s.length > 0) {
      if (this.paste !== null) {
        const end = s.indexOf(PASTE_END);
        if (end < 0) {
          this.paste += s;
          return out;
        }
        this.paste += s.slice(0, end);
        out.push({ kind: 'paste', text: this.paste.replace(/\r\n?/gu, '\n') });
        this.paste = null;
        s = s.slice(end + PASTE_END.length);
        continue;
      }
      if (s.startsWith(PASTE_START)) {
        this.paste = '';
        s = s.slice(PASTE_START.length);
        continue;
      }
      const [key, used] = decodeOne(s);
      if (key.kind === 'text') {
        const last = out[out.length - 1];
        if (last?.kind === 'text') out[out.length - 1] = { kind: 'text', text: last.text + key.text };
        else out.push(key);
      } else out.push(key);
      s = s.slice(used);
    }
    return out;
  }
}

/** One key from the start of `s` and how many UTF-16 units it used. */
function decodeOne(s: string): [Key, number] {
  const c = s[0] as string;
  if (c === '\u001b') return decodeEscape(s);
  const control = CONTROL[c];
  if (control) return [{ kind: 'key', name: control }, 1];
  const cp = s.codePointAt(0) ?? 0;
  const ch = String.fromCodePoint(cp);
  // Other control characters are dropped (shown as nothing).
  if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return [{ kind: 'text', text: '' }, ch.length];
  return [{ kind: 'text', text: ch }, ch.length];
}

function decodeEscape(s: string): [Key, number] {
  if (s.length === 1) return [{ kind: 'key', name: 'escape' }, 1];
  const n = s[1] as string;
  if (n === '[') {
    const m = /^\u001b\[([0-9;]*)([ -/]*)([@-~])/u.exec(s);
    if (!m) return [{ kind: 'key', name: 'escape' }, 1];
    const params = m[1] ?? '';
    const final = m[3] ?? '';
    const used = m[0].length;
    const parts = params.split(';');
    const mod = Number(parts[1] ?? '1');
    if (final === 'u') {
      // kitty: ESC[13;2u is Shift+Enter, ESC[13;3u Alt+Enter, ESC[13u plain Enter.
      if (parts[0] === '13') return [{ kind: 'key', name: mod > 1 ? 'newline' : 'enter' }, used];
      if (parts[0] === '9') return [{ kind: 'key', name: 'tab' }, used];
      if (parts[0] === '27') return [{ kind: 'key', name: 'escape' }, used];
      return [{ kind: 'text', text: '' }, used];
    }
    if (final === '~') {
      // xterm modifyOtherKeys: ESC[27;2;13~ is Shift+Enter.
      if (parts[0] === '27' && parts[2] === '13') return [{ kind: 'key', name: 'newline' }, used];
      const name = TILDE[parts[0] ?? ''];
      return [name ? { kind: 'key', name } : { kind: 'text', text: '' }, used];
    }
    const name = CSI_FINAL[final];
    if (name) {
      const ctrlOrAlt = mod === 3 || mod === 5 || mod === 9;
      if (ctrlOrAlt && name === 'left') return [{ kind: 'key', name: 'word-left' }, used];
      if (ctrlOrAlt && name === 'right') return [{ kind: 'key', name: 'word-right' }, used];
      return [{ kind: 'key', name }, used];
    }
    return [{ kind: 'text', text: '' }, used];
  }
  if (n === 'O' && s.length >= 3) {
    const name = CSI_FINAL[s[2] as string];
    return [name ? { kind: 'key', name } : { kind: 'text', text: '' }, 3];
  }
  // Alt + key.
  if (n === '\r' || n === '\n') return [{ kind: 'key', name: 'newline' }, 2];
  if (n === 'b' || n === 'B') return [{ kind: 'key', name: 'word-left' }, 2];
  if (n === 'f' || n === 'F') return [{ kind: 'key', name: 'word-right' }, 2];
  if (n === '\u007f' || n === '\b') return [{ kind: 'key', name: 'delete-word-back' }, 2];
  if (n === '\u001b') return [{ kind: 'key', name: 'escape' }, 1];
  return [{ kind: 'key', name: 'escape' }, 1];
}
