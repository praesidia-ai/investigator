import { describe, expect, it } from 'vitest';
import { BRAND } from '../../src/brand.js';
import { createUi, type BadgeKind, type Ui } from '../../src/ui/components.js';
import { width } from '../../src/ui/text.js';

const plain = (cols = 80, extra: Parameters<typeof createUi>[0] = {}): Ui =>
  createUi({ env: {}, ...extra, caps: { live: false, color: 'none', unicode: true, width: cols, verbose: false, ...extra.caps } });
const coloured = (cols = 80): Ui => createUi({ env: {}, caps: { live: true, color: 'truecolor', unicode: true, width: cols } });

const KINDS: BadgeKind[] = ['holds', 'broken', 'broken-now', 'looks-kept', 'looks-broken', 'cant-tell', 'not-checked'];

function everything(ui: Ui): string[] {
  return [
    ...ui.header({ command: 'rule propose', workspace: 'investigator workspace · 2 repos', model: 'muse-wonder (live)', budgetUsd: 10 }),
    ...ui.section('Rules', '19 promises'),
    ...KINDS.map((k) => ui.badge(k, { long: true })),
    ...ui.finding({
      kind: 'broken-now',
      id: 'retention.03',
      title: 'found while writing the rule, no AI',
      rows: [
        { label: 'Policy', text: '"Cached copies of a document are deleted within 24 hours."', where: 'policies/retention.md:18' },
        { label: 'Code', text: 'backend-api/app/services/cache_service.py:19' },
        { text: 'CACHE_TTL_SECONDS = 172800  # 2 days, and a long comment that goes on and on', tone: 'code', lineNo: 19 },
        { label: 'Actual', text: '172800 seconds (2 days); allowed at most 24 hours', tone: 'broken' },
      ],
    }),
    ...ui.table({
      columns: [{ header: 'Promise' }, { header: 'Result' }, { header: 'Reason', flex: true }],
      rows: [
        ['documents.01', ui.badge('holds'), 'regex rule, 6 mutants caught, the red team held after three edits'],
        ['retention.03', ui.badge('broken-now'), 'cache_service.py:19 ttl 172800 seconds, allowed 24 hours'],
      ],
    }),
    ...ui.cards([
      { value: '16', label: 'rules written', tone: 'kept' },
      { value: '2', label: 'broken now', tone: 'broken' },
      { value: '$2.44', label: 'of $10.00', tone: 'accent' },
    ]),
    ...ui.verbose('proof', [{ label: 'pattern', text: `(?i)\\b(${'provider|'.repeat(30)}x)\\b` }], { force: true }),
    ...ui.next([`${BRAND.command} check --diff main`, `${BRAND.command} rule list`]),
  ];
}

describe('components in plain mode', () => {
  it('header, section and badges', () => {
    const ui = plain(80);
    expect(ui.header({ command: 'rule propose', workspace: 'investigator workspace · 2 repos', model: 'muse-wonder (live)', budgetUsd: 10 })).toEqual([
      `◆ ${BRAND.name} · rule propose`,
      '  investigator workspace · 2 repos · model muse-wonder (live) · budget $10.00',
    ]);
    expect(ui.section('Rules', '19 promises')).toEqual([
      '',
      '── Rules ──────────────────────────────────────────────────────── 19 promises ──',
    ]);
    expect(KINDS.map((k) => ui.badge(k))).toEqual([
      '✓ HOLDS',
      '✗ BROKEN',
      '✗ BROKEN NOW',
      '~ LOOKS KEPT',
      '? LOOKS BROKEN',
      "? CAN'T TELL",
      '· NOT CHECKED',
    ]);
    expect(ui.badge('broken', { long: true })).toBe('✗ BROKEN (rule, no AI)');
    expect(ui.badge('looks-broken', { long: true })).toBe('? LOOKS BROKEN (read by AI)');
  });

  it('the boxed finding', () => {
    const ui = plain(60);
    expect(
      ui.finding({
        kind: 'broken',
        id: 'privacy.02',
        title: 'proved by a rule, no AI',
        rows: [
          { label: 'Policy', text: '"We delete chat logs after 30 days."', where: 'docs/privacy.md:12' },
          { label: 'Code', text: 'src/chat/store.ts:14' },
          { text: 'const CHAT_TTL_DAYS = 90;', tone: 'code', lineNo: 14 },
        ],
      }),
    ).toEqual([
      '┏━ ✗ BROKEN ━ privacy.02 ━━━━━━━━ proved by a rule, no AI ━┓',
      '┃ Policy  "We delete chat logs after 30 days."             ┃',
      '┃         docs/privacy.md:12                               ┃',
      '┃ Code    src/chat/store.ts:14                             ┃',
      '┃         14 │ const CHAT_TTL_DAYS = 90;                   ┃',
      '┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛',
    ]);
  });

  it('tables align and cut the flexible column first', () => {
    const ui = plain(50);
    expect(
      ui.table({
        columns: [{ header: 'Promise' }, { header: 'Result' }, { header: 'Reason', flex: true }],
        rows: [
          ['documents.01', ui.badge('holds'), 'regex rule, 6 mutants caught, red team held'],
          ['retention.03', ui.badge('broken-now'), 'ttl 172800s, allowed 24h'],
        ],
      }),
    ).toEqual([
      '  Promise       Result        Reason',
      `  ${'─'.repeat(48)}`,
      '  documents.01  ✓ HOLDS       regex rule, 6 mutan…',
      '  retention.03  ✗ BROKEN NOW  ttl 172800s, allowe…',
    ]);
  });

  it('cards, Next and the verbose block', () => {
    const ui = plain(80);
    expect(ui.cards([{ value: '16', label: 'rules written' }, { value: '$2.44', label: 'of $10.00' }])).toEqual([
      '╭───────────────╮ ╭───────────────╮',
      '│ 16            │ │ $2.44         │',
      '│ rules written │ │ of $10.00     │',
      '╰───────────────╯ ╰───────────────╯',
    ]);
    expect(ui.next([`Next: ${BRAND.command} check`, `${BRAND.command} rule list`])).toEqual([
      '',
      `→ Next: ${BRAND.command} check`,
      `    or: ${BRAND.command} rule list`,
    ]);
    expect(ui.verbose('proof', ['x'])).toEqual([]);
    expect(plain(40, { caps: { verbose: true } }).verbose('proof', [{ label: 'pattern', text: 'a'.repeat(40) }])).toEqual([
      '  ▾ proof',
      `  │ pattern  ${'a'.repeat(27)}`,
      `  │          ${'a'.repeat(13)}`,
    ]);
  });

  it('ASCII symbols when Unicode is off', () => {
    const ui = plain(60, { caps: { unicode: false } });
    expect(ui.badge('holds')).toBe('+ HOLDS');
    expect(ui.section('Rules')[1]?.startsWith('-- Rules ---')).toBe(true);
    expect(ui.next('go')[1]).toBe('-> Next: go');
    expect(everything(ui).join('\n').replace('investigator workspace · 2 repos', 'ws')).toMatch(/^[\x20-\x7e\n]*$/u);
  });
});

describe('layout', () => {
  it('never writes a line wider than the terminal', () => {
    for (const cols of [40, 60, 80, 100, 160]) {
      for (const ui of [plain(cols), coloured(cols)]) {
        for (const line of everything(ui)) expect(width(line), `${cols}: ${line}`).toBeLessThanOrEqual(Math.min(cols, 120));
      }
    }
  });
  it('writes no escape code at all when colour is off', () => {
    expect(everything(plain(80)).join('\n')).not.toContain('\u001b');
    expect(everything(coloured(80)).join('\n')).toContain('\u001b[38;2;245;158;11m');
  });
  it('256 and 16 colour fallbacks', () => {
    const c256 = createUi({ env: {}, caps: { color: '256', width: 80 } });
    expect(c256.section('Rules').join('')).toContain('\u001b[38;5;214m');
    const c16 = createUi({ env: {}, caps: { color: '16', width: 80 } });
    expect(c16.section('Rules').join('')).toContain('\u001b[33m');
  });
  it('cleans text from repositories (no cursor moves)', () => {
    const lines = plain(80).finding({ kind: 'broken', id: 'x.01', rows: [{ label: 'Code', text: 'a\u001b[2J\u001b[1Ab', tone: 'code' }] });
    expect(lines.join('\n')).not.toContain('\u001b');
    expect(lines.join('\n')).toContain('ab');
  });
});

describe('uiForContext', () => {
  it('follows the command context: a plain style gives plain text even on a terminal', async () => {
    const { uiForContext } = await import('../../src/ui/components.js');
    const tty = { isTTY: true, columns: 90, rows: 20, write: () => true };
    const off = uiForContext({ env: { TERM: 'xterm-256color' }, argv: [], style: { color: false } }, tty);
    expect(off.caps.color).toBe('none');
    expect(off.width).toBe(90);
    const on = uiForContext({ env: { TERM: 'xterm-256color' }, argv: [], style: { color: true } }, tty);
    expect(on.caps.color).toBe('256');
    const forced = uiForContext({ env: {}, argv: [], style: { color: true } }, { isTTY: false, write: () => true });
    expect(forced.caps.color).toBe('16');
  });
});
