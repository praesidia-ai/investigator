// Owner: DS-C. The commands the agent may propose, the decisions it may not, and the program-made action card: the argv
// (the agent never writes flags), the line the user would type, and the estimated cost and time.
import { BRAND } from '../../brand.js';
import { priceFor } from '../../model/cost.js';
import { DISCUSS_ACTION_COMMANDS, type ActionCard, type DiscussActionCommand } from '../contract.js';
import type { DiscussWorkspace } from '../core/workspace.js';

const cmd = BRAND.command;

/** What the agent asks for (the propose_action tool's arguments, already checked by zod). */
export interface ActionRequest {
  readonly command: string;
  readonly promiseIds?: readonly string[] | undefined;
  readonly diffBase?: string | undefined;
  readonly noAi?: boolean | undefined;
  readonly why: string;
}

/** Decisions only the user makes: the words the agent hears back, naming the slash command to draft instead. */
const DECISIONS: ReadonlyArray<{ readonly match: RegExp; readonly say: string }> = [
  { match: /^rule\s+accept\b/u, say: 'Accepting a rule is the user\'s decision, never an action. Draft it for them: "type `/rule accept <rule id>`".' },
  { match: /^(accept|accept[-_ ]promises?)\b/u, say: 'Accepting promises is the user\'s decision, never an action. Draft it for them: "type `/accept <ids>`" (it shows exactly what changes).' },
  { match: /^waive\b/u, say: 'Waiving a promise is the user\'s decision, never an action, and discuss has no waive. Explain the trade-off and let them decide.' },
  { match: /^conflicts?\b/u, say: `Ruling on a conflict is the user's decision. Draft the command for their shell: \`${cmd} conflicts --rule <C-n> --as real|not-a-conflict --why "…"\`.` },
  { match: /^(add|edit|policy|reword|write)\b/u, say: 'Policy edits are the user\'s decision. Draft new wording with propose_policy_edit; the user applies it with /apply.' },
];

export type BuildResult = { readonly ok: true; readonly card: ActionCard } | { readonly ok: false; readonly summary: string; readonly text: string };

const refuse = (summary: string, text: string): BuildResult => ({ ok: false, summary, text });

/** A git ref for --diff: letters, digits and ./_-~^ only, never an option. */
const REF = /^(?!-)[\w./~^-]{1,100}$/u;

function normalise(command: string): string {
  return command
    .trim()
    .toLowerCase()
    .replace(new RegExp(`^${BRAND.command}\\s+`, 'u'), '')
    .replace(/[_-]+/gu, ' ')
    .replace(/\s+/gu, ' ');
}

/** "$0.04", "$0.12", "$1.50". */
export function usd(n: number): string {
  if (n === 0) return '$0';
  if (n < 0.01) return '<$0.01';
  return `$${n.toFixed(2)}`;
}

/** "20 s", "2 min". */
export function secs(n: number): string {
  if (n < 90) return `${Math.max(1, Math.round(n))} s`;
  return `${Math.round(n / 60)} min`;
}

/** "about $0.04-0.16 · 20 s-2 min" (or "free · a few seconds"). */
export function estimateText(card: Pick<ActionCard, 'paid' | 'estimate'>): string {
  const e = card.estimate;
  const money = !card.paid || e.highUsd === 0 ? 'free (no model)' : `about ${usd(e.lowUsd)}-${usd(e.highUsd).replace('$', '')}`;
  const time = e.highSeconds <= 10 ? 'a few seconds' : `${secs(e.lowSeconds)}-${secs(e.highSeconds)}`;
  return `${money} · ${time}`;
}

interface Unit {
  /** Input and output tokens of one model call for one item. */
  readonly inTokens: number;
  readonly outTokens: number;
}

function unitUsd(modelId: string, u: Unit): number {
  const p = priceFor(modelId);
  return (u.inTokens * p.input + u.outTokens * p.output) / 1_000_000;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

export interface CardContext {
  readonly ws: DiscussWorkspace;
  /** Session budget left (USD); paid runs are capped at it. */
  readonly leftUsd: number;
  readonly id: string;
  readonly by: 'agent' | 'program';
  /** Characters of the locked policy texts (for the compile estimate); unknown: 6000 per source. */
  readonly policyChars?: number | undefined;
}

/** Builds the card for an agent's request, or the refusal it reads back. Never runs anything. */
export function buildAction(req: ActionRequest, ctx: CardContext): BuildResult {
  const words = normalise(req.command);
  for (const d of DECISIONS) if (d.match.test(words)) return refuse(`refused: ${words.split(' ')[0] === 'rule' ? 'rule accept' : words.split(' ')[0]} is the user's decision`, d.say);
  const command = (DISCUSS_ACTION_COMMANDS as readonly string[]).find((c) => c === words || (c === 'rule propose' && words === 'rule'));
  if (!command) {
    return refuse(
      `refused: ${words.slice(0, 40)} is not an action`,
      `"${req.command}" is not a command you can propose. You can propose: ${DISCUSS_ACTION_COMMANDS.join(', ')}.`,
    );
  }
  const c = command as DiscussActionCommand;
  const { ws } = ctx;
  const data = ws.data;
  const model = data.config.model.id;
  const runBudget = data.config.budgetUsdPerRun;
  const ids = [...new Set((req.promiseIds ?? []).map((s) => s.trim()).filter(Boolean))];
  const known = new Set(data.promises.map((p) => p.id));
  const unknown = ids.filter((id) => !known.has(id));
  if (unknown.length) return refuse(`no promise ${unknown[0]}`, `There is no promise ${unknown.join(', ')}. Call list_promises (status "all") for the ids.`);
  const accepted = ws.accepted();
  const ruled = new Set(data.rules.filter((r) => r.status === 'accepted').map((r) => r.promiseId));
  const code = accepted.filter((p) => p.checkable === 'code');

  let argv: string[] = [];
  let paid = false;
  let n = 0;
  let unit: Unit = { inTokens: 0, outTokens: 0 };
  let seconds: [number, number] = [1, 8];
  let basis = 'no model calls';
  let takesBudget = false;
  switch (c) {
    case 'init':
      return refuse('refused: already set up', `This folder already has ${BRAND.folder}/; init is not needed. Propose pull or compile instead.`);
    case 'status':
      argv = ['status'];
      break;
    case 'pull':
      argv = ['pull'];
      seconds = [1, 20];
      basis = 'fetches the policy sources again (read-only connectors)';
      break;
    case 'report':
      argv = ['report'];
      seconds = [1, 10];
      basis = 'writes the HTML report of the last check';
      break;
    case 'explain': {
      if (ids.length !== 1) return refuse('bad input: explain takes one promise id', 'explain takes exactly one promise id in promiseIds.');
      argv = ['explain', ids[0] as string];
      paid = true;
      n = 1;
      unit = { inTokens: 3000, outTokens: 400 };
      seconds = [2, 20];
      basis = 'one short AI summary (cached when seen before)';
      break;
    }
    case 'compile': {
      argv = ['compile'];
      paid = true;
      takesBudget = true;
      n = Math.max(1, data.config.sources.length);
      const chars = ctx.policyChars ?? 6000 * n;
      unit = { inTokens: Math.ceil(chars / Math.max(1, n) / 3) + 4000, outTokens: 8000 };
      seconds = [20 * n, 120 * n];
      basis = `${n} polic${n === 1 ? 'y' : 'ies'} drafted into promises (drafts wait for your /accept)`;
      break;
    }
    case 'rule propose': {
      const targets = ids.length ? ids : code.filter((p) => !ruled.has(p.id)).map((p) => p.id);
      const notAccepted = ids.filter((id) => !accepted.some((p) => p.id === id));
      if (notAccepted.length) return refuse(`not accepted: ${notAccepted[0]}`, `${notAccepted.join(', ')} is not accepted yet; rules are written for accepted promises. The user accepts with /accept <ids>.`);
      if (targets.length === 0) return refuse('nothing to write', 'Every accepted code promise already has an accepted rule. Name promiseIds to write another.');
      argv = ['rule', 'propose', ids.length ? ids.join(',') : '--all'];
      paid = true;
      takesBudget = true;
      n = targets.length;
      unit = { inTokens: 14000, outTokens: 3000 };
      seconds = [10 + 6 * n, 40 + 30 * n];
      basis = `a rule drafted and proven able to fail for ${n} promise${n === 1 ? '' : 's'} (proposed rules wait for your /rule accept)`;
      break;
    }
    case 'bind': {
      if (ids.length > 1) return refuse('bad input: bind takes one id or all', 'bind takes one promise id, or none for all accepted promises.');
      argv = ['bind', ids[0] ?? '--all'];
      paid = true;
      takesBudget = true;
      n = ids.length ? 1 : Math.max(1, code.length);
      unit = { inTokens: 6000, outTokens: 800 };
      seconds = [5 + 2 * n, 20 + 12 * n];
      basis = `finds where ${n === 1 ? 'the promise lives' : `${n} promises live`} in code`;
      break;
    }
    case 'check': {
      // AC-I: a model that means "no diff" sometimes sends a placeholder word ("null", "none") instead of leaving it out.
      const diffBase = req.diffBase === undefined || /^\s*(null|none|undefined)?\s*$/iu.test(req.diffBase) ? undefined : req.diffBase.trim();
      if (diffBase !== undefined && !REF.test(diffBase)) return refuse('bad input: diffBase', `"${diffBase}" is not a git ref.`);
      argv = ['check', ...(diffBase ? ['--diff', diffBase] : []), ...(req.noAi ? ['--no-ai'] : [])];
      takesBudget = !req.noAi;
      const unruled = code.filter((p) => !ruled.has(p.id)).length;
      paid = !req.noAi && unruled > 0;
      n = req.noAi ? 0 : unruled;
      unit = { inTokens: 8000, outTokens: 1000 };
      seconds = [3 + n, 10 + 8 * n];
      const rules = code.length - unruled;
      basis = req.noAi
        ? `${rules} promise${rules === 1 ? '' : 's'} checked by rules (no AI)`
        : `${rules} by rules (no AI), ${unruled} read by AI${data.lastRun ? ` · last check cost ${usd(data.lastRun.costUsd)}` : ''}`;
      break;
    }
  }
  const each = unitUsd(model, unit);
  let low = paid ? round2(n * each * 0.5) : 0;
  let high = paid ? round2(Math.max(0.01, n * each * 2)) : 0;
  if (c === 'check' && paid && data.lastRun && data.lastRun.costUsd > 0) {
    low = round2(Math.min(low, data.lastRun.costUsd * 0.5));
    high = round2(Math.max(high, data.lastRun.costUsd * 1.5));
  }
  let capUsd: number | null = null;
  if (paid && takesBudget) {
    const left = Math.floor(Math.max(0, ctx.leftUsd) * 100) / 100;
    if (left < 0.01) return refuse('refused: the session budget is spent', 'The session budget is spent, so no paid action can run. Tell the user: /budget <usd> raises it.');
    capUsd = round2(Math.min(runBudget, left));
    argv.push('--budget', capUsd.toFixed(2));
    if (high > capUsd) high = capUsd;
    if (low > high) low = high;
  }
  const shown = takesBudget && capUsd !== null ? argv.slice(0, -2) : argv;
  const card: ActionCard = {
    id: ctx.id,
    command: c,
    argv,
    line: `${cmd} ${shown.join(' ')}`,
    why: req.why.trim().slice(0, 400),
    by: ctx.by,
    paid: paid && high > 0,
    estimate: { lowUsd: low, highUsd: high, lowSeconds: seconds[0], highSeconds: seconds[1], basis },
    capUsd,
  };
  return { ok: true, card };
}
