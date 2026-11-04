// Owner: DS-B. The blocks of the discuss screen as `look -> lines`: header, user message, tool lines, evidence boxes,
// the answer, errors, slash results, the status line and the footer. Pure functions (tests snapshot them with colour
// off). Every line fits `look.width - 1` columns; the screen adds the final reset.
import type { Citation, Verdict } from '../../contracts.js';
import { BRAND } from '../../brand.js';
import { LABELS } from '../../render/index.js';
import type { Theme, Symbols } from '../../ui/theme.js';
import { duration, fit, money, padEnd, truncate, width as textWidth, wrap } from '../../ui/text.js';
import {
  DISCUSS_LIMITS,
  type ActionCard,
  type DiscussEvent,
  type PolicyEditCard,
  type PolicyExcerpt,
  type SessionInfo,
  type SlashResult,
  type UnresolvedCite,
} from '../contract.js';
import { estimateText } from '../actions/catalog.js';
import { clean, renderMarkdown } from './markdown.js';

export interface Look {
  readonly theme: Theme;
  readonly sym: Symbols;
  /** Terminal columns. Lines are kept to width - 1. */
  readonly width: number;
}

const short = (commit: string): string => commit.slice(0, 7);
const cols = (look: Look): number => Math.max(20, look.width - 1);

/** "11k", "620", "1.2k". */
export function tokens(n: number): string {
  if (n < 1000) return String(Math.round(n));
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  return `${Math.round(n / 1000)}k`;
}

function prefixed(lines: readonly string[], first: string, rest: string): string[] {
  return lines.map((l, i) => `${i === 0 ? first : rest}${l}`);
}

/* ------------------------------ header and footer ------------------------------ */

function tildePath(root: string, home: string | undefined): string {
  return home && (root === home || root.startsWith(`${home}/`)) ? `~${root.slice(home.length)}` : root;
}

function where(info: SessionInfo): string {
  if (info.repos.length > 1) return `${info.repos.length} repos at ${short(info.snapshot.commit)}`;
  const branch = info.snapshot.branch ?? info.repos[0]?.branch ?? null;
  return `${branch ?? 'detached'} at ${short(info.snapshot.commit)}`;
}

export function headerLines(info: SessionInfo, look: Look): string[] {
  const { theme, sym } = look;
  const w = cols(look);
  const mode = info.mode === 'scripted' ? ` ${sym.dot} ${theme.accent('scripted, no network')}` : '';
  const title = `${theme.accent(sym.mark)} ${theme.bold(`${BRAND.name} discuss`)} ${theme.muted(`${sym.dot} ${clean(info.name, true)} ${sym.dot} ${where(info)} ${sym.dot} ${info.modelId}`)}${mode}`;
  const out = [truncate(title, w)];
  // DS-C: a session that can run confirmed actions sets pendingAction (null when none waits); the fake does not.
  const actions = info.pendingAction !== undefined;
  const intro = actions
    ? 'I look things up and propose steps; nothing runs or changes without your yes. /help for keys.'
    : 'Read-only: I look things up and explain; only you run commands. /help for keys.';
  for (const l of wrap(intro, w - 2)) out.push(theme.muted(`  ${l}`));
  const lc = info.lastCheck;
  const promises = `${info.promises} promise${info.promises === 1 ? '' : 's'}`;
  if (!lc) out.push(truncate(theme.muted(`  ${promises} ${sym.dot} no check yet ${sym.dot} Next: ${BRAND.command} check`), w));
  else {
    const at = lc.createdAt.slice(11, 16);
    const counts = lc.broken + lc.looksBroken === 0 ? 'nothing broken' : [lc.broken ? `${lc.broken} broken` : '', lc.looksBroken ? `${lc.looksBroken} looks broken` : ''].filter(Boolean).join(', ');
    const stale = lc.stale ? theme.accent(` (older than this snapshot; Next: ${BRAND.command} check)`) : '';
    out.push(truncate(`${theme.muted(`  ${promises} ${sym.dot} last check ${at} at ${short(lc.commit)}: `)}${lc.broken + lc.looksBroken ? theme.broken(counts) : theme.kept(counts)}${stale}`, w));
  }
  if (info.snapshot.dirty) out.push(truncate(theme.muted(`  The working tree has changes; I read the commit ${short(info.snapshot.commit)}, not your edits.`), w));
  return out;
}

export function footerLines(info: SessionInfo, look: Look, home?: string): string[] {
  const { theme, sym } = look;
  const w = cols(look);
  const branch = info.repos.length > 1 ? `${info.repos.length} repos` : (info.snapshot.branch ?? info.repos[0]?.branch ?? 'detached');
  const line1 = theme.muted(truncate(`${tildePath(info.root, home)} (${branch}) ${sym.dot} snapshot ${short(info.snapshot.commit)}`, w));
  const ratio = info.budgetUsd > 0 ? info.spentUsd / info.budgetUsd : 0;
  const costText = `↑${tokens(info.inputTokens)} ↓${tokens(info.outputTokens)} ${sym.dot} ${money(info.spentUsd)} of ${money(info.budgetUsd)}`;
  const cost = ratio >= 1 ? theme.broken(costText) : ratio >= 0.8 ? theme.accent(costText) : theme.muted(costText);
  const right = theme.muted(`${info.modelId} ${sym.dot} /help`);
  const gap = w - textWidth(costText) - textWidth(right);
  const line2 = gap >= 2 ? `${cost}${' '.repeat(gap)}${right}` : truncate(`${cost}  ${right}`, w);
  return [line1, line2];
}

/* ------------------------------ messages ------------------------------ */

export function userLines(text: string, look: Look): string[] {
  const w = cols(look) - 2;
  const lines = clean(text).split('\n').flatMap((l) => wrap(l, w));
  return prefixed(lines, `${look.theme.accent('›')} `, '  ');
}

export function answerLines(text: string, look: Look): string[] {
  const body = renderMarkdown(text, { theme: look.theme, sym: look.sym, width: cols(look) - 2 });
  return prefixed(body.length ? body : [look.theme.muted('(no answer text)')], `${look.theme.accent(look.sym.mark)} `, '  ');
}

/** One evidence box: `path:lines · commit`, numbered lines, at most maxBoxLines. */
export function citationBox(c: Citation, look: Look, indent = '    '): string[] {
  const lines = clean(c.quote).split('\n');
  const count = c.endLine - c.startLine + 1;
  const body = lines.slice(0, Math.max(1, count)).map((text, i) => ({ no: c.startLine + i, text }));
  const range = c.endLine > c.startLine ? `${c.startLine}-${c.endLine}` : String(c.startLine);
  return box(`${clean(c.path, true)}:${range} ${look.sym.dot} ${short(c.commit)}`, body, look, indent);
}

export function policyBox(p: PolicyExcerpt, look: Look, indent = '    '): string[] {
  const body = clean(p.text).split('\n').map((text, i) => ({ no: p.startLine + i, text }));
  const range = p.endLine > p.startLine ? `${p.startLine}-${p.endLine}` : String(p.startLine);
  return box(`${clean(p.alias, true)} ${look.sym.dot} ${clean(p.where, true)}:${range}`, body, look, indent);
}

function box(title: string, body: ReadonlyArray<{ no: number; text: string }>, look: Look, indent: string): string[] {
  const { theme, sym } = look;
  const b = sym.round;
  const boxW = Math.max(20, Math.min(cols(look) - indent.length, 100));
  const inner = boxW - 4;
  const t = truncate(title, Math.max(4, boxW - 6));
  const top = `${theme.faint(`${b.tl} `)}${theme.muted(t)}${theme.faint(` ${b.h.repeat(Math.max(0, boxW - 4 - textWidth(t)))}${b.tr}`)}`;
  const shown = body.slice(0, DISCUSS_LIMITS.maxBoxLines);
  const noW = String(shown[shown.length - 1]?.no ?? 0).length;
  const mid = shown.map(({ no, text }) => {
    const num = String(no).padStart(noW);
    const content = `${theme.muted(num)}  ${truncate(text, inner - noW - 2)}`;
    return `${theme.faint(b.v)} ${padEnd(content, inner)} ${theme.faint(b.v)}`;
  });
  const more = body.length - shown.length;
  if (more > 0) mid.push(`${theme.faint(b.v)} ${padEnd(theme.muted(`${sym.ellipsis} ${more} more in the transcript`), inner)} ${theme.faint(b.v)}`);
  const bottom = theme.faint(`${b.bl}${b.h.repeat(boxW - 2)}${b.br}`);
  return [top, ...mid, bottom].map((l) => `${indent}${l}`);
}

/** What the UI keeps of a tool call while the turn runs (and in the committed turn). */
export interface ToolView {
  readonly id: string;
  readonly label: string;
  readonly result?: Extract<DiscussEvent, { type: 'tool-result' }>;
}

const BOXED = new Set(['read_lines', 'show_finding', 'explain_promise']);

export function toolLines(t: ToolView, look: Look, spinner?: string): string[] {
  const { theme, sym } = look;
  const w = cols(look);
  const label = clean(t.label, true);
  const r = t.result;
  if (!r) return [truncate(`  ${theme.accent(spinner ?? sym.running)} ${theme.muted(label)}`, w)];
  const cut = r.truncated ? ` ${sym.dot} cut at a limit` : '';
  const head = r.ok
    ? theme.muted(`  ${sym.running} ${label} ${sym.dot} ${clean(r.summary, true)}${cut} ${sym.dot} ${duration(r.ms)}`)
    : theme.broken(`  ${sym.failed} ${label} ${sym.dot} ${clean(r.summary, true)}`);
  const out = [truncate(head, w)];
  const ev = r.evidence ?? [];
  const shown = ev.slice(0, DISCUSS_LIMITS.maxEvidenceShown);
  if (BOXED.has(r.name)) for (const c of shown) out.push(...citationBox(c, look));
  else
    for (const c of shown) {
      const first = clean(c.quote).split('\n')[0] ?? '';
      out.push(truncate(`    ${theme.muted(`${clean(c.path, true)}:${c.startLine}`)}  ${first.trim()}`, w));
    }
  if (ev.length > shown.length) out.push(theme.muted(`    +${ev.length - shown.length} more in the transcript`));
  for (const p of (r.policy ?? []).slice(0, DISCUSS_LIMITS.maxEvidenceShown)) out.push(...policyBox(p, look));
  return out;
}

export function evidenceLines(
  e: { readonly citations: readonly Citation[]; readonly policy: readonly PolicyExcerpt[]; readonly unresolved: readonly UnresolvedCite[] },
  look: Look,
  snapshot: string,
): string[] {
  const { theme } = look;
  const out: string[] = [];
  if (e.citations.length || e.policy.length) {
    out.push('', theme.muted(`  Evidence, copied from git at ${short(snapshot)}`));
    for (const c of e.citations) out.push(...citationBox(c, look));
    for (const p of e.policy) out.push(...policyBox(p, look));
  }
  const reasons: Readonly<Record<UnresolvedCite['reason'], string>> = {
    'not-found': 'no such file at the snapshot',
    'secret-file': 'a secret file, never read',
    'out-of-range': 'out of range',
    'too-long': 'too many lines',
    'bad-marker': 'not a valid marker',
  };
  for (const u of e.unresolved) out.push(truncate(theme.accent(`  ! not verified: ${clean(u.marker, true)} (${reasons[u.reason]})`), cols(look)));
  return out;
}

export function errorLines(e: { readonly message: string; readonly next?: string | undefined }, look: Look, nextWord = 'Next'): string[] {
  const { theme, sym } = look;
  const body = wrap(clean(e.message), cols(look) - 4);
  const out = body.map((l, i) => `${i === 0 ? `  ${theme.broken(sym.failed)} ` : '    '}${theme.broken(l)}`);
  if (e.next) out.push(truncate(`    ${theme.accent(`${nextWord}: ${clean(e.next, true)}`)}`, cols(look)));
  return out;
}

export function usageLine(t: { in: number; out: number; usd: number }, look: Look): string {
  return look.theme.muted(`  ↑${tokens(t.in)} ↓${tokens(t.out)} ${look.sym.dot} ${money(t.usd)}`);
}

export function cancelledLine(ms: number, look: Look): string {
  return look.theme.muted(`  ${look.sym.skipped} stopped after ${duration(ms)}; the model forgets this turn (the transcript keeps it)`);
}

/* ------------------------------ status line ------------------------------ */

export function statusLine(s: { spinner: string; elapsedMs: number; doing: string }, look: Look): string {
  const { theme, sym } = look;
  return truncate(`${theme.accent(s.spinner)} ${theme.muted(`${duration(s.elapsedMs)} ${sym.dot} ${clean(s.doing, true)} ${sym.dot} Esc to stop`)}`, cols(look));
}

/* ------------------------------ slash results ------------------------------ */

function verdictPaint(v: Verdict | null, look: Look): (s: string) => string {
  if (v === 'broken' || v === 'looks-broken') return look.theme.broken;
  if (v === 'holds' || v === 'looks-kept') return look.theme.kept;
  return look.theme.muted;
}

export function slashLines(r: SlashResult, look: Look): string[] {
  const { theme, sym } = look;
  const w = cols(look);
  const m = theme.muted;
  const line = (s: string): string => truncate(s, w);
  switch (r.kind) {
    case 'help': {
      const nameW = Math.max(...r.commands.map((c) => textWidth(`/${c.name}${c.args ? ` ${c.args}` : ''}`)));
      const keyW = Math.max(0, ...r.keys.map((k) => textWidth(k.key)));
      return [
        m('  Commands (no model, no cost)'),
        ...r.commands.map((c) => line(`    ${theme.accent(padEnd(`/${c.name}${c.args ? ` ${c.args}` : ''}`, nameW))}  ${m(c.summary)}`)),
        m('  Keys'),
        ...r.keys.map((k) => line(`    ${padEnd(k.key, keyW)}  ${m(k.does)}`)),
      ];
    }
    case 'promises': {
      if (r.items.length === 0) return [m(`  No accepted promises yet. Next: ${BRAND.command} compile`)];
      const idW = Math.max(...r.items.map((p) => p.id.length));
      const labW = Math.max(...r.items.map((p) => (p.verdict ? LABELS[p.verdict] : 'no check yet').length));
      return [
        m(`  ${r.items.length} accepted promise${r.items.length === 1 ? '' : 's'}`),
        ...r.items.map((p) => {
          const label = p.verdict ? LABELS[p.verdict] : 'no check yet';
          return line(`    ${padEnd(p.id, idW)}  ${verdictPaint(p.verdict, look)(padEnd(label, labW))}  ${m(clean(p.wording, true))}`);
        }),
      ];
    }
    case 'findings': {
      const out: string[] = [];
      if (!r.run) out.push(m('  No check has run yet.'));
      else out.push(m(`  Last check ${r.run.createdAt.slice(0, 16).replace('T', ' ')} at ${short(r.run.commit)}${r.run.stale ? ' (older than this snapshot)' : ''}`));
      if (r.run && r.items.length === 0) out.push(theme.kept('    Nothing broken or unclear.'));
      for (const f of r.items) {
        out.push(line(`    ${theme.bold(f.promiseId)}  ${verdictPaint(f.verdict, look)(clean(f.label, true))}  ${m(clean(f.wording, true))}`));
        if (f.explanation) for (const l of wrap(clean(f.explanation), w - 6, 3)) out.push(m(`      ${l}`));
        for (const c of f.citations.slice(0, DISCUSS_LIMITS.maxEvidenceShown)) {
          out.push(line(`      ${m(`${clean(c.path, true)}:${c.startLine}`)}  ${(clean(c.quote).split('\n')[0] ?? '').trim()}`));
        }
      }
      if (r.next) out.push(theme.accent(`  Next: ${r.next}`));
      return out;
    }
    case 'explain': {
      const d = r.detail;
      const out = [
        line(`  ${theme.bold(d.row.id)} ${m(`${sym.dot} ${d.row.kind} ${sym.dot} checkable by ${d.row.checkable}`)}`),
        ...wrap(clean(d.row.wording), w - 4).map((l) => `    ${l}`),
        ...policyBox(d.policy, look),
      ];
      out.push(m(`  Rules: ${d.rules.length === 0 ? 'none' : ''}`));
      for (const rule of d.rules) out.push(line(`    ${rule.id}  ${m(`${rule.status} ${sym.dot} ${rule.mode}${rule.provenToFail ? ` ${sym.dot} proven able to fail` : ''}`)}  ${clean(rule.description, true)}`));
      if (d.bindings.length) out.push(m('  Bound code:'));
      for (const b of d.bindings) {
        if (b.citation) out.push(...citationBox(b.citation, look));
        else out.push(theme.accent(`    ${b.id}${b.symbol ? ` (${b.symbol})` : ''}: ${b.moved ? 'the bound text moved' : 'not found at the snapshot'}`));
      }
      if (d.finding) out.push(line(`  Last check: ${verdictPaint(d.finding.verdict, look)(clean(d.finding.label, true))}`));
      return out;
    }
    case 'rule': {
      if (r.rules.length === 0) return [m(`  ${r.promiseId} has no rules.`), ...(r.next ? [theme.accent(`  Next: ${r.next}`)] : [])];
      return [
        m(`  Rules of ${r.promiseId}`),
        ...r.rules.flatMap((rule) => [
          line(`    ${theme.bold(rule.id)}  ${m(`${rule.status} ${sym.dot} ${rule.mode} ${sym.dot} ${rule.provenToFail ? 'proven able to fail' : 'not proven to fail'}`)}`),
          line(`      ${clean(rule.description, true)}`),
          line(m(`      in ${rule.globs.join(', ')}`)),
        ]),
        ...(r.next ? [theme.accent(`  Next: ${r.next}`)] : []),
      ];
    }
    case 'model':
      return [m(r.changed ? `  Model is now ${r.modelId}. The conversation is kept; its hidden reasoning state was dropped.` : `  Model: ${r.modelId} (/model wonder|spark to switch)`)];
    case 'cost': {
      const out = [m(`  Cost this session: ${money(r.totalUsd)} of ${money(r.budgetUsd)} ${sym.dot} ↑${tokens(r.in)} ↓${tokens(r.out)}`)];
      for (const t of r.turns) out.push(line(m(`    ${String(t.turn).padStart(2)}  ${fit(money(t.usd), 8, 'right')}  ↑${tokens(t.in)} ↓${tokens(t.out)}  ${clean(t.question, true)}`)));
      return out;
    }
    case 'budget':
      return [m(`  Budget ${money(r.budgetUsd)} ${sym.dot} ${money(r.spentUsd)} spent${r.changed ? ' (changed)' : ''}`)];
    case 'saved':
      return [m(`  Transcript written: ${clean(r.path, true)}`)];
    case 'cleared':
      return [m('  Fresh conversation: the model forgot what was said. The cost so far stays.')];
    case 'exit':
      return [];
    case 'error':
      return errorLines({ message: r.message, next: r.usage }, look, 'Usage');
    case 'declined':
      return [m(`  ${sym.skipped} Skipped: ${clean(r.action.line, true)} (nothing ran; I'll be told you said no)`)];
    case 'decision': {
      const ok = r.exitCode === 0;
      const out = [line(`  ${ok ? theme.kept(sym.done) : theme.broken(sym.failed)} ${theme.bold('You ran')} ${clean(r.line, true)} ${m(`${sym.dot} exit ${r.exitCode}`)}`)];
      out.push(m('    What changed (from the records):'));
      for (const c of r.changes) out.push(...wrap(clean(c), w - 6).map((l) => `      ${l}`));
      if (!ok) for (const o of r.output.slice(-4)) out.push(line(m(`      ${clean(o, true)}`)));
      if (r.next) out.push(theme.accent(`  Next: ${clean(r.next, true)}`));
      return out;
    }
    case 'applied':
      return [
        line(`  ${theme.kept(sym.done)} Wrote ${clean(r.edit.path, true)}:${r.edit.startLine}-${r.edit.endLine} ${m('(the policy file now has the new wording)')}`),
        ...(r.next ? ['', ...actionCardLines(r.next, look)] : []),
      ];
  }
}

/* ------------------------------ DS-C: cards and runs ------------------------------ */

/** Box lines with a title and plain (already painted) rows. */
function plainBox(title: string, rows: readonly string[], look: Look, indent = '  '): string[] {
  const { theme, sym } = look;
  const b = sym.round;
  const boxW = Math.max(24, Math.min(cols(look) - indent.length, 100));
  const inner = boxW - 4;
  const t = truncate(title, Math.max(4, boxW - 6));
  const top = `${theme.faint(`${b.tl} `)}${t}${theme.faint(` ${b.h.repeat(Math.max(0, boxW - 4 - textWidth(t)))}${b.tr}`)}`;
  const mid = rows.map((r) => `${theme.faint(b.v)} ${padEnd(truncate(r, inner), inner)} ${theme.faint(b.v)}`);
  const bottom = theme.faint(`${b.bl}${b.h.repeat(boxW - 2)}${b.br}`);
  return [top, ...mid, bottom].map((l) => `${indent}${l}`);
}

/** The action card: what runs, why, the estimate, and the keys. */
export function actionCardLines(card: ActionCard, look: Look, waiting = true): string[] {
  const { theme } = look;
  const inner = Math.max(20, Math.min(cols(look) - 2, 100) - 4);
  const who = card.by === 'program' ? 'Next step' : 'Proposed action';
  const rows = [
    theme.bold(clean(card.line, true)),
    ...wrap(`Why: ${clean(card.why)}`, inner).map((l) => theme.muted(l)),
    `${card.paid ? theme.accent('Cost') : theme.muted('Cost')}: ${estimateText(card)}`,
    ...wrap(clean(card.estimate.basis), inner).map((l) => theme.muted(l)),
  ];
  if (card.capUsd !== null) rows.push(theme.muted(`Stops at $${card.capUsd.toFixed(2)} (your session budget left, or the run budget).`));
  if (waiting) rows.push(`${theme.accent('Enter')} or ${theme.accent('y')} to run ${theme.muted('·')} ${theme.accent('n')} or ${theme.accent('Esc')} to skip`);
  return plainBox(`${theme.accent(who)}${card.by === 'program' ? theme.muted(' (offered by the program)') : theme.muted(' (by AI; runs only if you say yes)')}`, rows, look);
}

/** The proposed policy edit: the program's diff of the file, the agent's reason, and how to apply it. */
export function policyEditLines(edit: PolicyEditCard, look: Look): string[] {
  const { theme } = look;
  const inner = Math.max(20, Math.min(cols(look) - 2, 100) - 4);
  const rows: string[] = [];
  for (const l of clean(edit.before).split('\n')) rows.push(...wrap(`- ${l}`, inner).map((x) => theme.broken(x)));
  for (const l of clean(edit.after).split('\n')) rows.push(...wrap(`+ ${l}`, inner).map((x) => theme.kept(x)));
  rows.push(...wrap(`Why: ${clean(edit.why)}`, inner).map((l) => theme.muted(l)));
  rows.push(`${theme.accent('/apply')} writes it ${theme.muted('·')} then compile re-reads the policy ${theme.muted('· new lines are AI wording')}`);
  const range = edit.endLine > edit.startLine ? `${edit.startLine}-${edit.endLine}` : String(edit.startLine);
  return plainBox(`${theme.accent('Proposed policy edit')} ${theme.muted(`${clean(edit.path, true)}:${range}`)}`, rows, look);
}

export interface ActionRunView {
  readonly card: ActionCard;
  readonly lines: readonly string[];
  readonly done: Extract<DiscussEvent, { type: 'action-done' }> | null;
}

/** A confirmed run: live, the last output lines under a spinner; finished, the outcome and what changed. */
export function actionRunLines(run: ActionRunView, look: Look, spinner?: string, tail = 6): string[] {
  const { theme, sym } = look;
  const w = cols(look);
  const out: string[] = [];
  const d = run.done;
  if (!d) {
    out.push(truncate(`  ${theme.accent(spinner ?? sym.running)} ${theme.bold('Running')} ${clean(run.card.line, true)}`, w));
    const shown = run.lines.filter((l) => l.trim() !== '').slice(-tail);
    for (const l of shown) out.push(truncate(theme.muted(`    ${clean(l, true)}`), w));
    return out;
  }
  const ok = d.exitCode === 0 || (d.exitCode === 1 && run.card.command === 'check');
  const words = d.exitCode === 0 ? 'ok' : d.exitCode === 1 ? (run.card.command === 'check' ? 'a promise is broken' : 'found something') : 'failed';
  out.push(truncate(`  ${ok ? theme.kept(sym.done) : theme.broken(sym.failed)} ${theme.bold('Ran')} ${clean(d.line, true)} ${theme.muted(`${sym.dot} exit ${d.exitCode} (${words}) ${sym.dot} ${duration(d.ms)} ${sym.dot} ${money(d.usd)}`)}`, w));
  for (const l of d.summary) out.push(...wrap(clean(l), w - 6).map((x, i) => (i === 0 ? `    ${x}` : `      ${x}`)));
  if (d.exitCode >= 2) for (const l of run.lines.filter((x) => x.trim() !== '').slice(-4)) out.push(truncate(theme.muted(`    ${clean(l, true)}`), w));
  return out;
}
