import { describe, expect, it } from 'vitest';
import type { DiscussEvent, DiscussSession } from '../../../src/discuss/contract.js';
import { createFakeSession, runPlain } from '../../../src/discuss/tui/index.js';
import { answerLines, citationBox, footerLines, headerLines, slashLines, toolLines, type Look } from '../../../src/discuss/tui/view.js';
import { makeTheme, UNICODE, ASCII } from '../../../src/ui/theme.js';
import { renderMarkdown } from '../../../src/discuss/tui/markdown.js';

async function* from(lines: string[]): AsyncGenerator<string> {
  for (const l of lines) yield l;
}

async function plain(session: DiscussSession, input: string[], json = false) {
  let out = '';
  const notes: string[] = [];
  const code = await runPlain(session, { lines: from(input), write: (s) => (out += s), note: (s) => notes.push(s) }, { json });
  return { code, out, notes };
}

const look: Look = { theme: makeTheme('none'), sym: UNICODE, width: 80 };

describe('plain mode', () => {
  it('one line in, the answer out, with evidence copied from git and the cost', async () => {
    const r = await plain(createFakeSession(), ['show me where the extension writes to chrome.storage']);
    expect(r.code).toBe(0);
    expect(r.out).toMatchInlineSnapshot(`
      "> show me where the extension writes to chrome.storage
      - search_code "chrome.storage": 3 hits in 2 files
      - read_lines chrome-extension/src/background.ts:40-44: 5 lines
      The extension writes drafts to \`chrome.storage.local\` in **saveDraft** [[chrome-extension/src/background.ts:41]].
        chrome-extension/src/background.ts:41 @ 9f3c2a1e |   await chrome.storage.local.set({ draft: d });
      ($0.059 this turn, $0.06 of $3.00)
      "
    `);
    expect(r.out).not.toMatch(/\u001b/u);
    expect(r.notes[0]).toMatch(/^Transcript: .*\.jurator\/local\/discuss\//u);
  });

  it('slash commands print plain lines; /exit stops reading', async () => {
    const r = await plain(createFakeSession(), ['/budget 5', '/nope', '/exit', 'never sent']);
    expect(r.out).toMatchInlineSnapshot(`
      "> /budget 5
      Budget $5.00 · $0.00 spent (changed)
      > /nope
      ✗ Unknown command /nope. Did you mean /no?
        Usage: /help
      > /exit
      "
    `);
  });

  it('errors carry their Next step; failed tools show x', async () => {
    const r = await plain(createFakeSession(), ['over budget please', 'fail this']);
    expect(r.out).toContain('Error: The next call could pass the session budget of $3.00; nothing was sent.\nNext: /budget 5');
    expect(r.out).toContain('x read_lines chrome-extension/src/background.ts:40-44: refused: .env files are never read');
  });

  it('--json writes NDJSON events and slash results', async () => {
    const r = await plain(createFakeSession(), ['q', '/model spark'], true);
    const lines = r.out.trim().split('\n').map((l) => JSON.parse(l) as { type: string; result?: { kind: string; modelId: string } });
    expect(lines[0]?.type).toBe('turn-start');
    expect(lines.filter((l) => l.type === 'done')).toHaveLength(1);
    expect(lines.at(-1)).toEqual({ type: 'slash', result: { kind: 'model', model: 'spark', modelId: 'muse-spark-1.3', changed: true } });
  });

  it('a cancel (SIGINT) aborts the turn in flight and keeps reading', async () => {
    let fire: () => void = () => undefined;
    const base = createFakeSession();
    const session: DiscussSession = {
      ...base,
      async *send(text, signal): AsyncGenerator<DiscussEvent> {
        yield { type: 'turn-start', turn: 1, at: 'x' };
        if (text === 'slow') {
          fire();
          yield { type: 'done', turn: 1, reason: signal.aborted ? 'cancelled' : 'answered', ms: 1, usd: 0 };
          return;
        }
        yield* base.send(text, signal);
      },
    };
    let out = '';
    await runPlain(
      session,
      {
        lines: from(['slow', 'fast']),
        write: (s) => (out += s),
        note: () => undefined,
        onInterrupt: (fn) => {
          fire = fn;
          return () => undefined;
        },
      },
      { json: false },
    );
    expect(out).toContain('(stopped; $0.000 this turn');
    expect(out).toContain('> fast\n- search_code');
  });
});

describe('blocks (colour off)', () => {
  it('header, tool lines, evidence box, answer and footer', () => {
    const s = createFakeSession({ root: '/Users/you/Desktop/investigator' });
    const info = s.info();
    expect(headerLines(info, { ...look, width: 100 })).toEqual([
      '◆ Jurator discuss · investigator · main at 9f3c2a1 · muse-wonder-1.0 · scripted, no network',
      '  Read-only: I look things up and explain; only you run commands. /help for keys.',
      '  14 promises · last check 10:02 at 9f3c2a1: 2 broken, 1 looks broken',
    ]);
    expect(footerLines(info, look, '/Users/you')).toEqual([
      '~/Desktop/investigator (main) · snapshot 9f3c2a1',
      `↑0 ↓0 · $0.00 of $3.00${' '.repeat(79 - 22 - 23)}muse-wonder-1.0 · /help`,
    ]);
    const tool = toolLines(
      {
        id: 't',
        label: 'read_lines api/app.ts:1-10',
        result: {
          type: 'tool-result',
          turn: 1,
          id: 't',
          name: 'read_lines',
          ok: true,
          summary: '10 lines',
          ms: 3,
          evidence: [{ path: 'api/app.ts', commit: 'abcdef1234', startLine: 1, endLine: 10, quote: Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n') }],
        },
      },
      { ...look, width: 50 },
    );
    expect(tool).toMatchInlineSnapshot(`
      [
        "  ▸ read_lines api/app.ts:1-10 · 10 lines · 3ms",
        "    ╭ api/app.ts:1-10 · abcdef1 ────────────────╮",
        "    │ 1  line 1                                 │",
        "    │ 2  line 2                                 │",
        "    │ 3  line 3                                 │",
        "    │ 4  line 4                                 │",
        "    │ 5  line 5                                 │",
        "    │ 6  line 6                                 │",
        "    │ 7  line 7                                 │",
        "    │ 8  line 8                                 │",
        "    │ … 2 more in the transcript                │",
        "    ╰───────────────────────────────────────────╯",
      ]
    `);
    expect(toolLines({ id: 'x', label: 'read_lines .env:1-2', result: { type: 'tool-result', turn: 1, id: 'x', name: 'read_lines', ok: false, summary: 'refused: .env files are never read', ms: 1 } }, look)).toEqual([
      '  ✗ read_lines .env:1-2 · refused: .env files are never read',
    ]);
  });

  it('light markdown: bold, inline code, cite markers dim, lists, fences marked as model text', () => {
    const text = 'Two promises are **broken**:\n\n- `privacy.01` keeps chats 90 days [[backend/app/config.py:12]]\n- security.02 looks broken\n\n```py\nCHAT_TTL_DAYS = 90\n```';
    expect(answerLines(text, look)).toEqual([
      '◆ Two promises are broken:',
      '  ',
      '  • privacy.01 keeps chats 90 days backend/app/config.py:12',
      '  • security.02 looks broken',
      '  ',
      '  │ model text, not evidence',
      '  │ CHAT_TTL_DAYS = 90',
    ]);
    const coloured = renderMarkdown('a **b** `c` [[p.ts:1]]', { theme: makeTheme('16'), sym: UNICODE, width: 40 })[0] ?? '';
    expect(coloured).toContain('\u001b[1mb\u001b[22m');
    expect(coloured).toContain('\u001b[2mp.ts:1\u001b[22m');
  });

  it('untrusted text cannot move the cursor or recolour the screen', () => {
    const box = citationBox({ path: 'x.ts', commit: 'abc1234', startLine: 1, endLine: 1, quote: 'evil\u001b[2J\u001b[31mred‮' }, look);
    expect(box.join('\n')).not.toMatch(/\u001b|‮/u);
    expect(answerLines('hi \u001b]0;title\u0007there', look)).toEqual(['◆ hi there']);
  });

  it('ASCII symbols when the terminal cannot show Unicode', () => {
    const l: Look = { ...look, sym: ASCII };
    expect(answerLines('ok', l)).toEqual(['* ok']);
    expect(slashLines({ kind: 'error', code: 'BAD_INPUT', message: 'bad' }, l)).toEqual(['  x bad']);
  });
});
