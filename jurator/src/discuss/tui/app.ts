// Owner: DS-B. The interactive `jurator discuss`: raw-mode stdin, the editor, the live region and the scrollback.
// Ctrl-C or Esc during a turn aborts it (AbortSignal) and keeps the session; Ctrl-C twice or Ctrl-D on an empty
// editor exits after `close()`. Zero dependencies: ANSI only, and the theme and symbols from src/ui.
import { BRAND } from '../../brand.js';
import { detectCaps } from '../../ui/caps.js';
import { ASCII, makeTheme, UNICODE } from '../../ui/theme.js';
import { truncate, width as textWidth } from '../../ui/text.js';
import { canRunActions, isSlashLine, type DiscussEvent, type DiscussSession, type SessionInfo } from '../contract.js';
import { editorKey, editorText, emptyEditor, renderEditor, type EditorState } from './editor.js';
import { KeyDecoder } from './keys.js';
import { Screen, type Frame } from './screen.js';
import { TurnModel } from './turn.js';
import { footerLines, headerLines, slashLines, statusLine, userLines, type Look } from './view.js';

export interface TuiInput {
  readonly isTTY?: boolean | undefined;
  setRawMode?(mode: boolean): unknown;
  setEncoding?(enc: BufferEncoding): unknown;
  on(event: 'data', fn: (chunk: string | Buffer) => void): unknown;
  off(event: 'data', fn: (chunk: string | Buffer) => void): unknown;
  resume?(): unknown;
  pause?(): unknown;
}
export interface TuiOutput {
  write(chunk: string): unknown;
  readonly isTTY?: boolean | undefined;
  readonly columns?: number | undefined;
  readonly rows?: number | undefined;
  on?(event: 'resize', fn: () => void): unknown;
  off?(event: 'resize', fn: () => void): unknown;
}
export interface TuiIo {
  readonly input: TuiInput;
  readonly output: TuiOutput;
  readonly env: NodeJS.ProcessEnv;
  /** Clock in ms (tests pass a fake). */
  readonly now?: (() => number) | undefined;
  /** DS-C: `jurator discuss "<goal>"`: sent as the first message once the header is drawn. */
  readonly goal?: string | undefined;
}

const PASTE_ON = '\u001b[?2004h';
const PASTE_OFF = '\u001b[?2004l';

/** Runs the chat until the user exits. Returns the exit code (0). */
export function runInteractive(session: DiscussSession, io: TuiIo): Promise<number> {
  const now = io.now ?? (() => Date.now());
  const caps = detectCaps({ stream: io.output, env: io.env });
  const theme = makeTheme(caps.color);
  const sym = caps.unicode ? UNICODE : ASCII;
  const animate = caps.animate;
  const size = (): { cols: number; rows: number } => ({ cols: Math.max(30, io.output.columns || 80), rows: Math.max(10, io.output.rows || 24) });
  const look = (): Look => ({ theme, sym, width: size().cols });
  const screen = new Screen(io.output, size().cols);
  const decoder = new KeyDecoder();
  const home = io.env.HOME;
  const snapshotOf = (info: SessionInfo): string => info.snapshot.commit;

  /** Everything committed so far, re-rendered at the current width by Ctrl-L. */
  const scrollback: Array<(l: Look) => string[]> = [];
  let editor: EditorState = emptyEditor();
  let hint: string | null = null;
  let running: { turn: TurnModel; abort: AbortController } | null = null;
  let exitAfterTurn = false;
  let spin = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  let drawTimer: ReturnType<typeof setTimeout> | null = null;
  let lastDraw = 0;
  let finished = false;
  let resolveDone: (code: number) => void = () => undefined;
  const done = new Promise<number>((r) => {
    resolveDone = r;
  });

  const frame = (): Frame => {
    const l = look();
    const { rows } = size();
    const info = session.info();
    const w = l.width - 1;
    const view = renderEditor(editor, w - 2);
    const rule = (label?: string): string => {
      if (!label) return theme.faint(sym.rule.repeat(w));
      const text = ` ${label} `;
      return theme.faint(`${sym.rule.repeat(2)}${text}${sym.rule.repeat(Math.max(0, w - 2 - textWidth(text)))}`);
    };
    const editorRows = view.rows.map((r, i) => `${i === 0 && view.hiddenAbove === 0 ? theme.accent('›') : ' '} ${r}`);
    const status: string[] = [];
    if (running) {
      const spinner = animate ? (sym.spinner[spin % sym.spinner.length] as string) : sym.running;
      status.push(statusLine({ spinner, elapsedMs: now() - running.turn.startedAt, doing: running.turn.doing() }, l));
    }
    if (hint) status.push(truncate(theme.muted(hint), w));
    const pending = !running ? (info.pendingAction ?? null) : null;
    if (pending && editorText(editor) === '') {
      status.push(truncate(`${theme.accent('?')} ${theme.bold(`Run ${pending.line}?`)} ${theme.muted(`Enter/y run ${sym.dot} n/Esc skip ${sym.dot} or type to ask about it`)}`, w));
    }
    const fixed = status.length + 2 + editorRows.length + 2;
    const turnLines = running ? running.turn.liveLines(l, animate ? (sym.spinner[spin % sym.spinner.length] as string) : sym.running, Math.max(1, rows - 2 - fixed)) : [];
    const lines = [
      ...turnLines,
      ...status,
      rule(view.hiddenAbove ? `+${view.hiddenAbove} lines above` : undefined),
      ...editorRows,
      rule(view.hiddenBelow ? `+${view.hiddenBelow} lines below` : undefined),
      ...footerLines(info, l, home),
    ];
    const editorTop = turnLines.length + status.length + 1;
    return { lines, cursor: { row: editorTop + view.cursorRow, col: 2 + view.cursorCol } };
  };

  const draw = (): void => {
    drawTimer = null;
    if (finished) return;
    lastDraw = now();
    screen.render(frame());
  };
  /** At most 30 frames a second. */
  const schedule = (): void => {
    if (drawTimer || finished) return;
    const wait = Math.max(0, 33 - (now() - lastDraw));
    drawTimer = setTimeout(draw, wait);
  };
  const commit = (block: (l: Look) => string[]): void => {
    scrollback.push(block);
    if (drawTimer) {
      clearTimeout(drawTimer);
      drawTimer = null;
    }
    screen.commit(block(look()), frame());
    lastDraw = now();
  };

  const startSpinner = (): void => {
    if (timer || !animate) return;
    timer = setInterval(() => {
      spin += 1;
      schedule();
    }, 80);
  };
  const stopSpinner = (): void => {
    if (timer) clearInterval(timer);
    timer = null;
  };

  const runTurn = async (text: string, confirmed = false): Promise<void> => {
    if (confirmed) commit((l) => [l.theme.muted(`  ${l.sym.done} you said yes`)]);
    else commit((l) => userLines(text, l));
    const turn = new TurnModel(text, now());
    const abort = new AbortController();
    running = { turn, abort };
    startSpinner();
    schedule();
    try {
      const events: AsyncIterable<DiscussEvent> = confirmed && canRunActions(session) ? session.confirm(abort.signal) : session.send(text, abort.signal);
      for await (const e of events) {
        turn.apply(e);
        schedule();
      }
    } catch (error) {
      turn.apply({ type: 'error', turn: turn.turn, code: 'MODEL_FAILED', message: error instanceof Error ? error.message : String(error) });
    } finally {
      stopSpinner();
      running = null;
      hint = null;
      const after = session.info();
      const snapshot = snapshotOf(after);
      const waiting = after.pendingAction?.id ?? null;
      commit((l) => turn.lines(l, snapshot, waiting));
      if (exitAfterTurn) void exit();
    }
  };

  const runSlash = async (line: string): Promise<void> => {
    commit((l) => userLines(line, l));
    let result: Awaited<ReturnType<DiscussSession['slash']>>;
    try {
      result = await session.slash(line);
    } catch (error) {
      result = { kind: 'error', code: 'BAD_INPUT', message: error instanceof Error ? error.message : String(error) };
    }
    if (result.kind === 'exit') {
      await exit();
      return;
    }
    commit((l) => [...slashLines(result, l), '']);
  };

  const onKey = (chunk: string | Buffer): void => {
    const keys = decoder.feed(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    for (const key of keys) {
      if (finished) return;
      // DS-C: an action card waits and the input is empty: Enter/y runs it, n/Esc skips it. Anything else types.
      const card = !running && editorText(editor) === '' && canRunActions(session) ? (session.info().pendingAction ?? null) : null;
      if (card) {
        const yes = (key.kind === 'key' && key.name === 'enter') || (key.kind === 'text' && /^[yY]$/u.test(key.text));
        const no = (key.kind === 'key' && key.name === 'escape') || (key.kind === 'text' && /^[nN]$/u.test(key.text));
        if (yes) {
          hint = null;
          void runTurn(card.line, true);
          continue;
        }
        if (no) {
          hint = null;
          void runSlash('/no');
          continue;
        }
      }
      const step = editorKey(editor, key, { busy: running !== null, now: now() });
      editor = step.state;
      const a = step.action;
      if (a.type !== 'hint' && !(key.kind === 'key' && key.name === 'ctrl-c' && !running)) hint = null;
      switch (a.type) {
        case 'submit':
          hint = null;
          if (/^\s*\/run\s*$/u.test(a.text) && canRunActions(session) && session.info().pendingAction) void runTurn(a.text, true);
          else if (isSlashLine(a.text)) void runSlash(a.text);
          else void runTurn(a.text);
          break;
        case 'cancel-turn':
          if (running && !running.abort.signal.aborted) {
            running.abort.abort();
            hint = 'Stopping…';
          }
          break;
        case 'exit':
          void exit();
          return;
        case 'redraw': {
          const l = look();
          screen.reprint(scrollback.flatMap((b) => b(l)), frame());
          lastDraw = now();
          break;
        }
        case 'hint':
          hint = a.text;
          break;
        case 'none':
          break;
      }
    }
    schedule();
  };

  const onResize = (): void => {
    if (finished) return;
    screen.resize(size().cols, frame());
    lastDraw = now();
  };

  const exit = async (): Promise<void> => {
    if (finished) return;
    if (running) {
      exitAfterTurn = true;
      running.abort.abort();
      return;
    }
    finished = true;
    stopSpinner();
    if (drawTimer) clearTimeout(drawTimer);
    io.input.off('data', onKey);
    io.output.off?.('resize', onResize);
    screen.clear();
    io.output.write(PASTE_OFF);
    try {
      io.input.setRawMode?.(false);
    } catch {
      /* the terminal may be gone */
    }
    io.input.pause?.();
    await session.close();
    const info = session.info();
    const lines = [
      theme.muted(info.transcriptPath ? `Transcript: ${info.transcriptPath}` : 'No transcript was saved (--no-save).'),
      `${theme.accent('Next:')} ${BRAND.command} check ${theme.muted('(re-check after a fix)')}`,
    ];
    io.output.write(`${lines.join('\n')}\n`);
    resolveDone(0);
  };

  // Start.
  try {
    io.input.setRawMode?.(true);
  } catch {
    /* not a terminal after all: keys still arrive */
  }
  io.input.setEncoding?.('utf8');
  io.input.on('data', onKey);
  io.input.resume?.();
  io.output.on?.('resize', onResize);
  io.output.write(PASTE_ON);
  commit((l) => [...headerLines(session.info(), l), '']);
  if (io.goal && io.goal.trim()) void runTurn(io.goal.trim());
  return done;
}
