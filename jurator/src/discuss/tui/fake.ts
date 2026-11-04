// Owner: DS-B. A fake `DiscussSession` that replays the contract's EXAMPLE_TURN (renumbered) with small delays, so
// the interface can be driven, tested and recorded without the agent core, a store or the network. It never reads
// files or calls a model. Questions containing "budget" end in a BUDGET error; "fail" makes a tool fail.
// Reached from the CLI only with JURATOR_DISCUSS_FAKE=1 (the header then says "scripted, no network").
import {
  DISCUSS_MODEL_IDS,
  DISCUSS_SLASH_COMMANDS,
  EXAMPLE_TURN,
  completeSlash,
  type DiscussEvent,
  type DiscussModel,
  type DiscussSession,
  type SessionInfo,
  type SlashResult,
  type TurnCost,
} from '../contract.js';
import { DISCUSS_KEYS } from './keys.js';

export interface FakeSessionOptions {
  /** Pause between events in ms (0 in tests). */
  readonly delayMs?: number;
  readonly budgetUsd?: number;
  readonly model?: DiscussModel;
  readonly root?: string;
  readonly transcriptPath?: string | null;
}

const COMMIT = '9f3c2a1e0b7d4c6a8e2f1a3b5c7d9e0f1a2b3c4d';

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(done, ms);
    function done(): void {
      clearTimeout(t);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

export function createFakeSession(options: FakeSessionOptions = {}): DiscussSession {
  const delay = options.delayMs ?? 0;
  let model: DiscussModel = options.model ?? 'wonder';
  let budget = options.budgetUsd ?? 3;
  let spent = 0;
  let inTok = 0;
  let outTok = 0;
  let turns = 0;
  let busy = false;
  const costs: TurnCost[] = [];
  const root = options.root ?? '/home/you/investigator';
  const transcriptPath = options.transcriptPath === undefined ? `${root}/.jurator/local/discuss/2026-11-04T11-30-00.md` : options.transcriptPath;

  const info = (): SessionInfo => ({
    root,
    name: root.split('/').pop() ?? root,
    repos: [{ name: '', branch: 'main', commit: COMMIT, dirty: false }],
    snapshot: { repo: root, branch: 'main', commit: COMMIT, dirty: false },
    model,
    modelId: DISCUSS_MODEL_IDS[model],
    mode: 'scripted',
    budgetUsd: budget,
    spentUsd: spent,
    inputTokens: inTok,
    outputTokens: outTok,
    promises: 14,
    lastCheck: { id: 'run-1', createdAt: '2026-11-04T10:02:00.000Z', commit: COMMIT, stale: false, broken: 2, looksBroken: 1 },
    transcriptPath,
    busy,
    turns,
  });

  async function* send(text: string, signal: AbortSignal): AsyncGenerator<DiscussEvent> {
    const turn = turns + 1;
    if (busy) {
      yield { type: 'error', turn, code: 'BUSY', message: 'A turn is already running.' };
      yield { type: 'done', turn, reason: 'error', ms: 0, usd: 0 };
      return;
    }
    busy = true;
    turns = turn;
    const started = Date.now();
    let usd = 0;
    let tokIn = 0;
    let tokOut = 0;
    try {
      for (const e0 of EXAMPLE_TURN) {
        if (signal.aborted) break;
        if (e0.type === 'done') break;
        let e: DiscussEvent = { ...e0, turn } as DiscussEvent;
        if (e.type === 'tool-call' || e.type === 'tool-result') e = { ...e, id: `${e.id}-${turn}` };
        if (e.type === 'tool-result' && /fail/iu.test(text) && e.name === 'read_lines') {
          e = { type: 'tool-result', turn, id: e.id, name: e.name, ok: false, summary: 'refused: .env files are never read', ms: 2 };
        }
        if (e.type === 'usage') {
          if (spent + e.usd > budget) {
            yield { type: 'error', turn, code: 'BUDGET', message: `This call could pass the session budget of $${budget.toFixed(2)}; nothing was sent.`, next: `/budget ${Math.ceil(budget + 2)}` };
            yield { type: 'done', turn, reason: 'error', ms: Date.now() - started, usd };
            return;
          }
          usd += e.usd;
          spent += e.usd;
          tokIn += e.in;
          tokOut += e.out;
          inTok += e.in;
          outTok += e.out;
          e = { ...e, totalUsd: spent, budgetUsd: budget };
        }
        if (e.type === 'thinking' && /budget/iu.test(text)) {
          yield e;
          yield { type: 'error', turn, code: 'BUDGET', message: `The next call could pass the session budget of $${budget.toFixed(2)}; nothing was sent.`, next: `/budget ${Math.ceil(budget + 2)}` };
          yield { type: 'done', turn, reason: 'error', ms: Date.now() - started, usd };
          return;
        }
        yield e;
        await sleep(e.type === 'thinking' ? delay * 4 : delay, signal);
      }
      if (signal.aborted) {
        yield { type: 'done', turn, reason: 'cancelled', ms: Date.now() - started, usd };
        return;
      }
      costs.push({ turn, question: text, in: tokIn, out: tokOut, usd });
      yield { type: 'done', turn, reason: 'answered', ms: Date.now() - started, usd };
    } finally {
      busy = false;
    }
  }

  async function slash(line: string): Promise<SlashResult> {
    const [word = '', ...args] = line.trim().replace(/^\//u, '').split(/\s+/u);
    const known = DISCUSS_SLASH_COMMANDS.find((c) => c.name === word);
    if (!known) {
      const close = completeSlash(word.slice(0, 2)).map((c) => `/${c.name}`);
      return { kind: 'error', code: 'UNKNOWN_COMMAND', message: `Unknown command /${word}.${close.length ? ` Did you mean ${close.join(', ')}?` : ''}`, usage: '/help' };
    }
    switch (known.name) {
      case 'help':
        return { kind: 'help', commands: DISCUSS_SLASH_COMMANDS, keys: DISCUSS_KEYS };
      case 'promises':
        return {
          kind: 'promises',
          items: [
            { id: 'privacy.01', wording: 'Support chats are deleted after 30 days.', kind: 'must', checkable: 'code', rules: 1, bindings: 1, verdict: 'broken' },
            { id: 'privacy.02', wording: 'Documents are never sent to third parties.', kind: 'must-not', checkable: 'code', rules: 0, bindings: 0, verdict: 'looks-broken' },
            { id: 'security.01', wording: 'Admin routes require an admin session.', kind: 'must', checkable: 'code', rules: 1, bindings: 2, verdict: 'holds' },
          ],
        };
      case 'findings':
        return {
          kind: 'findings',
          run: { id: 'run-1', createdAt: '2026-11-04T10:02:00.000Z', commit: COMMIT, stale: false },
          items: [
            {
              promiseId: 'privacy.01',
              wording: 'Support chats are deleted after 30 days.',
              verdict: 'broken',
              level: 'rule',
              label: 'BROKEN (rule, no AI)',
              explanation: 'CHAT_TTL_DAYS is 90.',
              citations: [{ path: 'backend/app/config.py', commit: COMMIT, startLine: 12, endLine: 12, quote: 'CHAT_TTL_DAYS = 90' }],
            },
          ],
        };
      case 'rule':
        if (!args[0]) return { kind: 'error', code: 'BAD_INPUT', message: '/rule needs a promise id or a rule id.', usage: '/rule <promise id | rule id>' };
        return { kind: 'rule', promiseId: args[0], rules: [], next: `jurator rule propose ${args[0]}` };
      case 'explain':
        if (!args[0]) return { kind: 'error', code: 'BAD_INPUT', message: '/explain needs a promise id.', usage: '/explain <promise id>' };
        return { kind: 'error', code: 'NOT_FOUND', message: `No promise ${args[0]} in the fake session.` };
      case 'model': {
        const want = args[0];
        if (want === undefined) return { kind: 'model', model, modelId: DISCUSS_MODEL_IDS[model], changed: false };
        if (want !== 'wonder' && want !== 'spark') return { kind: 'error', code: 'BAD_INPUT', message: `No model "${want}".`, usage: '/model wonder|spark' };
        const changed = want !== model;
        model = want;
        return { kind: 'model', model, modelId: DISCUSS_MODEL_IDS[model], changed };
      }
      case 'cost':
        return { kind: 'cost', turns: costs, in: inTok, out: outTok, totalUsd: spent, budgetUsd: budget };
      case 'budget': {
        if (args[0] === undefined) return { kind: 'budget', budgetUsd: budget, spentUsd: spent, changed: false };
        const n = Number(args[0]);
        if (!Number.isFinite(n) || n <= 0) return { kind: 'error', code: 'BAD_INPUT', message: `"${args[0]}" is not an amount in dollars.`, usage: '/budget <usd>' };
        budget = Math.max(n, spent);
        return { kind: 'budget', budgetUsd: budget, spentUsd: spent, changed: true };
      }
      case 'save':
        return transcriptPath ? { kind: 'saved', path: transcriptPath } : { kind: 'error', code: 'NO_SAVE', message: 'This session does not save a transcript (--no-save).' };
      case 'clear':
        return { kind: 'cleared' };
      default:
        return { kind: 'exit' };
    }
  }

  return { info, send, slash, close: async () => undefined };
}
