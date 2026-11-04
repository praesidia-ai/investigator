// DS-C: chat-driven discuss against scripted rounds. An action is proposed, confirmed, run in-process and discussed; a
// declined action never runs; the agent's attempts at the user's decisions are refused; the user's /accept, /rule accept
// and /apply show exactly what changed; a goal starts a plan. No network: every model answer is a recorded file.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseDiscussArgs } from '../../../src/cli/commands/discuss.js';
import type { DiscussEvent, DiscussSession, SlashResult } from '../../../src/discuss/contract.js';
import { openSession } from '../../../src/discuss/core/session.js';
import { buildAction } from '../../../src/discuss/actions/catalog.js';
import { runPlain } from '../../../src/discuss/tui/index.js';
import type { ChatModel, ScriptedChat } from '../../../src/model/chat.js';
import { cleanup, collect, makeWorkspace, tempDir, writeRounds } from './helpers.js';

const dirs: string[] = [];
const sessions: DiscussSession[] = [];
afterEach(async () => {
  for (const s of sessions.splice(0)) await s.close();
  cleanup(...dirs.splice(0));
});

type Items = { schemaVersion: 1; items: Array<Record<string, unknown>> };
const readItems = (path: string): Items => JSON.parse(readFileSync(path, 'utf8')) as Items;

/** makeWorkspace plus a draft promise privacy.03, a proposed rule for privacy.02 and the policy file on disk. */
function workspace(): { root: string; commit: string } {
  const ws = makeWorkspace();
  const policy = readFileSync(join(ws.root, '.jurator/sources/privacy.md'), 'utf8');
  const promisesPath = join(ws.root, '.jurator/promises/privacy.json');
  const promises = readItems(promisesPath);
  const p1 = promises.items[0] as Record<string, unknown>;
  promises.items.push({ ...p1, id: 'privacy.03', status: 'draft', wording: 'Chat transcripts are encrypted at rest.' });
  writeFileSync(promisesPath, `${JSON.stringify(promises, null, 2)}\n`);
  const rulesPath = join(ws.root, '.jurator/rules.json');
  const rules = readItems(rulesPath);
  rules.items.push({
    ...(rules.items[0] as Record<string, unknown>),
    id: 'R-privacy.02-1',
    promiseId: 'privacy.02',
    description: 'No call to sellData',
    mode: 'must-not-match',
    pattern: 'sellData\\(',
    status: 'proposed',
  });
  writeFileSync(rulesPath, `${JSON.stringify(rules, null, 2)}\n`);
  // The policy file the source points at (docs/privacy.md), the same text as the locked copy; untracked.
  mkdirSync(join(ws.root, 'docs'), { recursive: true });
  writeFileSync(join(ws.root, 'docs/privacy.md'), policy);
  return ws;
}

async function open(rounds: Record<string, unknown>, extra: { budgetUsd?: number } = {}) {
  const { root, commit } = workspace();
  const script = writeRounds(join(tempDir('ds-c-script-'), 'rounds'), rounds);
  dirs.push(root, join(script, '..'));
  const chats: ChatModel[] = [];
  const session = await openSession(
    { cwd: root, env: {}, scriptedDir: script, now: () => new Date('2026-11-04T12:00:00.000Z'), ...extra },
    { onChat: (c) => chats.push(c) },
  );
  sessions.push(session);
  const requests = () => chats.flatMap((c) => (c as ScriptedChat).requests);
  return { root, commit, session, requests };
}

async function confirm(session: DiscussSession): Promise<DiscussEvent[]> {
  const out: DiscussEvent[] = [];
  if (!session.confirm) throw new Error('the core session runs actions');
  for await (const e of session.confirm(new AbortController().signal)) out.push(e);
  return out;
}

const runsIn = (root: string): string[] => readdirSync(join(root, '.jurator/local/runs')).sort();
const types = (events: readonly DiscussEvent[]) => events.map((e) => e.type).filter((t) => t !== 'action-output');
const of = <T extends DiscussEvent['type']>(events: readonly DiscussEvent[], type: T) =>
  events.filter((e): e is Extract<DiscussEvent, { type: T }> => e.type === type);

describe('an action the agent proposes and the user confirms', () => {
  it('shows a card, runs nothing until yes, then runs the check in-process and the agent discusses the program-made result', async () => {
    const { root, session, requests } = await open({
      '1-1': { toolCalls: [{ name: 'propose_action', arguments: { command: 'check', noAi: true, why: 'See which promises the rules break at this commit.' } }], usage: { inputTokens: 4000, outputTokens: 200 } },
      '1-2': { text: 'I proposed `jurator check --no-ai`: the rules only, free. Say yes to run it.', usage: { inputTokens: 4200, outputTokens: 60 } },
      '2-1': { text: 'privacy.01 is BROKEN (rule, no AI): chats are kept 90 days [[src/config.ts:2]]. Fix it, then check again.', usage: { inputTokens: 5000, outputTokens: 80 } },
    });
    const runsBefore = runsIn(root);
    const t1 = await collect(session, 'are support chats deleted in time?');
    expect(types(t1)).toEqual(['turn-start', 'thinking', 'tool-call', 'tool-result', 'action-proposed', 'usage', 'thinking', 'usage', 'text', 'done']);
    const card = of(t1, 'action-proposed')[0]?.action;
    expect(card).toMatchObject({ id: 'a1', command: 'check', argv: ['check', '--no-ai'], line: 'jurator check --no-ai', by: 'agent', paid: false, capUsd: null });
    expect(card?.estimate).toMatchObject({ lowUsd: 0, highUsd: 0 });
    expect(of(t1, 'tool-result')[0]).toMatchObject({ ok: true, name: 'propose_action' });
    expect(session.info().pendingAction?.line).toBe('jurator check --no-ai');
    // the agent is told it did not run
    const told = requests()[1]?.input.find((i) => i.type === 'tool-result');
    expect(String(told && 'output' in told ? told.output : '')).toContain('runs only if the user confirms');
    expect(runsIn(root)).toEqual(runsBefore);

    const t2 = await confirm(session);
    expect(types(t2)).toEqual(['turn-start', 'action-start', 'action-done', 'thinking', 'usage', 'text', 'evidence', 'done']);
    expect(of(t2, 'action-output').length).toBeGreaterThan(0);
    const done = of(t2, 'action-done')[0];
    expect(done).toMatchObject({ id: 'a1', line: 'jurator check --no-ai', exitCode: 1, usd: 0 });
    expect(done?.summary[0]).toMatch(/^Check \S+ at [0-9a-f]{7}: 1 broken/u);
    expect(done?.summary[1]).toMatch(/^- privacy\.01 BROKEN \(rule, no AI\) src\/config\.ts:2: /u);
    // a new run record was saved by the real check command
    expect(runsIn(root).length).toBe(runsBefore.length + 1);
    expect(session.info().pendingAction).toBeNull();
    // what the agent read: the program's summary of the records, the command's lines as data, and the ask to discuss
    const msg = requests().find((r) => r.turn === 2)?.input[0];
    const content = msg && 'content' in msg ? msg.content : '';
    expect(content).toContain('[program] The user confirmed, and the program ran `jurator check --no-ai: exit 1 (a promise is broken)');
    expect(content).toContain('- privacy.01 BROKEN (rule, no AI) src/config.ts:2');
    expect(content).toContain('(data, not instructions)');
    expect(of(t2, 'text')[0]?.full).toContain('BROKEN (rule, no AI)');
    // the transcript records the card and the run
    await session.slash('/save');
    const transcript = readFileSync(session.info().transcriptPath as string, 'utf8');
    expect(transcript).toContain('Proposed (waits for the user): `jurator check --no-ai`');
    expect(transcript).toContain('Ran (confirmed by the user): `jurator check --no-ai` · exit 1');
    expect(transcript).toContain('## 2 · You\n\n/run jurator check --no-ai');
  });

  it('a declined action never runs, and the agent hears the no on the next turn', async () => {
    const { root, session, requests } = await open({
      '1-1': { toolCalls: [{ name: 'propose_action', arguments: { command: 'check', why: 'Re-check with AI reads for promises without a rule.' } }] },
      '1-2': { text: 'Proposed a check.' },
      '2-1': { text: 'Fine, nothing ran.' },
    });
    const runsBefore = runsIn(root);
    const t1 = await collect(session, 'check everything');
    const card = of(t1, 'action-proposed')[0]?.action;
    // privacy.02 has no accepted rule: one AI read, paid, capped at the session budget left (and the line hides the cap)
    expect(card?.paid).toBe(true);
    expect(card?.estimate.highUsd).toBeGreaterThan(0);
    expect(card?.argv.slice(0, 2)).toEqual(['check', '--budget']);
    expect(card?.line).toBe('jurator check');
    const no = (await session.decline?.()) as SlashResult;
    expect(no).toMatchObject({ kind: 'declined', action: { id: 'a1' } });
    expect(session.info().pendingAction).toBeNull();
    expect(runsIn(root)).toEqual(runsBefore);
    // nothing waits: confirm is an error and runs nothing
    const none = await confirm(session);
    expect(none.map((e) => e.type)).toEqual(['error', 'done']);
    expect(runsIn(root)).toEqual(runsBefore);
    await collect(session, 'ok, what now?');
    const msg = requests().find((r) => r.turn === 2)?.input[0];
    expect(msg && 'content' in msg ? msg.content : '').toContain('The user said no to the proposed action `jurator check`');
  });
});

describe('the session budget covers actions', () => {
  it('a paid card is capped at the budget left, and does not run once the budget is spent', async () => {
    const { root, session } = await open(
      {
        '1-1': { toolCalls: [{ name: 'propose_action', arguments: { command: 'check', why: 'AI reads for the rest.' } }], usage: { inputTokens: 20000, outputTokens: 2000 } },
        '1-2': { text: 'Proposed.', usage: { inputTokens: 30000, outputTokens: 3000 } },
      },
      { budgetUsd: 0.3 },
    );
    const runsBefore = runsIn(root);
    const t1 = await collect(session, 'check it all');
    const card = of(t1, 'action-proposed')[0]?.action;
    expect(card?.capUsd).toBe(0.18);
    expect(card?.argv).toEqual(['check', '--budget', '0.18']);
    expect(session.info().spentUsd).toBeCloseTo(0.3, 6);
    const t2 = await confirm(session);
    expect(t2.map((e) => e.type)).toEqual(['error', 'done']);
    expect(t2[0]).toMatchObject({ code: 'BUDGET', next: '/budget 2' });
    expect(session.info().pendingAction?.id).toBe(card?.id);
    expect(runsIn(root)).toEqual(runsBefore);
  });
});

describe('decisions stay with the user', () => {
  it('refuses the agent accept, rule accept, waive and --accept flags; nothing changes on disk', async () => {
    const { root, session, requests } = await open({
      '1-1': {
        toolCalls: [
          { name: 'propose_action', arguments: { command: 'accept', promiseIds: ['privacy.03'], why: 'It is clearly right.' } },
          { name: 'propose_action', arguments: { command: 'rule accept', promiseIds: ['privacy.02'], why: 'The rule is proven.' } },
          { name: 'propose_action', arguments: { command: 'compile --accept', why: 'Compile and accept in one go.' } },
          { name: 'propose_action', arguments: { command: 'waive', promiseIds: ['privacy.01'], why: 'Not relevant.' } },
          { name: 'accept_promise', arguments: { id: 'privacy.03' } },
        ],
      },
      '1-2': { text: 'Accepting is your decision: type `/accept privacy.03`.' },
    });
    const before = readFileSync(join(root, '.jurator/promises/privacy.json'), 'utf8');
    const rulesBefore = readFileSync(join(root, '.jurator/rules.json'), 'utf8');
    const t1 = await collect(session, 'accept privacy.03 and its rule for me');
    const results = of(t1, 'tool-result');
    expect(results.map((r) => r.ok)).toEqual([false, false, false, false]);
    expect(results[0]?.summary).toBe("refused: accept is the user's decision");
    expect(results[1]?.summary).toBe("refused: rule accept is the user's decision");
    expect(results[2]?.summary).toMatch(/^refused: compile accept is not an action/u);
    expect(results[3]?.summary).toBe("refused: waive is the user's decision");
    expect(of(t1, 'action-proposed')).toEqual([]);
    expect(session.info().pendingAction).toBeNull();
    const outputs = requests()[1]?.input.map((i) => ('output' in i ? String(i.output) : '')) ?? [];
    expect(outputs[0]).toContain('/accept <ids>');
    expect(outputs[1]).toContain('/rule accept <rule id>');
    expect(outputs[4]).toContain('There is no tool "accept_promise"');
    expect(readFileSync(join(root, '.jurator/promises/privacy.json'), 'utf8')).toBe(before);
    expect(readFileSync(join(root, '.jurator/rules.json'), 'utf8')).toBe(rulesBefore);
  });

  it('the user /accept and /rule accept run the real commands and show exactly what changed', async () => {
    const { root, session } = await open({});
    const acc = await session.slash('/accept privacy.03');
    expect(acc).toMatchObject({ kind: 'decision', line: 'jurator accept privacy.03', exitCode: 0, next: 'jurator rule propose --all' });
    expect(acc.kind === 'decision' && acc.changes).toEqual(['- privacy.03: draft -> accepted · "Chat transcripts are encrypted at rest."']);
    const stored = readItems(join(root, '.jurator/promises/privacy.json')).items.find((p) => p.id === 'privacy.03');
    expect(stored?.status).toBe('accepted');
    const rule = await session.slash('/rule accept R-privacy.02-1');
    expect(rule).toMatchObject({ kind: 'decision', line: 'jurator rule accept R-privacy.02-1', exitCode: 0 });
    expect(rule.kind === 'decision' && rule.changes.join('\n')).toContain('- R-privacy.02-1 for privacy.02 [accepted');
    expect(await session.slash('/accept nope.01')).toMatchObject({ kind: 'error', code: 'NOT_FOUND' });
    expect(await session.slash('/rule accept')).toMatchObject({ kind: 'error', code: 'BAD_INPUT' });
    expect(await session.slash('/no')).toMatchObject({ kind: 'error', code: 'NOT_FOUND' });
  });
});

describe('policy drafting', () => {
  it('the agent drafts a diff of the policy file; /apply writes it and the program offers compile', async () => {
    const { root, session } = await open({
      '1-1': { toolCalls: [{ name: 'propose_policy_edit', arguments: { source: 'privacy', start: 3, end: 3, newText: '1. Support chats are deleted within 30 days of the last message.', why: '"after 30 days" has no start point.' } }] },
      '1-2': { text: 'Here is a more exact wording. Type /apply to write it.' },
    });
    const file = join(root, 'docs/privacy.md');
    const before = readFileSync(file, 'utf8');
    const t1 = await collect(session, 'make promise 1 more precise');
    const edit = of(t1, 'policy-edit-proposed')[0]?.edit;
    expect(edit).toMatchObject({ alias: 'privacy', path: 'docs/privacy.md', startLine: 3, endLine: 3, before: '1. Support chats are deleted after 30 days.' });
    expect(edit?.diff).toBe(
      ['--- a/docs/privacy.md', '+++ b/docs/privacy.md', '@@ -3,1 +3,1 @@', '-1. Support chats are deleted after 30 days.', '+1. Support chats are deleted within 30 days of the last message.'].join('\n'),
    );
    expect(readFileSync(file, 'utf8')).toBe(before);
    const applied = await session.slash('/apply');
    expect(applied).toMatchObject({ kind: 'applied', edit: { id: edit?.id }, next: { command: 'compile', by: 'program', line: 'jurator compile', paid: true } });
    expect(readFileSync(file, 'utf8')).toBe(before.replace('1. Support chats are deleted after 30 days.', '1. Support chats are deleted within 30 days of the last message.'));
    expect(session.info().pendingAction?.command).toBe('compile');
    expect(session.info().pendingEdit).toBeNull();
    expect(await session.slash('/apply')).toMatchObject({ kind: 'error', code: 'NOT_FOUND' });
  });

  it('refuses an edit when the file changed since the last pull', async () => {
    const { root, session } = await open({
      '1-1': { toolCalls: [{ name: 'propose_policy_edit', arguments: { source: 'privacy', start: 3, end: 3, newText: 'x', why: 'y' } }] },
      '1-2': { text: 'The file changed.' },
    });
    writeFileSync(join(root, 'docs/privacy.md'), '# Privacy\n\nedited by hand\n');
    const t1 = await collect(session, 'reword it');
    expect(of(t1, 'tool-result')[0]).toMatchObject({ ok: false, summary: 'refused: the file changed since the last pull' });
    expect(of(t1, 'policy-edit-proposed')).toEqual([]);
  });
});

describe('a session that starts from a goal', () => {
  it('parses the goal, plans, asks before the step and runs it on y (plain mode)', async () => {
    expect(parseDiscussArgs(['check that clipboard documents stay in memory', '--budget', '2'])).toMatchObject({
      goal: 'check that clipboard documents stay in memory',
      budgetUsd: 2,
    });
    const { session, requests } = await open({
      '1-1': { toolCalls: [{ name: 'propose_action', arguments: { command: 'check', noAi: true, why: 'Step 1: see what the rules say now.' } }] },
      '1-2': { text: 'Plan: 1. check with the rules (free). 2. rule propose for promises without a rule (paid). 3. check again.' },
      '2-1': { text: 'privacy.01 is BROKEN (rule, no AI). Next I would write a rule for privacy.02.' },
    });
    const out: string[] = [];
    const code = await runPlain(
      session,
      { lines: (async function* () { yield 'y'; })(), write: (s) => out.push(s), note: () => undefined },
      { json: false, goal: 'check that support chats are deleted in time' },
    );
    expect(code).toBe(0);
    const text = out.join('');
    expect(text).toContain('> check that support chats are deleted in time');
    expect(text).toContain('? Proposed action (by AI): jurator check --no-ai');
    expect(text).toContain('  Cost: free (no model) · a few seconds');
    expect(text).toContain('Plan: 1. check with the rules (free).');
    expect(text).toContain('> y\n* Running jurator check --no-ai');
    expect(text).toMatch(/\* Ran jurator check --no-ai: exit 1, \$0\.00\n {2}Check \S+ at [0-9a-f]{7}: 1 broken/u);
    expect(text).toContain('privacy.01 is BROKEN (rule, no AI). Next I would write a rule');
    expect(requests()[0]?.instructions).toContain('When the user gives a goal');
  });
});

describe('the card estimate', () => {
  it('rule propose for promises without a rule is paid and capped; ids must be accepted', async () => {
    const { session } = await open({});
    const ws = (session as unknown as { ws: Parameters<typeof buildAction>[1]['ws'] }).ws;
    const ok = buildAction({ command: 'rule propose', why: 'w' }, { ws, leftUsd: 0.5, id: 'a9', by: 'agent' });
    expect(ok.ok && ok.card).toMatchObject({ argv: ['rule', 'propose', '--all', '--budget', '0.50'], line: 'jurator rule propose --all', capUsd: 0.5, paid: true });
    expect(ok.ok && ok.card.estimate.highUsd).toBeLessThanOrEqual(0.5);
    const draft = buildAction({ command: 'rule propose', promiseIds: ['privacy.03'], why: 'w' }, { ws, leftUsd: 1, id: 'a9', by: 'agent' });
    expect(draft).toMatchObject({ ok: false, summary: 'not accepted: privacy.03' });
    const broke = buildAction({ command: 'check', why: 'w' }, { ws, leftUsd: 0, id: 'a9', by: 'agent' });
    expect(broke).toMatchObject({ ok: false, summary: 'refused: the session budget is spent' });
    const flag = buildAction({ command: 'check', diffBase: '--output=/tmp/x', why: 'w' }, { ws, leftUsd: 1, id: 'a9', by: 'agent' });
    expect(flag).toMatchObject({ ok: false, summary: 'bad input: diffBase' });
    // AC-I live try: the model sent diffBase "null" for a full check; that is no diff, not `--diff null`.
    for (const word of ['null', 'None', ' ']) {
      const full = buildAction({ command: 'check', diffBase: word, why: 'w' }, { ws, leftUsd: 1, id: 'a9', by: 'agent' });
      expect(full.ok && full.card.argv.includes('--diff'), word).toBe(false);
    }
    const main = buildAction({ command: 'check', diffBase: 'main', why: 'w' }, { ws, leftUsd: 1, id: 'a9', by: 'agent' });
    expect(main.ok && main.card.argv.slice(0, 3)).toEqual(['check', '--diff', 'main']);
  });
});
