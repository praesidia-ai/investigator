// Owner: R4-UI. The building blocks every screen is made of. Each returns lines (no trailing newline), never wider
// than the layout width, and with no escape code at all when colour is off. Text from repositories or models is
// cleaned (sanitize) before it is laid out.
import { BRAND } from '../brand.js';
import { detectCaps, type Caps, type CapsInput, type UiStream } from './caps.js';
import { sanitize, fit, money, padEnd, truncate, width, wrap } from './text.js';
import { ASCII, makeTheme, UNICODE, type Symbols, type Theme } from './theme.js';

/** Widest layout, so a 200-column terminal still gets lines a reader can follow. */
export const MAX_LAYOUT = 120;
/** Widest boxed finding (today's box was 96). */
export const BOX_MAX = 96;

/** Every result word a screen can show. Filled badge = proved by a rule (no AI); coloured word = an AI read. */
export type BadgeKind = 'holds' | 'broken' | 'broken-now' | 'looks-kept' | 'looks-broken' | 'cant-tell' | 'not-checked';

export const BADGE_WORDS: Readonly<Record<BadgeKind, string>> = {
  holds: 'HOLDS',
  broken: 'BROKEN',
  'broken-now': 'BROKEN NOW',
  'looks-kept': 'LOOKS KEPT',
  'looks-broken': 'LOOKS BROKEN',
  'cant-tell': "CAN'T TELL",
  'not-checked': 'NOT CHECKED',
};
const BADGE_SOURCE: Readonly<Record<BadgeKind, string>> = {
  holds: 'rule, no AI',
  broken: 'rule, no AI',
  'broken-now': 'rule, no AI',
  'looks-kept': 'read by AI',
  'looks-broken': 'read by AI',
  'cant-tell': 'read by AI',
  'not-checked': '',
};

export type Tone = 'plain' | 'muted' | 'strong' | 'accent' | 'kept' | 'broken' | 'code';

export interface HeaderInput {
  /** The command, e.g. "rule propose". */
  readonly command: string;
  /** "investigator workspace · 2 repos", or a repo name. */
  readonly workspace?: string | undefined;
  /** "muse-wonder (live)". */
  readonly model?: string | undefined;
  readonly budgetUsd?: number | undefined;
  /** More "label value" facts, shown after the others. */
  readonly facts?: readonly (readonly [string, string])[] | undefined;
}

export interface FindingRow {
  /** Left column (Promise, Policy, Code, Actual...); empty continues the row above. */
  readonly label?: string | undefined;
  readonly text: string;
  readonly tone?: Tone | undefined;
  /** A location shown on the right of the same line when it fits (e.g. docs/privacy.md:12). */
  readonly where?: string | undefined;
  /** A code line number, shown in a gutter before a code row. */
  readonly lineNo?: number | undefined;
  /** At most this many lines (default 3; code rows are always one line). */
  readonly maxLines?: number | undefined;
  /** HZ-1: the whole inner width, no label column (the plain summary at the top of a box). */
  readonly full?: boolean | undefined;
}
export interface FindingInput {
  readonly kind: BadgeKind;
  /** The promise id, e.g. "privacy.02". */
  readonly id: string;
  /** Right side of the top border, e.g. "proved by a rule, no AI". */
  readonly title?: string | undefined;
  readonly rows: readonly FindingRow[];
}

export interface Column {
  readonly header: string;
  readonly align?: 'left' | 'right' | undefined;
  /** Never narrower than this (default: the header, at most 12). */
  readonly min?: number | undefined;
  /** Never wider than this. */
  readonly max?: number | undefined;
  /** Gives up width first when the table is too wide (descriptions, reasons). */
  readonly flex?: boolean | undefined;
}
export interface TableInput {
  readonly columns: readonly Column[];
  readonly rows: readonly (readonly string[])[];
  /** Spaces before each line (default 2). */
  readonly indent?: number | undefined;
  /** Spaces between columns (default 2). */
  readonly gap?: number | undefined;
  /** false leaves out the header and its rule. */
  readonly header?: boolean | undefined;
  /** HZ-1: the last column folds onto at most this many lines instead of being cut (default 1). */
  readonly wrap?: number | undefined;
  /** HZ-1: a muted line (or two) under each row, from column `noteFrom` (default the last column). */
  readonly notes?: readonly (string | undefined)[] | undefined;
  readonly noteFrom?: number | undefined;
  /** Lines a note may fold onto (default 2). */
  readonly noteLines?: number | undefined;
}

export interface Card {
  readonly value: string;
  readonly label: string;
  readonly sub?: string | undefined;
  readonly tone?: Tone | undefined;
}

export interface VerboseLine {
  readonly label?: string | undefined;
  readonly text: string;
}

export interface Ui {
  readonly caps: Caps;
  readonly theme: Theme;
  readonly sym: Symbols;
  /** Layout width: the terminal's, at most MAX_LAYOUT. */
  readonly width: number;
  /** Colours a piece of text by tone. */
  tone(text: string, tone?: Tone): string;
  /** One line, cleaned and cut to the layout width. */
  line(text: string, tone?: Tone): string;
  header(h: HeaderInput): string[];
  section(title: string, right?: string): string[];
  badge(kind: BadgeKind, options?: { readonly long?: boolean }): string;
  finding(f: FindingInput): string[];
  /** HZ-1: the rows of a finding box with no box around them. */
  rows(rows: readonly FindingRow[]): string[];
  table(t: TableInput): string[];
  cards(cards: readonly Card[]): string[];
  next(hint: string | readonly string[]): string[];
  /** Detail for --verbose (proofs, long patterns): nothing unless verbose is on (or `force`). */
  verbose(title: string, lines: readonly (string | VerboseLine)[], options?: { readonly force?: boolean }): string[];
  /** A muted line saying where the hidden detail is ("Proofs: --verbose"). */
  hint(text: string): string[];
  /** A progress bar of `cols` columns. */
  bar(fraction: number, cols: number): string;
}

export interface UiInput extends CapsInput {
  /** Overrides for what detection decided (tests, the preview). */
  readonly caps?: Partial<Caps> | undefined;
}

export function createUi(input: UiInput = {}): Ui {
  const caps: Caps = { ...detectCaps(input), ...input.caps };
  const theme = makeTheme(caps.color);
  const sym = caps.unicode ? UNICODE : ASCII;
  const W = Math.max(40, Math.min(caps.width, MAX_LAYOUT));
  const clean = (s: string): string => sanitize(s, true);
  const cut = (s: string, w: number): string => truncate(s, w, sym.ellipsis);

  const tone = (text: string, t: Tone = 'plain'): string => {
    switch (t) {
      case 'muted':
        return theme.muted(text);
      case 'strong':
        return theme.bold(text);
      case 'accent':
        return theme.accent(text);
      case 'kept':
        return theme.kept(text);
      case 'broken':
        return theme.broken(text);
      case 'code':
        return theme.bold(text);
      default:
        return text;
    }
  };

  const badge = (kind: BadgeKind, options: { readonly long?: boolean } = {}): string => {
    const word = BADGE_WORDS[kind];
    const mark =
      kind === 'holds'
        ? sym.done
        : kind === 'broken' || kind === 'broken-now'
          ? sym.failed
          : kind === 'looks-kept'
            ? '~'
            : kind === 'not-checked'
              ? sym.dot
              : '?';
    let core: string;
    if (theme.depth === 'none') core = `${mark} ${word}`;
    else if (kind === 'holds') core = theme.chip.kept(` ${mark} ${word} `);
    else if (kind === 'broken' || kind === 'broken-now') core = theme.chip.broken(` ${mark} ${word} `);
    else if (kind === 'looks-kept') core = theme.kept(`${mark} ${word}`);
    else if (kind === 'looks-broken') core = theme.broken(`${mark} ${word}`);
    else core = theme.muted(`${mark} ${word}`);
    const source = BADGE_SOURCE[kind];
    return options.long && source ? `${core} ${theme.muted(`(${source})`)}` : core;
  };

  const header = (h: HeaderInput): string[] => {
    const mark = theme.depth === 'none' ? `${sym.mark} ${BRAND.name}` : theme.chip.accent(` ${sym.mark} ${BRAND.name} `);
    const sep = theme.depth === 'none' ? ` ${sym.dot} ` : '  ';
    const top = cut(`${mark}${sep}${theme.bold(clean(h.command))}`, W);
    const facts: [string, string][] = [];
    if (h.workspace) facts.push(['', clean(h.workspace)]);
    if (h.model) facts.push(['model', clean(h.model)]);
    if (h.budgetUsd !== undefined) facts.push(['budget', money(h.budgetUsd)]);
    for (const [k, v] of h.facts ?? []) facts.push([clean(k), clean(v)]);
    if (facts.length === 0) return [top];
    const parts = facts.map(([k, v]) => (k ? `${theme.muted(k)} ${v}` : v));
    const indent = theme.depth === 'none' ? '  ' : '   ';
    const lines: string[] = [];
    let cur = '';
    for (const p of parts) {
      const cand = cur ? `${cur}${theme.muted(` ${sym.dot} `)}${p}` : p;
      if (cur && width(indent + cand) > W) {
        lines.push(indent + cur);
        cur = cut(p, W - indent.length);
      } else cur = cut(cand, W - indent.length);
    }
    if (cur) lines.push(indent + cur);
    return [top, ...lines];
  };

  const section = (title: string, right?: string): string[] => {
    const lead = `${sym.rule}${sym.rule} `;
    const t = clean(title);
    const target = Math.min(W, 100);
    let r = right ? ` ${clean(right)} ` : '';
    if (r && width(lead) + width(t) + width(r) + 5 > target) r = '';
    const fill = Math.max(2, target - width(lead) - width(t) - 1 - (r ? width(r) + 2 : 0));
    const line = `${theme.faint(lead)}${theme.bold(theme.accent(t))} ${theme.faint(sym.rule.repeat(fill))}${r ? theme.muted(r) + theme.faint(sym.rule.repeat(2)) : ''}`;
    return ['', cut(line, W)];
  };

  /** Label + text rows laid out in `inner` columns (each line exactly that wide): the body of a box, or bare rows. */
  const rowLines = (rows: readonly FindingRow[], inner: number): string[] => {
    const out: string[] = [];
    const labelW = Math.max(0, ...rows.map((r) => width(clean(r.label ?? '')))) + 2;
    const textW = Math.max(8, inner - labelW);
    const push = (label: string, body: string): void => {
      out.push(padEnd(cut(`${theme.muted(padEnd(label, labelW))}${body}`, inner), inner));
    };
    for (const row of rows) {
      const label = clean(row.label ?? '');
      const t = row.tone ?? 'plain';
      if (row.full) {
        for (const l of wrap(clean(row.text), inner, row.maxLines ?? 3, sym.ellipsis)) out.push(padEnd(cut(tone(l, t), inner), inner));
        continue;
      }
      if (t === 'code') {
        const gutter = row.lineNo !== undefined ? `${String(row.lineNo)} ${sym.gutter} ` : '';
        const code = clean(row.text).trim();
        push(label, `${theme.muted(gutter)}${tone(cut(code, textW - width(gutter)), 'code')}`);
        continue;
      }
      const where = row.where ? clean(row.where) : '';
      const text = clean(row.text);
      if (where && width(text) + 2 + width(where) <= textW) {
        push(label, `${tone(text, t)}${' '.repeat(textW - width(text) - width(where))}${theme.muted(where)}`);
        continue;
      }
      const lines = wrap(text, textW, row.maxLines ?? 3, sym.ellipsis);
      lines.forEach((l, i) => push(i === 0 ? label : '', tone(l, t)));
      if (where) push('', theme.muted(cut(where, textW)));
    }
    return out;
  };

  /** HZ-1: label + text rows with no box (details screens such as explain), indented by 2. */
  const rowsOf = (rows: readonly FindingRow[]): string[] => rowLines(rows, Math.min(W, BOX_MAX) - 2).map((l) => `  ${l}`.replace(/ +$/u, ''));

  const finding = (f: FindingInput): string[] => {
    const boxW = Math.min(W, BOX_MAX);
    const b = sym.heavy;
    const isBroken = f.kind === 'broken' || f.kind === 'broken-now' || f.kind === 'looks-broken';
    const border = (s: string): string => (isBroken ? theme.broken(s) : theme.muted(s));
    const inner = boxW - 4; // "┃ " + content + " ┃"
    // Top border: ┏━ BADGE ━ id ━━━━━━━━ title ━┓
    const chip = badge(f.kind);
    const id = theme.bold(clean(f.id));
    const right = f.title ? clean(f.title) : '';
    const headFixed = width(chip) + width(clean(f.id)) + 7; // '┏━ ' chip ' ━ ' id ' '
    let titleText = right ? ` ${right} ` : '';
    if (headFixed + width(titleText) + 3 > boxW) titleText = '';
    const fillN = Math.max(1, boxW - headFixed - width(titleText) - 2);
    const top = `${border(`${b.tl}${b.h}`)} ${chip} ${border(b.h)} ${id} ${border(b.h.repeat(fillN))}${titleText ? theme.muted(titleText) : ''}${border(`${b.h}${b.tr}`)}`;
    const out: string[] = [cut(top, boxW)];
    for (const content of rowLines(f.rows, inner)) out.push(`${border(b.v)} ${content} ${border(b.v)}`);
    out.push(border(`${b.bl}${b.h.repeat(boxW - 2)}${b.br}`));
    return out;
  };

  const table = (t: TableInput): string[] => {
    const indent = t.indent ?? 2;
    const gap = t.gap ?? 2;
    const cols = t.columns;
    const rows = t.rows.map((r) => cols.map((_, i) => sanitize(r[i] ?? '', true)));
    const natural = cols.map((c, i) => {
      const w = Math.max(t.header === false ? 0 : width(c.header), ...rows.map((r) => width(r[i] ?? '')));
      return c.max !== undefined ? Math.min(w, c.max) : w;
    });
    const mins = cols.map((c, i) => Math.min(natural[i] ?? 0, c.min ?? Math.min(12, Math.max(width(c.header), 4))));
    const widths = [...natural];
    const total = (): number => indent + widths.reduce((a, b) => a + b, 0) + gap * Math.max(0, cols.length - 1);
    // Shrink flex columns first (widest first), then the others, down to their minimums.
    for (const pass of [true, false]) {
      while (total() > W) {
        let pick = -1;
        for (let i = 0; i < cols.length; i += 1) {
          if (Boolean(cols[i]?.flex) !== pass) continue;
          if ((widths[i] ?? 0) <= (mins[i] ?? 0)) continue;
          if (pick < 0 || (widths[i] ?? 0) > (widths[pick] ?? 0)) pick = i;
        }
        if (pick < 0) break;
        widths[pick] = (widths[pick] ?? 0) - 1;
      }
    }
    const pad = ' '.repeat(indent);
    const render = (cells: readonly string[], paint?: (s: string) => string): string => {
      const parts = cells.map((c, i) => {
        const w = widths[i] ?? 0;
        const last = i === cells.length - 1;
        const cell = fit(c, w, cols[i]?.align ?? 'left', sym.ellipsis);
        const shown = paint ? paint(cell) : cell;
        return last && cols[i]?.align !== 'right' ? shown.replace(/ +$/u, '') : shown;
      });
      return cut(`${pad}${parts.join(' '.repeat(gap))}`.replace(/ +$/u, ''), W);
    };
    const out: string[] = [];
    if (t.header !== false) {
      out.push(render(cols.map((c) => c.header), theme.muted));
      out.push(cut(`${pad}${theme.faint(sym.rule.repeat(Math.max(1, total() - indent)))}`, W));
    }
    const offset = (col: number): number => indent + widths.slice(0, col).reduce((a, b) => a + b, 0) + gap * col;
    const last = cols.length - 1;
    const folds = Math.max(1, t.wrap ?? 1);
    const noteCol = Math.max(0, Math.min(last, t.noteFrom ?? last));
    rows.forEach((r, i) => {
      const lastW = widths[last] ?? 0;
      const cell = r[last] ?? '';
      if (folds > 1 && last >= 0 && width(cell) > lastW && lastW >= 8) {
        const lines = wrap(cell, lastW, folds, sym.ellipsis);
        out.push(render([...r.slice(0, last), lines[0] ?? '']));
        for (const l of lines.slice(1)) out.push(cut(`${' '.repeat(offset(last))}${l}`.replace(/ +$/u, ''), W));
      } else out.push(render(r));
      const note = t.notes?.[i];
      if (note) {
        const at = offset(noteCol);
        for (const l of wrap(sanitize(note, true), Math.max(10, W - at), Math.max(1, t.noteLines ?? 2), sym.ellipsis)) out.push(cut(`${' '.repeat(at)}${theme.muted(l)}`, W));
      }
    });
    return out;
  };

  const cards = (list: readonly Card[]): string[] => {
    if (list.length === 0) return [];
    const r = sym.round;
    const gap = 1;
    const want = Math.max(14, ...list.map((c) => Math.max(width(clean(c.value)), width(clean(c.label)), width(clean(c.sub ?? ''))) + 4));
    const perRow = Math.max(1, Math.min(list.length, Math.floor((W + gap) / (Math.min(want, W) + gap))));
    const cardW = Math.min(want, Math.floor((W - gap * (perRow - 1)) / perRow));
    const innerW = cardW - 4;
    const out: string[] = [];
    for (let at = 0; at < list.length; at += perRow) {
      const group = list.slice(at, at + perRow);
      const hasSub = group.some((c) => c.sub);
      const rowsOf = (c: Card): string[] => {
        const value = tone(theme.bold(cut(clean(c.value), innerW)), c.tone ?? 'plain');
        const label = cut(clean(c.label), innerW);
        const lines = [value, label];
        if (hasSub) lines.push(theme.muted(cut(clean(c.sub ?? ''), innerW)));
        return lines;
      };
      const bodies = group.map(rowsOf);
      const height = bodies[0]?.length ?? 0;
      out.push(group.map(() => theme.faint(`${r.tl}${r.h.repeat(cardW - 2)}${r.tr}`)).join(' '.repeat(gap)));
      for (let i = 0; i < height; i += 1) {
        out.push(bodies.map((body) => `${theme.faint(r.v)} ${padEnd(body[i] ?? '', innerW)} ${theme.faint(r.v)}`).join(' '.repeat(gap)));
      }
      out.push(group.map(() => theme.faint(`${r.bl}${r.h.repeat(cardW - 2)}${r.br}`)).join(' '.repeat(gap)));
    }
    return out;
  };

  const next = (hint: string | readonly string[]): string[] => {
    const hints = (typeof hint === 'string' ? [hint] : [...hint]).map(clean).map((h) => h.replace(/^Next:\s*/u, ''));
    if (hints.length === 0) return [];
    const lead = `${sym.arrow} Next: `;
    const out: string[] = [''];
    const first = wrap(hints[0] ?? '', W - width(lead));
    first.forEach((l, i) => out.push(i === 0 ? `${theme.bold(theme.accent(lead))}${l}` : `${' '.repeat(width(lead))}${l}`));
    for (const alt of hints.slice(1)) {
      const orLead = `${' '.repeat(Math.max(0, width(lead) - 4))}or: `;
      wrap(alt, W - width(orLead)).forEach((l, i) => out.push(i === 0 ? `${theme.muted(orLead)}${l}` : `${' '.repeat(width(orLead))}${l}`));
    }
    return out;
  };

  const verbose = (title: string, lines: readonly (string | VerboseLine)[], options: { readonly force?: boolean } = {}): string[] => {
    if (!caps.verbose && !options.force) return [];
    const g = theme.faint(sym.gutter);
    const out: string[] = [cut(`  ${theme.muted(`${caps.unicode ? '▾' : 'v'} ${clean(title)}`)}`, W)];
    const items = lines.map((l) => (typeof l === 'string' ? { label: '', text: l } : { label: clean(l.label ?? ''), text: l.text }));
    const labelW = Math.max(0, ...items.map((i) => width(i.label)));
    const lw = labelW > 0 ? labelW + 2 : 0;
    const textW = Math.max(10, W - 4 - lw);
    for (const item of items) {
      // Proof text is shown whole: folded at the width, never cut.
      const folded = sanitize(item.text).split('\n').flatMap((p) => wrap(p, textW));
      folded.forEach((l, i) => out.push(`  ${g} ${theme.muted(padEnd(i === 0 ? item.label : '', lw))}${l}`));
    }
    return out;
  };

  const hint = (text: string): string[] => [cut(theme.muted(clean(text)), W)];

  const bar = (fraction: number, cols: number): string => {
    const f = Math.max(0, Math.min(1, Number.isFinite(fraction) ? fraction : 0));
    const n = Math.max(1, Math.floor(cols));
    const exact = f * n;
    let full = Math.floor(exact);
    const half = exact - full >= 0.5 && full < n && sym.bar.half !== sym.bar.full;
    if (!half && exact - full >= 0.5 && full < n) full += 1;
    const empty = n - full - (half ? 1 : 0);
    return `${theme.accent(sym.bar.full.repeat(full) + (half ? sym.bar.half : ''))}${theme.faint(sym.bar.empty.repeat(empty))}`;
  };

  const line = (text: string, t: Tone = 'plain'): string => cut(tone(clean(text), t), W);

  return { caps, theme, sym, width: W, tone, line, header, section, badge, finding, rows: rowsOf, table, cards, next, verbose, hint, bar };
}

/** The parts of a command context a Ui needs (src/cli/context.ts CommandContext fits). */
export interface UiContext {
  readonly env: NodeJS.ProcessEnv;
  readonly argv: readonly string[];
  readonly style: { readonly color: boolean };
}
/**
 * A Ui for a command: the context's colour decision wins (tests pass a plain style and get plain text), the depth and
 * the size come from the stream (default process.stdout).
 */
export function uiForContext(ctx: UiContext, stream: UiStream | undefined = process.stdout): Ui {
  const ui = createUi({ stream, env: ctx.env, argv: ctx.argv });
  if (ctx.style.color && ui.caps.color !== 'none') return ui;
  if (!ctx.style.color && ui.caps.color === 'none') return ui;
  return createUi({ stream, env: ctx.env, argv: ctx.argv, caps: { color: ctx.style.color ? '16' : 'none' } });
}
