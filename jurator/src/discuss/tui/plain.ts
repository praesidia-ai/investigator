// Owner: DS-B. Plain mode (`--plain`, or stdin/stdout not a terminal): one stdin line per turn or command, the answer
// on stdout, no ANSI, spinner or editor. `--json`: one NDJSON event per line, slash results as
// {"type":"slash","result":…}. EOF exits 0. SIGINT cancels the running turn; a second one exits 130.
import { money } from '../../ui/text.js';
import { makeTheme, UNICODE } from '../../ui/theme.js';
import { canRunActions, isSlashLine, type DiscussEvent, type DiscussSession, type UnresolvedCite } from '../contract.js';
import { estimateText } from '../actions/catalog.js';
import { clean } from './markdown.js';
import { slashLines } from './view.js';

export interface PlainIo {
  /** Input lines (readline over stdin, or an array in tests). */
  readonly lines: AsyncIterable<string>;
  readonly write: (s: string) => void;
  /** Where the transcript path goes at the end (stderr), so stdout keeps only the conversation. */
  readonly note: (s: string) => void;
  /** Registers the Ctrl-C handler; returns its removal. */
  readonly onInterrupt?: ((fn: () => void) => () => void) | undefined;
  /** Exit at once (a second Ctrl-C). */
  readonly exit?: ((code: number) => void) | undefined;
}

export interface PlainOptions {
  readonly json: boolean;
  /** DS-C: `jurator discuss "<goal>"`: sent as the first message. */
  readonly goal?: string | undefined;
  /** Echo each input line as `> line` (default true; off in JSON mode). */
  readonly echo?: boolean | undefined;
}

/** "$0.059" for a turn (three decimals; four under a cent). */
const turnMoney = (usd: number): string => (usd > 0 && usd < 0.01 ? money(usd) : `$${usd.toFixed(3)}`);

const REASONS: Readonly<Record<UnresolvedCite['reason'], string>> = {
  'not-found': 'no such file at the snapshot',
  'secret-file': 'a secret file, never read',
  'out-of-range': 'out of range',
  'too-long': 'too many lines',
  'bad-marker': 'not a valid marker',
};

/** The plain lines for one event (empty: nothing to print). */
export function plainEventLines(e: DiscussEvent, labels: Map<string, string>): string[] {
  switch (e.type) {
    case 'tool-call':
      labels.set(e.id, clean(e.label, true));
      return [];
    case 'tool-result': {
      const label = labels.get(e.id) ?? e.name;
      return [`${e.ok ? '-' : 'x'} ${label}: ${clean(e.summary, true)}${e.truncated ? ' (cut at a limit)' : ''}`];
    }
    case 'text':
      return e.full !== undefined ? [clean(e.full)] : [];
    case 'evidence': {
      const out: string[] = [];
      for (const c of e.citations) {
        const lines = clean(c.quote).split('\n').slice(0, Math.max(1, c.endLine - c.startLine + 1));
        lines.forEach((text, i) => out.push(`  ${clean(c.path, true)}:${c.startLine + i} @ ${c.commit} | ${text}`));
      }
      for (const p of e.policy) {
        clean(p.text)
          .split('\n')
          .forEach((text, i) => out.push(`  ${clean(p.alias, true)} ${clean(p.where, true)}:${p.startLine + i} | ${text}`));
      }
      for (const u of e.unresolved) out.push(`  ! not verified: ${clean(u.marker, true)} (${REASONS[u.reason]})`);
      return out;
    }
    case 'error':
      return [`Error: ${clean(e.message, true)}`, ...(e.next ? [`Next: ${clean(e.next, true)}`] : [])];
    case 'action-proposed': {
      const a = e.action;
      return [
        `? Proposed action${a.by === 'program' ? ' (offered by the program)' : ' (by AI)'}: ${clean(a.line, true)}`,
        `  Why: ${clean(a.why, true)}`,
        `  Cost: ${estimateText(a)} (${clean(a.estimate.basis, true)})`,
        '  Type y to run it, n to skip it.',
      ];
    }
    case 'policy-edit-proposed': {
      const d = e.edit;
      return [
        `? Proposed policy edit (AI wording): ${clean(d.path, true)}:${d.startLine}-${d.endLine}`,
        ...clean(d.diff).split('\n').map((l) => `  ${l}`),
        `  Why: ${clean(d.why, true)}`,
        '  Type /apply to write it.',
      ];
    }
    case 'action-start':
      return [`* Running ${clean(e.action.line, true)}`];
    case 'action-output':
      return e.line.trim() ? [`  | ${clean(e.line, true)}`] : [];
    case 'action-done':
      return [`* Ran ${clean(e.line, true)}: exit ${e.exitCode}, ${money(e.usd)}`, ...e.summary.map((l) => `  ${clean(l, true)}`)];
    default:
      return [];
  }
}

/** Plain mode answers a card with a y or n line (Enter on an empty line does nothing here). */
const plainKeys = (line: string): string => line.replace('Enter or y to run · n or Esc to skip', 'Type y to run it, n to skip it.');

export async function runPlain(session: DiscussSession, io: PlainIo, options: PlainOptions): Promise<number> {
  const json = options.json;
  const echo = options.echo ?? !json;
  const look = { theme: makeTheme('none'), sym: UNICODE, width: 100 };
  const out = (line: string): void => io.write(`${line}\n`);
  let current: AbortController | null = null;
  let interrupts = 0;
  const remove = io.onInterrupt?.(() => {
    interrupts += 1;
    if (current && !current.signal.aborted && interrupts === 1) current.abort();
    else (io.exit ?? (() => undefined))(130);
  });
  // The iterator is made now, before the goal's turn runs: readline drops lines that arrive with no reader yet.
  const lines = io.lines[Symbol.asyncIterator]();
  async function* inputs(): AsyncGenerator<string> {
    if (options.goal && options.goal.trim()) yield options.goal.trim();
    for (;;) {
      const next = await lines.next();
      if (next.done) return;
      yield next.value;
    }
  }
  try {
    for await (const raw of inputs()) {
      const line = raw.replace(/\r$/u, '');
      if (line.trim() === '') continue;
      interrupts = 0;
      if (echo) out(`> ${clean(line, true)}`);
      const card = canRunActions(session) ? (session.info().pendingAction ?? null) : null;
      const answer = line.trim().toLowerCase();
      const yes = card !== null && (answer === 'y' || answer === 'yes' || answer === '/run');
      const no = card !== null && (answer === 'n' || answer === 'no');
      if (no) {
        const result = await session.slash('/no');
        if (json) out(JSON.stringify({ type: 'slash', result }));
        else for (const l of slashLines(result, look)) out(l.replace(/^ {2}/u, ''));
        continue;
      }
      if (!yes && isSlashLine(line)) {
        const result = await session.slash(line.trim());
        if (json) out(JSON.stringify({ type: 'slash', result }));
        else for (const l of slashLines(result, look)) out(plainKeys(l).replace(/^ {2}/u, ''));
        if (result.kind === 'exit') break;
        continue;
      }
      const labels = new Map<string, string>();
      current = new AbortController();
      let usd = 0;
      const events: AsyncIterable<DiscussEvent> = yes && canRunActions(session) ? session.confirm(current.signal) : session.send(line, current.signal);
      for await (const e of events) {
        if (json) {
          out(JSON.stringify(e));
          continue;
        }
        for (const l of plainEventLines(e, labels)) out(l);
        if (e.type === 'done') {
          usd = e.usd;
          const info = session.info();
          const total = `${money(info.spentUsd)} of ${money(info.budgetUsd)}`;
          out(e.reason === 'cancelled' ? `(stopped; ${turnMoney(usd)} this turn, ${total})` : `(${turnMoney(usd)} this turn, ${total})`);
        }
      }
      current = null;
    }
  } finally {
    remove?.();
    await session.close();
  }
  const path = session.info().transcriptPath;
  if (path && !json) io.note(`Transcript: ${path}`);
  return 0;
}
