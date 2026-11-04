// DS-C: the interactive screen with the real core on scripted rounds: the card shows with its cost and keys, y runs it
// in-process with its lines inside the chat, the result and the agent's reading land in the scrollback; n skips a card.
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { DiscussSession } from '../../../src/discuss/contract.js';
import { openSession } from '../../../src/discuss/core/session.js';
import { runInteractive } from '../../../src/discuss/tui/index.js';
import { cleanup, makeWorkspace, tempDir, writeRounds } from '../core/helpers.js';
import { Vt } from './vt.js';

class FakeInput extends EventEmitter {
  isTTY = true;
  setRawMode(): void {}
  setEncoding(): void {}
  resume(): void {}
  pause(): void {}
  type(s: string): void {
    this.emit('data', s);
  }
}

const dirs: string[] = [];
afterEach(() => cleanup(...dirs.splice(0)));

async function screen(rounds: Record<string, unknown>, goal?: string) {
  const { root } = makeWorkspace();
  const script = writeRounds(join(tempDir('ds-c-tui-'), 'rounds'), rounds);
  dirs.push(root, join(script, '..'));
  const session: DiscussSession = await openSession({ cwd: root, env: {}, scriptedDir: script, save: false });
  const vt = new Vt(100, 40);
  const input = new FakeInput();
  const output = Object.assign(new EventEmitter(), {
    isTTY: true,
    columns: 100,
    rows: 40,
    write(s: string) {
      vt.write(s);
      return true;
    },
  });
  const done = runInteractive(session, { input, output, env: { HOME: '/home/you', COLORTERM: 'truecolor' }, goal });
  return { root, session, vt, input, done };
}

const tick = (ms = 80): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function until(check: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await tick(20);
}

describe('action cards on the interactive screen', () => {
  it('a goal plans, the card waits, y runs the check inside the chat and the agent discusses the result', async () => {
    const t = await screen(
      {
        '1-1': { toolCalls: [{ name: 'propose_action', arguments: { command: 'check', noAi: true, why: 'Step 1: see what the rules say now.' } }] },
        '1-2': { text: 'Plan: 1. check with the rules (free). 2. rule propose for the rest (paid, I will ask).' },
        '2-1': { text: 'privacy.01 is **BROKEN (rule, no AI)**: chats are kept 90 days [[src/config.ts:2]].' },
      },
      'check that support chats are deleted in time',
    );
    await until(() => t.vt.text().join('\n').includes('Run jurator check --no-ai?'));
    const before = t.vt.all().join('\n');
    expect(before).toContain('› check that support chats are deleted in time');
    expect(before).toContain('Proposed action (by AI; runs only if you say yes)');
    expect(before).toContain('│ jurator check --no-ai');
    expect(before).toContain('│ Why: Step 1: see what the rules say now.');
    expect(before).toContain('│ Cost: free (no model) · a few seconds');
    expect(before).toContain('│ Enter or y to run · n or Esc to skip');
    expect(t.vt.text().join('\n')).toContain('? Run jurator check --no-ai? Enter/y run · n/Esc skip');
    t.input.type('y');
    await until(() => t.vt.all().join('\n').includes('◆ privacy.01 is BROKEN'));
    const all = t.vt.all().join('\n');
    if (process.env.DSC_SHOW) (await import("node:fs")).writeFileSync(process.env.DSC_SHOW, `${before}\n=====\n${all}\n`);
    expect(all).toContain('✓ you said yes');
    expect(all).toMatch(/✓ Ran jurator check --no-ai · exit 1 \(a promise is broken\) · [\d.]+m?s · \$0(\.00)?/u);
    expect(all).toMatch(/Check \S+ at [0-9a-f]{7}: 1 broken, 1 not checked \(2 promises\)\./u);
    expect(all).toContain('- privacy.01 BROKEN (rule, no AI) src/config.ts:2');
    expect(all).toContain('◆ privacy.01 is BROKEN (rule, no AI): chats are kept 90 days');
    expect(t.session.info().pendingAction).toBeNull();
    expect(t.vt.text().join('\n')).not.toContain('Enter/y run');
    t.input.type('\u0004');
    expect(await t.done).toBe(0);
  });

  it('n skips the card and nothing runs; typing a letter other than y/n edits as usual', async () => {
    const t = await screen({
      '1-1': { toolCalls: [{ name: 'propose_action', arguments: { command: 'report', why: 'Write the HTML page of the last check.' } }] },
      '1-2': { text: 'I can write the report.' },
    });
    t.input.type('report please');
    t.input.type('\r');
    await until(() => t.vt.text().join('\n').includes('Run jurator report?'));
    t.input.type('n');
    await until(() => t.vt.all().join('\n').includes('Skipped: jurator report'));
    expect(t.session.info().pendingAction).toBeNull();
    expect(t.vt.all().join('\n')).not.toContain('Ran jurator report');
    t.input.type('nope');
    await tick();
    expect(t.vt.text().join('\n')).toContain('› nope');
    t.input.type('\u0015\u0004');
    expect(await t.done).toBe(0);
  });
});
