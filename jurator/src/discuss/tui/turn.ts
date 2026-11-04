// Owner: DS-B. One turn as the UI sees it: the events folded into tool lines, the answer, evidence, errors and cost,
// rendered either live (older tool lines folded to fit) or committed in full to the scrollback.
import type { Citation } from '../../contracts.js';
import type { ActionCard, DiscussEvent, PolicyEditCard, PolicyExcerpt, UnresolvedCite } from '../contract.js';
import {
  actionCardLines,
  actionRunLines,
  answerLines,
  cancelledLine,
  errorLines,
  evidenceLines,
  policyEditLines,
  toolLines,
  usageLine,
  type ActionRunView,
  type Look,
  type ToolView,
} from './view.js';

export class TurnModel {
  readonly question: string;
  readonly startedAt: number;
  turn = 0;
  round = 0;
  private readonly tools: ToolView[] = [];
  text = '';
  evidence: { citations: readonly Citation[]; policy: readonly PolicyExcerpt[]; unresolved: readonly UnresolvedCite[] } | null = null;
  readonly errors: Array<{ message: string; next?: string | undefined }> = [];
  inTokens = 0;
  outTokens = 0;
  usd = 0;
  done: { reason: 'answered' | 'cancelled' | 'error'; ms: number; usd: number } | null = null;
  /** DS-C: a confirmed run in this turn, and the cards the agent proposed (the last action card is the live one). */
  run: { card: ActionCard; lines: string[]; done: ActionRunView['done'] } | null = null;
  readonly cards: ActionCard[] = [];
  readonly edits: PolicyEditCard[] = [];

  constructor(question: string, startedAt: number) {
    this.question = question;
    this.startedAt = startedAt;
  }

  apply(e: DiscussEvent): void {
    switch (e.type) {
      case 'turn-start':
        this.turn = e.turn;
        return;
      case 'thinking':
        this.round = e.round;
        return;
      case 'tool-call':
        this.tools.push({ id: e.id, label: e.label });
        return;
      case 'tool-result': {
        const i = this.tools.findIndex((t) => t.id === e.id && !t.result);
        if (i >= 0) this.tools[i] = { ...(this.tools[i] as ToolView), result: e };
        else this.tools.push({ id: e.id, label: e.name, result: e });
        return;
      }
      case 'text':
        this.text = e.full !== undefined ? e.full : this.text + (e.delta ?? '');
        return;
      case 'evidence':
        this.evidence = { citations: e.citations, policy: e.policy, unresolved: e.unresolved };
        return;
      case 'usage':
        this.inTokens += e.in;
        this.outTokens += e.out;
        this.usd += e.usd;
        return;
      case 'error':
        this.errors.push({ message: e.message, next: e.next });
        return;
      case 'done':
        this.done = { reason: e.reason, ms: e.ms, usd: e.usd };
        return;
      case 'action-proposed':
        this.cards.push(e.action);
        return;
      case 'policy-edit-proposed':
        this.edits.push(e.edit);
        return;
      case 'action-start':
        this.run = { card: e.action, lines: [], done: null };
        return;
      case 'action-output':
        if (this.run) {
          this.run.lines.push(e.line);
          if (this.run.lines.length > 400) this.run.lines.splice(0, this.run.lines.length - 400);
        }
        return;
      case 'action-done':
        if (this.run) this.run.done = e;
        return;
    }
  }

  /** The cards of this turn, rendered; `waiting` marks the action card the session still holds. */
  private cardLines(look: Look, waitingId: string | null): string[] {
    const out: string[] = [];
    // Only the last action card counts (a new one replaces the one waiting).
    const card = this.cards[this.cards.length - 1];
    for (const e of this.edits) out.push('', ...policyEditLines(e, look));
    if (card) out.push('', ...actionCardLines(card, look, waitingId === card.id));
    return out;
  }

  /** What the status line says is happening now. */
  doing(): string {
    if (this.run && !this.run.done) return `running ${this.run.card.line}`;
    const pending = [...this.tools].reverse().find((t) => !t.result);
    if (pending) return pending.label;
    if (this.text) return 'writing the answer';
    return this.round > 1 ? `thinking (round ${this.round})` : 'thinking';
  }

  /** The whole turn, for the scrollback (after `done`). */
  lines(look: Look, snapshot: string, waitingId: string | null = null): string[] {
    const out: string[] = [];
    if (this.run) out.push('', ...actionRunLines(this.run, look));
    if (this.tools.length) out.push('');
    for (const t of this.tools) out.push(...toolLines(t, look));
    const cancelled = this.done?.reason === 'cancelled';
    if (this.text && !cancelled) out.push('', ...answerLines(this.text, look));
    if (this.evidence && !cancelled) out.push(...evidenceLines(this.evidence, look, snapshot));
    if (!cancelled) out.push(...this.cardLines(look, waitingId));
    if (this.errors.length) out.push('');
    for (const e of this.errors) out.push(...errorLines(e, look));
    if (cancelled) out.push('', cancelledLine(this.done?.ms ?? 0, look));
    if (this.done && (this.inTokens || this.usd)) out.push(usageLine({ in: this.inTokens, out: this.outTokens, usd: this.done.usd || this.usd }, look));
    out.push('');
    return out;
  }

  /** The running turn for the live region: at most `max` lines, older tool lines folded into "+N earlier". */
  liveLines(look: Look, spinner: string, max: number): string[] {
    const blocks = this.tools.map((t) => toolLines(t, look, spinner));
    if (this.run) blocks.unshift(actionRunLines(this.run, look, spinner, Math.max(2, Math.min(8, max - 6))));
    if (this.text) blocks.push(['', ...answerLines(this.text, look)]);
    let total = blocks.reduce((n, b) => n + b.length, 0) + 1;
    let folded = 0;
    while (blocks.length > 1 && total > max) {
      total -= (blocks.shift() as string[]).length;
      folded += 1;
    }
    const out = [''];
    if (folded) out.push(look.theme.muted(`  +${folded} earlier`));
    for (const b of blocks) out.push(...b);
    return out.length > max ? out.slice(out.length - max) : out;
  }
}
