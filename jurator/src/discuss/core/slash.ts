// Owner: DS-A. Slash commands: no model, no cost, structured results the UI renders. Read-only like everything else.
import { BRAND } from '../../brand.js';
import type { ChatBudget } from '../../model/chat.js';
import {
  DISCUSS_DECISION_COMMANDS,
  DISCUSS_MODEL_IDS,
  DISCUSS_SLASH_COMMANDS,
  type ActionCard,
  type DiscussModel,
  type SlashResult,
  type TurnCost,
} from '../contract.js';
import type { CodeReader } from '../tools/code-reader.js';
import { findingRows, findPromise, promiseDetail, promiseRows, ruleRow } from './records.js';
import type { DiscussWorkspace } from './workspace.js';

export interface SlashHost {
  readonly ws: DiscussWorkspace;
  readonly code: CodeReader;
  readonly busy: boolean;
  readonly model: DiscussModel;
  readonly budget: ChatBudget;
  readonly costs: readonly TurnCost[];
  readonly tokens: { in: number; out: number };
  readonly transcriptPath: string | null;
  switchModel(model: DiscussModel): void;
  setBudget(usd: number): void;
  clearHistory(): void;
  saveNow(): Promise<string | null>;
  /** DS-C */
  readonly pendingAction: ActionCard | null;
  decline(): Promise<SlashResult>;
  decide(argv: readonly string[]): Promise<SlashResult>;
  applyEdit(): Promise<SlashResult>;
}

const cmd = BRAND.command;

/** The keys of the interface, for /help (DS-B implements them; the words live here so both sides agree). */
export const DISCUSS_KEYS: ReadonlyArray<{ key: string; does: string }> = [
  { key: 'Enter', does: 'Send (a line starting with / runs a command)' },
  { key: 'Alt+Enter, Shift+Enter, Ctrl-J', does: 'New line' },
  { key: 'Up / Down', does: 'Move between lines; at the first or last line, earlier questions' },
  { key: 'Esc', does: 'Stop the answer; with nothing running, clear the input' },
  { key: 'Ctrl-C', does: 'Stop the answer, clear the input, or press twice to exit' },
  { key: 'Ctrl-D', does: 'Exit when the input is empty' },
  { key: 'Ctrl-L', does: 'Clear the screen and redraw' },
  { key: 'Tab', does: 'Complete a command' },
  { key: 'Enter or y / n or Esc', does: 'With an action card waiting and the input empty: run it / skip it' },
];

/** Every command, single words only (`rule accept` is `/rule` with `accept` as its first argument). */
const ALL_COMMANDS = [...DISCUSS_SLASH_COMMANDS, ...DISCUSS_DECISION_COMMANDS.filter((c) => !c.name.includes(' '))];

function usageOf(name: string): string {
  const c = [...DISCUSS_SLASH_COMMANDS, ...DISCUSS_DECISION_COMMANDS].find((x) => x.name === name);
  return c ? `/${c.name}${c.args ? ` ${c.args}` : ''}` : `/${name}`;
}

/** Exact name, or a prefix only one command has ('/pro' -> promises). Decisions need their full name. */
function commandFor(word: string): string | null {
  const w = word.toLowerCase();
  if (ALL_COMMANDS.some((c) => c.name === w)) return w;
  const hits = DISCUSS_SLASH_COMMANDS.filter((c) => c.name.startsWith(w));
  return hits.length === 1 ? (hits[0]?.name ?? null) : null;
}

/** Promise or rule ids from '/accept a.01 a.02,a.03' (or --all). */
function idsOf(arg: string): string[] {
  return arg.split(/[\s,]+/u).filter(Boolean);
}
const ID = /^[\w.:-]{1,80}$/u;

export async function runSlash(line: string, host: SlashHost): Promise<SlashResult> {
  const m = /^\s*\/([A-Za-z][\w-]*)\s*(.*)$/su.exec(line);
  if (!m) return { kind: 'error', code: 'UNKNOWN_COMMAND', message: 'Commands start with /, e.g. /help.', usage: '/help' };
  const name = commandFor(m[1] ?? '');
  const arg = (m[2] ?? '').trim();
  if (!name) {
    return { kind: 'error', code: 'UNKNOWN_COMMAND', message: `There is no command /${m[1] ?? ''}. /help lists them.`, usage: '/help' };
  }
  const ws = host.ws;
  switch (name) {
    case 'help':
      return { kind: 'help', commands: [...DISCUSS_SLASH_COMMANDS, ...DISCUSS_DECISION_COMMANDS], keys: DISCUSS_KEYS };
    case 'run':
      // The interface runs the card itself (it streams); reaching here means there is nothing to run.
      return host.pendingAction
        ? { kind: 'error', code: 'BAD_INPUT', message: `Press Enter or y to run ${host.pendingAction.line}.` }
        : { kind: 'error', code: 'NOT_FOUND', message: 'Nothing is waiting to run.' };
    case 'no':
      return host.decline();
    case 'accept': {
      const ids = idsOf(arg);
      if (ids.length === 0) return { kind: 'error', code: 'BAD_INPUT', message: 'Which promises? e.g. /accept privacy.03 privacy.04, or /accept --all', usage: usageOf('accept') };
      if (ids.includes('--all')) return host.decide(['accept', '--all']);
      const bad = ids.find((id) => !ID.test(id));
      if (bad) return { kind: 'error', code: 'BAD_INPUT', message: `${bad} is not a promise id.`, usage: usageOf('accept') };
      await ws.reload();
      const unknown = ids.filter((id) => !findPromise(ws, id));
      if (unknown.length) return { kind: 'error', code: 'NOT_FOUND', message: `There is no promise ${unknown.join(', ')}. /promises lists them.`, usage: usageOf('accept') };
      return host.decide(['accept', ...ids]);
    }
    case 'apply':
      return host.applyEdit();
    case 'promises':
      await ws.reload();
      return { kind: 'promises', items: promiseRows(ws) };
    case 'findings': {
      await ws.reload();
      const run = ws.data.lastRun;
      if (!run) return { kind: 'findings', run: null, items: [], next: `${cmd} check` };
      const stale = ws.isStale(run);
      return {
        kind: 'findings',
        run: { id: run.id, createdAt: run.createdAt, commit: run.snapshot.commit, stale },
        items: await findingRows(ws, host.code),
        ...(stale ? { next: `${cmd} check` } : {}),
      };
    }
    case 'explain': {
      if (!arg) return { kind: 'error', code: 'BAD_INPUT', message: 'Which promise? e.g. /explain privacy.01', usage: usageOf('explain') };
      await ws.reload();
      const p = findPromise(ws, arg);
      if (!p) return { kind: 'error', code: 'NOT_FOUND', message: `There is no promise ${arg}. /promises lists them.`, usage: usageOf('explain') };
      return { kind: 'explain', detail: await promiseDetail(ws, host.code, p) };
    }
    case 'rule': {
      if (!arg) return { kind: 'error', code: 'BAD_INPUT', message: 'Which promise or rule? e.g. /rule privacy.01', usage: usageOf('rule') };
      const accept = /^accept(?:\s+(.*))?$/u.exec(arg);
      if (accept) {
        const target = (accept[1] ?? '').trim();
        if (!target) return { kind: 'error', code: 'BAD_INPUT', message: 'Which rule? e.g. /rule accept R-privacy.01-1, or /rule accept --all', usage: usageOf('rule accept') };
        if (target === '--all') return host.decide(['rule', 'accept', '--all']);
        if (!ID.test(target)) return { kind: 'error', code: 'BAD_INPUT', message: `${target} is not a rule id.`, usage: usageOf('rule accept') };
        await ws.reload();
        if (!ws.data.rules.some((r) => r.id === target)) return { kind: 'error', code: 'NOT_FOUND', message: `There is no rule ${target}. /rule <promise id> lists a promise's rules.` };
        return host.decide(['rule', 'accept', target]);
      }
      await ws.reload();
      const byRule = ws.data.rules.find((r) => r.id === arg);
      const promiseId = byRule ? byRule.promiseId : arg;
      if (!byRule && !findPromise(ws, promiseId)) {
        return { kind: 'error', code: 'NOT_FOUND', message: `There is no promise or rule ${arg}.`, usage: usageOf('rule') };
      }
      const rules = byRule ? [byRule] : ws.data.rules.filter((r) => r.promiseId === promiseId);
      return {
        kind: 'rule',
        promiseId,
        rules: rules.map(ruleRow),
        ...(rules.some((r) => r.status === 'accepted') ? {} : { next: `${cmd} rule propose ${promiseId}` }),
      };
    }
    case 'model': {
      if (!arg) return { kind: 'model', model: host.model, modelId: DISCUSS_MODEL_IDS[host.model], changed: false };
      const want = arg.toLowerCase();
      if (want !== 'wonder' && want !== 'spark') {
        return { kind: 'error', code: 'BAD_INPUT', message: `The models are wonder and spark, not ${arg}.`, usage: usageOf('model') };
      }
      if (host.busy) return { kind: 'error', code: 'BUSY', message: 'Wait for the answer (or press Esc) before switching the model.' };
      const changed = want !== host.model;
      host.switchModel(want);
      return { kind: 'model', model: want, modelId: DISCUSS_MODEL_IDS[want], changed };
    }
    case 'cost':
      return {
        kind: 'cost',
        turns: host.costs,
        in: host.tokens.in,
        out: host.tokens.out,
        totalUsd: host.budget.spentUsd,
        budgetUsd: host.budget.budgetUsd,
      };
    case 'budget': {
      const b = host.budget;
      if (!arg) return { kind: 'budget', budgetUsd: b.budgetUsd, spentUsd: b.spentUsd, changed: false };
      const n = Number(arg.replace(/^\$/u, ''));
      if (!Number.isFinite(n) || n <= 0) {
        return { kind: 'error', code: 'BAD_INPUT', message: `A budget is an amount in USD above 0, such as 5, not ${arg}.`, usage: usageOf('budget') };
      }
      if (n < b.spentUsd) {
        return {
          kind: 'error',
          code: 'BAD_INPUT',
          message: `This session already spent $${b.spentUsd.toFixed(2)}; the budget cannot go below that.`,
          usage: usageOf('budget'),
        };
      }
      const changed = n !== b.budgetUsd;
      host.setBudget(n);
      return { kind: 'budget', budgetUsd: n, spentUsd: b.spentUsd, changed };
    }
    case 'save': {
      const path = await host.saveNow();
      if (!path) return { kind: 'error', code: 'NO_SAVE', message: 'This session was started with --no-save, so there is no transcript.' };
      return { kind: 'saved', path };
    }
    case 'clear':
      if (host.busy) return { kind: 'error', code: 'BUSY', message: 'Wait for the answer (or press Esc) before clearing.' };
      host.clearHistory();
      return { kind: 'cleared' };
    case 'exit':
      return { kind: 'exit' };
    default:
      return { kind: 'error', code: 'UNKNOWN_COMMAND', message: `There is no command /${name}.`, usage: '/help' };
  }
}
