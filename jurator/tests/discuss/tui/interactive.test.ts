import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import type { DiscussEvent, DiscussSession } from '../../../src/discuss/contract.js';
import { EXAMPLE_TURN } from '../../../src/discuss/contract.js';
import { createFakeSession, runInteractive } from '../../../src/discuss/tui/index.js';
import { Vt } from './vt.js';

class FakeInput extends EventEmitter {
  isTTY = true;
  raw: boolean[] = [];
  setRawMode(b: boolean): void {
    this.raw.push(b);
  }
  setEncoding(): void {}
  resume(): void {}
  pause(): void {}
  type(s: string): void {
    this.emit('data', s);
  }
}

function setup(session: DiscussSession, cols = 90, rows = 30) {
  const vt = new Vt(cols, rows);
  const input = new FakeInput();
  const writes: string[] = [];
  const output = Object.assign(new EventEmitter(), {
    isTTY: true,
    columns: cols,
    rows,
    write(s: string) {
      writes.push(s);
      vt.write(s);
      return true;
    },
  });
  const done = runInteractive(session, { input, output, env: { HOME: '/home/you', COLORTERM: 'truecolor' } });
  return { vt, input, output, writes, done };
}

const tick = (ms = 60): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('interactive discuss screen', () => {
  it('draws the header, the editor and the footer, then a full turn into the scrollback', async () => {
    const t = setup(createFakeSession());
    await tick();
    expect(t.vt.text()[0]).toContain('◆ Jurator discuss · investigator · main at 9f3c2a1 · muse-wonder-1.0');
    expect(t.vt.text().at(-1)).toMatch(/^↑0 ↓0 · \$0\.00 of \$3\.00 +muse-wonder-1\.0 · \/help$/u);
    expect(t.vt.text().at(-2)).toBe('~/investigator (main) · snapshot 9f3c2a1');
    t.input.type('show me where the extension writes to chrome.storage');
    await tick();
    expect(t.vt.text().join('\n')).toContain('› show me where the extension writes to chrome.storage');
    t.input.type('\r');
    await tick(120);
    const all = t.vt.all().join('\n');
    expect(all).toContain('  ▸ search_code "chrome.storage" · 3 hits in 2 files · 41ms');
    expect(all).toContain('  ▸ read_lines chrome-extension/src/background.ts:40-44 · 5 lines · 12ms');
    expect(all).toContain('╭ chrome-extension/src/background.ts:40-44 · 9f3c2a1');
    expect(all).toContain('│ 41    await chrome.storage.local.set({ draft: d });');
    expect(all).toContain('◆ The extension writes drafts to chrome.storage.local in saveDraft');
    expect(all).toContain('chrome-extension/src/background.ts:41');
    expect(all).not.toContain('[[');
    expect(all).toContain('Evidence, copied from git at 9f3c2a1');
    expect(all).toContain('↑11k ↓730 · $0.06');
    expect(t.vt.text().at(-1)).toContain('↑11k ↓730 · $0.06 of $3.00');
    // Never more than one copy of the editor and footer on screen (the live region is redrawn in place).
    expect(t.vt.all().filter((l) => l.startsWith('~/investigator (main)')).length).toBe(1);
    // Every redraw is one write inside synchronized output.
    expect(t.writes.filter((w) => w.includes('\u001b[J')).every((w) => w.startsWith('\u001b[?2026h') && w.endsWith('\u001b[?2026l'))).toBe(true);
    t.input.type('\u0004');
    expect(await t.done).toBe(0);
    expect(t.input.raw).toEqual([true, false]);
    expect(t.writes.join('')).toContain('\u001b[?2004l');
    expect(t.vt.all().join('\n')).toContain('Transcript: /home/you/investigator/.jurator/local/discuss/');
  });

  it('Esc cancels the running turn, keeps the session, and the next turn still works', async () => {
    const t = setup(createFakeSession({ delayMs: 40 }));
    await tick();
    t.input.type('slow question\r');
    await tick(80);
    expect(t.vt.text().join('\n')).toMatch(/Esc to stop/u);
    t.input.type('\u001b');
    await tick(120);
    const all = t.vt.all().join('\n');
    expect(all).toContain('stopped after');
    expect(all).not.toContain('◆ The extension writes drafts');
    expect(t.vt.text().join('\n')).not.toMatch(/Esc to stop/u);
    t.input.type('again\r');
    await tick(900);
    expect(t.vt.all().join('\n')).toContain('◆ The extension writes drafts');
    t.input.type('\u0003');
    await tick();
    expect(t.vt.text().join('\n')).toContain('Ctrl-C again to exit');
    t.input.type('\u0003');
    expect(await t.done).toBe(0);
  });

  it('Ctrl-C during a turn aborts the signal the session got', async () => {
    let seen: AbortSignal | null = null;
    const base = createFakeSession();
    const session: DiscussSession = {
      ...base,
      async *send(_text, signal): AsyncGenerator<DiscussEvent> {
        seen = signal;
        yield { type: 'turn-start', turn: 1, at: 'x' };
        yield { type: 'thinking', turn: 1, round: 1 };
        await new Promise<void>((r) => signal.addEventListener('abort', () => r(), { once: true }));
        yield { type: 'done', turn: 1, reason: 'cancelled', ms: 5, usd: 0 };
      },
    };
    const t = setup(session);
    await tick();
    t.input.type('hello\r');
    await tick();
    expect(t.vt.text().join('\n')).toContain('thinking');
    t.input.type('\u0003');
    await tick();
    expect((seen as AbortSignal | null)?.aborted).toBe(true);
    expect(t.vt.all().join('\n')).toContain('stopped after');
    t.input.type('\u0004');
    expect(await t.done).toBe(0);
  });

  it('Tab completes a slash command and the result is printed muted above the editor', async () => {
    const t = setup(createFakeSession());
    await tick();
    t.input.type('/pro\t');
    await tick();
    expect(t.vt.text().join('\n')).toContain('› /promises');
    t.input.type('\r');
    await tick();
    const all = t.vt.all().join('\n');
    expect(all).toContain('3 accepted promises');
    expect(all).toMatch(/privacy\.01 +BROKEN \(rule, no AI\) +Support chats/u);
    t.input.type('/exit\r');
    expect(await t.done).toBe(0);
  });

  it('a long paste shows as a marker and is expanded on send', async () => {
    const sent: string[] = [];
    const base = createFakeSession();
    const session: DiscussSession = {
      ...base,
      send(text, signal) {
        sent.push(text);
        return base.send(text, signal);
      },
    };
    const t = setup(session);
    await tick();
    const pasted = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join('\n');
    t.input.type(`look at \u001b[200~${pasted}\u001b[201~`);
    await tick();
    expect(t.vt.text().join('\n')).toContain('› look at [paste #1 +12 lines]');
    t.input.type('\r');
    await tick(100);
    expect(sent).toEqual([`look at ${pasted}`]);
    t.input.type('\u0004');
    await t.done;
  });

  it('redraws the live region at the new width on resize without leaving copies', async () => {
    const t = setup(createFakeSession(), 100, 30);
    await tick();
    t.input.type('some text');
    await tick();
    Object.assign(t.output, { columns: 70 });
    const vt2 = t.vt;
    t.output.emit('resize');
    await tick();
    expect(vt2.text().filter((l) => l.startsWith('~/investigator')).length).toBe(1);
    expect(vt2.text().every((l) => l.length <= 100)).toBe(true);
    t.input.type('\u0003\u0004');
    expect(await t.done).toBe(0);
  });

  it('the EXAMPLE_TURN replays as the contract orders it', () => {
    expect(EXAMPLE_TURN.at(-1)?.type).toBe('done');
  });
});
