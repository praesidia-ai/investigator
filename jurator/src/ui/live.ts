// Owner: R4-UI. The live task view: steps with their state, a detail line under each running step, a progress bar
// with counts, elapsed time, the cost against the budget and an ETA. On a terminal it redraws in place (~10 fps, never
// taller than the screen) and collapses into a compact summary at the end. Elsewhere (CI, pipes, --json, NO_COLOR,
// JURATOR_PLAIN=1) it prints one plain line per event. JURATOR_NO_ANIMATION=1 keeps the lines without a spinner.
//
// While a live view runs, print through `live.log(line)` (it keeps the line above the redrawn area).
import { registerInterrupt } from './interrupt.js';
import { createUi, type Ui, type UiInput } from './components.js';
import type { UiStream } from './caps.js';
import { duration, money, padEnd, sanitize, truncate, width } from './text.js';

export type StepState = 'waiting' | 'running' | 'done' | 'failed' | 'skipped';
export type StepEvent = 'start' | 'done' | 'fail' | 'skip';

/**
 * The state machine: waiting -> running -> done | failed | skipped; a waiting step may also end directly (a cached
 * result is done at once, a step after the budget ran out is skipped). Ended steps never change again.
 * Returns null for an event the state ignores.
 */
export function nextState(state: StepState, event: StepEvent): StepState | null {
  if (state === 'done' || state === 'failed' || state === 'skipped') return null;
  switch (event) {
    case 'start':
      return 'running';
    case 'done':
      return 'done';
    case 'fail':
      return 'failed';
    case 'skip':
      return 'skipped';
  }
}

export interface StepView {
  readonly id: string;
  readonly label: string;
  readonly state: StepState;
  /** What a running step is doing now ("drafting promises for documents"). */
  readonly detail?: string | undefined;
  /** How a step ended ("rule written", the failure reason, why it was skipped). */
  readonly note?: string | undefined;
  readonly startedAt?: number | undefined;
  readonly endedAt?: number | undefined;
  /** Order the step was added in (the display order). */
  readonly index: number;
}

export interface LiveSnapshot {
  readonly title: string;
  readonly unit: string;
  readonly steps: readonly StepView[];
  readonly startedAt: number;
  readonly now: number;
  /** Finished items and the total (explicit progress, else ended steps over all steps). */
  readonly done: number;
  readonly total: number;
  readonly costUsd: number;
  readonly budgetUsd?: number | undefined;
  /** Milliseconds left: given with eta(), else estimated from the pace once something has finished. */
  readonly etaMs: number | null;
  readonly finished: boolean;
}

export interface LiveOptions extends UiInput {
  /** What is running, e.g. "rule propose" (the summary line starts with it). */
  readonly title: string;
  /** What the counts count: "rules" -> "7/19 rules" (default "steps"). */
  readonly unit?: string | undefined;
  /** Items to count when they are not the steps (e.g. promises when the steps are stages). */
  readonly total?: number | undefined;
  readonly budgetUsd?: number | undefined;
  /** Words for the summary counts, e.g. { done: 'written', failed: 'no rule possible' }. */
  readonly words?: Partial<Record<'done' | 'failed' | 'skipped', string>> | undefined;
  /** Where the view is drawn (default process.stderr, so stdout stays clean for results and --json). */
  readonly stream?: UiStream | undefined;
  /** Plain-mode line writer (default: stream.write(line + "\n")). */
  readonly write?: ((line: string) => void) | undefined;
  /** Clock in milliseconds (tests pass a fake). */
  readonly now?: (() => number) | undefined;
  /** Redraws per second on a terminal (default 10). */
  readonly fps?: number | undefined;
  /** A Ui to draw with (default: one made from the same stream, env and argv). */
  readonly ui?: Ui | undefined;
  /** false: no timer (tests drive redraws with render()). */
  readonly timer?: boolean | undefined;
}

export interface FinishOptions {
  /** The summary line after the counts (default: none). */
  readonly summary?: string | undefined;
  /** Whether the run as a whole went well (default: no step failed). */
  readonly ok?: boolean | undefined;
  /** Which steps stay listed under the summary (default 'failed'). */
  readonly keep?: 'failed' | 'all' | 'none' | undefined;
  /** R5-B: clear the live area and print nothing (the screen that follows carries the same facts in its header). */
  readonly quiet?: boolean | undefined;
}

export interface Live {
  /** Adds a waiting step (once per id; the order of adding is the display order). */
  add(id: string, label?: string): void;
  start(id: string, detail?: string): void;
  detail(id: string, text: string): void;
  done(id: string, note?: string): void;
  fail(id: string, reason?: string): void;
  skip(id: string, reason?: string): void;
  /** Sets the cost so far (cumulative, in USD). */
  cost(totalUsd: number): void;
  addCost(usd: number): void;
  /** Explicit progress counts (otherwise: ended steps over all steps). */
  progress(done: number, total?: number): void;
  /** A known time left in ms (null: estimate from the pace). */
  eta(ms: number | null): void;
  /** A permanent line above the live area (plain mode: printed as is). */
  log(line: string): void;
  /** Stops the view and prints the compact summary; returns the summary lines. */
  finish(options?: FinishOptions): string[];
  /** The current state (tests and renderers). */
  snapshot(): LiveSnapshot;
  /** Draws one frame now (terminal mode) and returns its lines; plain mode returns []. */
  render(): string[];
  readonly ui: Ui;
  readonly mode: 'live' | 'plain';
}

/* ----------------------------------- frame ----------------------------------- */

function etaOf(s: Omit<LiveSnapshot, 'etaMs'>, explicit: number | null | undefined): number | null {
  if (explicit !== undefined && explicit !== null) return Math.max(0, explicit);
  if (explicit === null) return null;
  const elapsed = s.now - s.startedAt;
  if (s.total <= 0 || s.done <= 0 || s.done >= s.total || elapsed < 3000) return null;
  return (elapsed / s.done) * (s.total - s.done);
}

function stepSymbol(ui: Ui, step: StepView, frame: number): string {
  const { theme, sym } = ui;
  switch (step.state) {
    case 'running':
      return theme.accent(ui.caps.animate ? (sym.spinner[frame % sym.spinner.length] as string) : sym.running);
    case 'done':
      return theme.kept(sym.done);
    case 'failed':
      return theme.broken(sym.failed);
    case 'skipped':
      return theme.muted(sym.skipped);
    default:
      return theme.faint(sym.waiting);
  }
}

function stepTime(s: LiveSnapshot, step: StepView): string {
  if (step.startedAt === undefined) return '';
  if (step.state === 'running') return duration(s.now - step.startedAt);
  if (step.endedAt !== undefined && step.state !== 'skipped') return duration(step.endedAt - step.startedAt);
  return '';
}

/** Widest live area: timings stay near the step they belong to on a wide terminal. */
export const LIVE_MAX = 96;

/** The money part of a footer: "$1.32 of $10.00", amber from 80% of the budget, red past it. */
function costText(ui: Ui, s: LiveSnapshot): string {
  if (s.budgetUsd === undefined) return s.costUsd > 0 ? money(s.costUsd) : '';
  const text = `${money(s.costUsd)} of ${money(s.budgetUsd)}`;
  if (s.costUsd >= s.budgetUsd) return ui.theme.broken(text);
  if (s.costUsd >= 0.8 * s.budgetUsd) return ui.theme.accent(text);
  return text;
}

/** The footer line: bar, counts, elapsed, cost, ETA (parts drop off from the right when the line is too wide). */
export function footerLine(ui: Ui, s: LiveSnapshot, cols: number): string {
  const wide = ui.theme.muted(`  ${ui.sym.dot}  `);
  const tight = ui.theme.muted(` ${ui.sym.dot} `);
  const counts = `${s.done}/${s.total} ${s.unit}`;
  const elapsed = duration(s.now - s.startedAt);
  const cost = costText(ui, s);
  const eta = s.etaMs !== null && !s.finished ? ui.theme.muted(`about ${duration(s.etaMs)} left`) : '';
  const frac = s.total > 0 ? s.done / s.total : 0;
  const all = [counts, elapsed, cost, eta];
  const tries: [number, string[], string][] = [
    [24, all, wide],
    [24, all, tight],
    [16, all, tight],
    [10, all, tight],
    [10, [counts, elapsed, cost], tight],
    [0, [counts, elapsed, cost], tight],
    [0, [counts, cost], tight],
    [0, [counts], tight],
  ];
  for (const [barW, parts, sep] of tries) {
    const text = parts.filter(Boolean).join(sep);
    const line = barW > 0 ? `  ${ui.bar(frac, barW)}  ${text}` : `  ${text}`;
    if (width(line) <= cols) return line;
  }
  return truncate(`  ${counts}`, cols, ui.sym.ellipsis);
}

/**
 * One frame of the live view: the visible steps (running first in priority, then the latest ended, then the next
 * waiting; hidden ones folded into count lines), a blank line and the footer. At most `rows` lines, each at most
 * `cols` columns.
 */
export function renderFrame(ui: Ui, s: LiveSnapshot, frame: number, cols: number, rows: number): string[] {
  const { theme, sym } = ui;
  const W = Math.max(20, Math.min(cols, LIVE_MAX));
  const room = Math.max(1, rows - 2); // footer and the blank line above it
  const steps = s.steps;
  const running = steps.filter((x) => x.state === 'running');
  const ended = steps.filter((x) => x.state === 'done' || x.state === 'failed' || x.state === 'skipped');
  const waiting = steps.filter((x) => x.state === 'waiting');
  const lineCount = (withDetail: boolean): number =>
    steps.length + (withDetail ? running.filter((x) => x.detail).length : 0);

  let visible: Set<StepView>;
  let details = true;
  let foldEnded = 0;
  let foldWaiting = 0;
  let foldRunning = 0;
  if (lineCount(true) <= room) visible = new Set(steps);
  else if (lineCount(false) <= room) {
    visible = new Set(steps);
    details = false;
  } else {
    // Priority: running (with details while they fit), then the latest ended (failures first), then next waiting.
    visible = new Set<StepView>();
    let budget = room - (ended.length > 0 ? 1 : 0) - (waiting.length > 0 ? 1 : 0);
    const runCost = running.length + running.filter((x) => x.detail).length;
    if (runCost <= budget) {
      for (const x of running) visible.add(x);
      budget -= runCost;
    } else {
      details = false;
      const fits = running.length <= budget ? running.length : Math.max(0, budget - 1);
      for (const x of running.slice(0, fits)) visible.add(x);
      foldRunning = running.length - fits;
      budget -= fits + (foldRunning > 0 ? 1 : 0);
    }
    const recent = [...ended].sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0) || b.index - a.index);
    const failures = recent.filter((x) => x.state === 'failed').slice(0, 2);
    const order = [...failures, ...recent.filter((x) => !failures.includes(x))];
    const keepWaiting = waiting.length > 0 ? 1 : 0;
    let endedShown = 0;
    for (const x of order) {
      if (endedShown >= 3 || budget - keepWaiting <= 0) break;
      visible.add(x);
      endedShown += 1;
      budget -= 1;
    }
    foldEnded = ended.length - endedShown;
    if (foldEnded === 0 && ended.length > 0) budget += 1;
    let waitShown = 0;
    for (const x of waiting) {
      if (budget <= 0) break;
      visible.add(x);
      waitShown += 1;
      budget -= 1;
    }
    foldWaiting = waiting.length - waitShown;
    // The line kept for "N more waiting" shows the step itself when only one is left.
    if (foldWaiting === 1) {
      const last = waiting[waiting.length - 1];
      if (last) visible.add(last);
      foldWaiting = 0;
    }
  }

  const shown = steps.filter((x) => visible.has(x));
  const labelW = Math.min(Math.max(8, ...shown.map((x) => width(x.label))), Math.floor(W * 0.4));
  const out: string[] = [];
  if (foldEnded > 0) {
    const hidden = ended.filter((x) => !visible.has(x));
    const n = (st: StepState): number => hidden.filter((x) => x.state === st).length;
    const parts = [
      n('done') ? theme.kept(`${sym.done} ${n('done')} done`) : '',
      n('failed') ? theme.broken(`${sym.failed} ${n('failed')} failed`) : '',
      n('skipped') ? theme.muted(`${sym.skipped} ${n('skipped')} skipped`) : '',
    ].filter(Boolean);
    out.push(truncate(`  ${parts.join('   ')}`, W, ui.sym.ellipsis));
  }
  for (const x of shown) {
    const time = stepTime(s, x);
    const label = padEnd(truncate(x.label, labelW, ui.sym.ellipsis), labelW);
    const head = `  ${stepSymbol(ui, x, frame)} ${x.state === 'running' ? theme.bold(label) : x.state === 'waiting' ? theme.muted(label) : label}`;
    const noteText = x.state === 'running' ? (details ? '' : x.detail ?? '') : x.note ?? '';
    const paintNote = x.state === 'failed' ? theme.broken : theme.muted;
    const timeW = time ? width(time) + 2 : 0;
    const noteRoom = W - width(head) - 2 - timeW;
    const note = noteText && noteRoom > 4 ? `  ${paintNote(truncate(noteText, noteRoom, ui.sym.ellipsis))}` : '';
    const gapN = W - width(head) - width(note) - timeW;
    const timePart = time ? `${' '.repeat(Math.max(2, gapN + 2))}${theme.muted(time)}` : '';
    out.push(truncate(`${head}${note}${timePart}`, W, ui.sym.ellipsis));
    if (x.state === 'running' && details && x.detail) out.push(truncate(`      ${theme.muted(x.detail)}`, W, ui.sym.ellipsis));
  }
  if (foldRunning > 0) out.push(truncate(`  ${theme.accent(sym.running)} ${foldRunning} more running`, W, ui.sym.ellipsis));
  if (foldWaiting > 0) out.push(truncate(`  ${theme.faint(sym.waiting)} ${theme.muted(`${foldWaiting} more waiting`)}`, W, ui.sym.ellipsis));
  out.push('', footerLine(ui, s, W));
  return out.slice(Math.max(0, out.length - rows));
}

/** The compact summary that replaces the live area when it finishes. */
export function summaryLines(ui: Ui, s: LiveSnapshot, words: LiveOptions['words'] = {}, options: FinishOptions = {}): string[] {
  const { theme, sym } = ui;
  const n = (st: StepState): number => s.steps.filter((x) => x.state === st).length;
  const failed = n('failed');
  const ok = options.ok ?? failed === 0;
  const sep = theme.muted(` ${sym.dot} `);
  const parts = [
    `${s.done}/${s.total} ${s.unit}`,
    n('done') ? theme.kept(`${n('done')} ${words.done ?? 'done'}`) : '',
    failed ? theme.broken(`${failed} ${words.failed ?? 'failed'}`) : '',
    n('skipped') ? theme.muted(`${n('skipped')} ${words.skipped ?? 'skipped'}`) : '',
    n('waiting') + n('running') ? theme.muted(`${n('waiting') + n('running')} not run`) : '',
    duration(s.now - s.startedAt),
    costText(ui, s),
  ].filter(Boolean);
  const mark = ok ? theme.kept(sym.done) : theme.broken(sym.failed);
  const head = `${mark} ${theme.bold(s.title)}  ${parts.join(sep)}`;
  const out = [head];
  if (options.summary) out.push(`  ${options.summary}`);
  const keep = options.keep ?? 'failed';
  if (keep !== 'none') {
    const list = s.steps.filter((x) => (keep === 'all' ? x.state !== 'waiting' : x.state === 'failed'));
    const labelW = Math.max(0, ...list.map((x) => width(x.label)));
    for (const x of list.slice(0, 8)) {
      const symb = x.state === 'failed' ? theme.broken(sym.failed) : x.state === 'done' ? theme.kept(sym.done) : theme.muted(sym.skipped);
      const note = x.note ? `  ${x.state === 'failed' ? theme.broken(x.note) : theme.muted(x.note)}` : '';
      out.push(`  ${symb} ${padEnd(x.label, labelW)}${note}`);
    }
    if (list.length > 8) out.push(theme.muted(`  ${sym.ellipsis} and ${list.length - 8} more`));
  }
  return out;
}

/* ----------------------------------- driver ----------------------------------- */

interface MutableStep {
  id: string;
  label: string;
  state: StepState;
  detail?: string | undefined;
  note?: string | undefined;
  startedAt?: number | undefined;
  endedAt?: number | undefined;
  index: number;
}

export function createLive(options: LiveOptions): Live {
  const stream: UiStream = options.stream ?? process.stderr;
  const ui = options.ui ?? createUi({ ...options, stream });
  const mode: 'live' | 'plain' = ui.caps.live ? 'live' : 'plain';
  const now = options.now ?? (() => Date.now());
  const write = options.write ?? ((line: string) => void stream.write(`${line}\n`));
  const clean = (s: string): string => sanitize(s, true);
  const title = clean(options.title);
  const unit = options.unit ?? 'steps';
  const startedAt = now();
  const steps = new Map<string, MutableStep>();
  let costUsd = 0;
  let explicit: { done: number; total: number | undefined } | null = null;
  let etaMs: number | null | undefined;
  let finished = false;
  let frame = 0;
  let drawn = 0;
  let dirty = true;
  let lastSecond = -1;
  let timer: ReturnType<typeof setInterval> | null = null;

  const snapshot = (): LiveSnapshot => {
    const list = [...steps.values()].sort((a, b) => a.index - b.index).map((x) => ({ ...x }));
    const ended = list.filter((x) => x.state === 'done' || x.state === 'failed' || x.state === 'skipped').length;
    const total = explicit?.total ?? options.total ?? list.length;
    const done = explicit ? explicit.done : ended;
    const base = {
      title,
      unit,
      steps: list,
      startedAt,
      now: now(),
      done,
      total,
      costUsd,
      budgetUsd: options.budgetUsd,
      finished,
    };
    return { ...base, etaMs: etaOf(base, etaMs) };
  };

  /* terminal drawing */
  const ESC = '\u001b[';
  const cols = (): number => Math.max(20, (stream.columns || ui.caps.width) - 1);
  const rows = (): number => Math.max(4, (stream.rows || ui.caps.height) - 1);
  const clearArea = (): string => (drawn > 0 ? `${ESC}${drawn}A\r${ESC}0J` : `\r${ESC}0J`);
  const restore = (): void => {
    stream.write(`${ESC}?25h`);
  };
  // R5-B: Ctrl-C goes to the process-wide handler (src/ui/interrupt.ts): it clears this view, shows the cursor, prints
  // what the run spent and exits 130.
  let unregister: (() => void) | null = null;
  const draw = (): string[] => {
    const lines = renderFrame(ui, snapshot(), frame, cols(), rows());
    stream.write(`${ESC}?2026h${clearArea()}${lines.map((l) => `${l}\n`).join('')}${ESC}?2026l`);
    drawn = lines.length;
    dirty = false;
    return lines;
  };
  if (mode === 'live') {
    stream.write(`${ESC}?25l`);
    process.once('exit', restore);
    unregister = registerInterrupt({
      cleanup: () => {
        if (timer) clearInterval(timer);
        timer = null;
        stream.write(`${clearArea()}${ESC}?25h`);
        drawn = 0;
      },
      costUsd: () => costUsd,
      showCursor: () => void stream.write(`${ESC}?25h`),
      hideCursor: () => void stream.write(`${ESC}?25l`),
    });
  } else {
    // Plain mode (CI, pipes): nothing to clear, but Ctrl-C still says what the run spent.
    unregister = registerInterrupt({ cleanup: () => undefined, costUsd: () => costUsd });
  }
  if (mode === 'live') {
    if (options.timer !== false) {
      const fps = Math.max(1, Math.min(30, options.fps ?? 10));
      timer = setInterval(() => {
        frame += 1;
        const sec = Math.floor((now() - startedAt) / 1000);
        const running = [...steps.values()].some((x) => x.state === 'running');
        if (dirty || (ui.caps.animate && running) || sec !== lastSecond) {
          lastSecond = sec;
          draw();
        }
      }, Math.round(1000 / fps));
      timer.unref?.();
    }
  }

  /* plain lines */
  const progressNote = (): string => {
    const s = snapshot();
    const parts = [`${s.done}/${s.total} ${unit}`];
    if (s.budgetUsd !== undefined || s.costUsd > 0) parts.push(costText(ui, s));
    return parts.join(` ${sym.dot} `);
  };
  const plain = (line: string): void => {
    if (mode === 'plain') write(line);
  };

  const touch = (): void => {
    dirty = true;
  };
  const ensure = (id: string, label?: string): MutableStep => {
    let step = steps.get(id);
    if (!step) {
      step = { id, label: clean(label ?? id), state: 'waiting', index: steps.size };
      steps.set(id, step);
    }
    return step;
  };
  const move = (id: string, event: StepEvent): MutableStep | null => {
    if (finished) return null;
    const step = ensure(id);
    const to = nextState(step.state, event);
    if (to === null) return null;
    const t = now();
    if (event === 'start') {
      if (step.state === 'running') return null;
      step.startedAt = t;
    } else {
      step.startedAt ??= t;
      step.endedAt = t;
    }
    step.state = to;
    touch();
    return step;
  };
  const { theme, sym } = ui;
  const took = (x: MutableStep): string =>
    x.startedAt !== undefined && x.endedAt !== undefined && x.endedAt > x.startedAt ? duration(x.endedAt - x.startedAt) : '';

  const live: Live = {
    ui,
    mode,
    add(id, label) {
      if (finished) return;
      const step = ensure(id, label);
      if (label !== undefined) step.label = clean(label);
      touch();
    },
    start(id, detail) {
      const step = move(id, 'start');
      if (!step) {
        if (detail !== undefined) live.detail(id, detail);
        return;
      }
      step.detail = detail === undefined ? undefined : clean(detail);
      plain(`${theme.accent(sym.running)} ${step.label}${step.detail ? `  ${theme.muted(step.detail)}` : ''}`);
    },
    detail(id, text) {
      const step = steps.get(id);
      if (!step || step.state !== 'running' || finished) return;
      const d = clean(text);
      if (d === step.detail) return;
      step.detail = d;
      touch();
      plain(`  ${theme.muted(`${step.label}: ${d}`)}`);
    },
    done(id, note) {
      const step = move(id, 'done');
      if (!step) return;
      step.note = note === undefined ? undefined : clean(note);
      step.detail = undefined;
      const t = took(step);
      plain(`${theme.kept(sym.done)} ${step.label}${step.note ? `  ${step.note}` : ''}  ${theme.muted(`(${[t, progressNote()].filter(Boolean).join(` ${sym.dot} `)})`)}`);
    },
    fail(id, reason) {
      const step = move(id, 'fail');
      if (!step) return;
      step.note = reason === undefined ? undefined : clean(reason);
      step.detail = undefined;
      const t = took(step);
      plain(`${theme.broken(sym.failed)} ${step.label}${step.note ? `  ${theme.broken(step.note)}` : ''}  ${theme.muted(`(${[t, progressNote()].filter(Boolean).join(` ${sym.dot} `)})`)}`);
    },
    skip(id, reason) {
      const step = move(id, 'skip');
      if (!step) return;
      step.note = reason === undefined ? undefined : clean(reason);
      step.detail = undefined;
      plain(`${theme.muted(sym.skipped)} ${step.label}  ${theme.muted(step.note ? `skipped: ${step.note}` : 'skipped')}`);
    },
    cost(totalUsd) {
      if (Number.isFinite(totalUsd) && totalUsd >= 0) costUsd = totalUsd;
      touch();
    },
    addCost(usd) {
      if (Number.isFinite(usd) && usd > 0) costUsd += usd;
      touch();
    },
    progress(done, total) {
      explicit = { done: Math.max(0, done), total: total ?? explicit?.total };
      touch();
    },
    eta(ms) {
      etaMs = ms;
      touch();
    },
    log(line) {
      const text = sanitize(line);
      if (mode === 'plain' || finished) {
        write(text);
        return;
      }
      stream.write(`${clearArea()}${text}\n`);
      drawn = 0;
      draw();
    },
    finish(opts = {}) {
      if (finished) return [];
      finished = true;
      if (timer) clearInterval(timer);
      timer = null;
      const lines = summaryLines(ui, snapshot(), options.words, opts);
      if (mode === 'live') {
        const shown = opts.quiet ? '' : lines.map((l) => `${truncate(l, cols(), ui.sym.ellipsis)}\n`).join('');
        stream.write(`${clearArea()}${shown}${ESC}?25h`);
        drawn = 0;
        process.removeListener('exit', restore);
      } else if (!opts.quiet) for (const l of lines) write(l);
      // The cost stays counted for a Ctrl-C after the view ends (the command may still be saving or printing).
      if (unregister) {
        unregister();
        const spent = costUsd;
        unregister = registerInterrupt({ cleanup: () => undefined, costUsd: () => spent });
      }
      return lines;
    },
    snapshot,
    render() {
      if (mode !== 'live' || finished) return [];
      frame += 1;
      return draw();
    },
  };
  return live;
}
