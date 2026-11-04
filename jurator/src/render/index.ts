// Owner: WP-K. Text renderers for a CheckRun (terminal and Markdown for PR comments).
// The level decides the words: only a rule says HOLDS/BROKEN; an AI read says LOOKS KEPT/LOOKS BROKEN/CAN'T TELL.
import { BRAND } from '../brand.js';
import type { CheckResult, CheckRun, PolicyQuote, Verdict } from '../contracts.js';
import type { Style } from '../util/term.js';
import { modelLabel, VIDEO_WIDTH, videoFromEnv } from './video.js';

export interface RenderOptions {
  /** Path of the saved run.json, for the verify hint. */
  readonly runPath?: string;
  /** Source alias -> locator (e.g. 'security' -> 'docs/security.md'), to show where a policy quote lives. */
  readonly sources?: Readonly<Record<string, string>>;
  /** Promise ids whose last rule proposal said no rule is possible (.jurator/local/infeasible.json): no propose hint. */
  readonly infeasible?: readonly string[];
  /** Terminal width; longer lines are cut there (default 80, the width when not on a terminal). */
  readonly width?: number;
  /** false leaves out the Next line (a hook prints its own). */
  readonly next?: boolean;
  /** The verified pair before this run (from .jurator/local/verified.json), for the "what changed" line. */
  readonly since?: { readonly commit: string; readonly policyState: string; readonly runId: string } | null;
  /** The model behind the AI reads (null: none). Given, the header says "AI: <id> (live)" only for a live client. */
  readonly model?: { readonly id: string; readonly mode: 'live' | 'scripted' } | null;
  /** Video mode (default: JURATOR_VIDEO=1): 100 columns, no run ids in the bookkeeping lines. */
  readonly video?: boolean;
  /** HZ-1: plain summaries of the findings, by promise id (the new look only). */
  readonly summaries?: ReadonlyMap<string, import('../explain/index.js').Summary>;
  /** HZ-1: short ids for the screen (`doc.09`); JSON and records keep the full id. */
  readonly ids?: import('../explain/index.js').ShortIds;
  /** HZ-1: what the plain summaries cost (not part of the record's cost). */
  readonly summaryUsd?: number;
  /** HZ-1: the rules, for the plain line of what a failing rule checks. */
  readonly rules?: readonly import('../contracts.js').Rule[];
}

export const LABELS: Readonly<Record<Verdict, string>> = {
  holds: 'HOLDS (rule, no AI)',
  broken: 'BROKEN (rule, no AI)',
  'looks-kept': 'LOOKS KEPT (read by AI)',
  'looks-broken': 'LOOKS BROKEN (read by AI)',
  'cant-tell': "CAN'T TELL (read by AI)",
  'not-checked': 'NOT CHECKED',
};
const SYMBOLS: Readonly<Record<Verdict, string>> = {
  holds: '✓',
  broken: '✗',
  'looks-kept': '~',
  'looks-broken': '?',
  'cant-tell': '?',
  'not-checked': '·',
};

const SEVERITY: Readonly<Record<Verdict, number>> = {
  broken: 0,
  'looks-broken': 1,
  'cant-tell': 2,
  'not-checked': 3,
  'looks-kept': 4,
  holds: 5,
};
/** Worst first, then by promise id (the record itself stays sorted by id). */
export function bySeverity(results: readonly CheckResult[]): CheckResult[] {
  return [...results].sort((a, b) => SEVERITY[a.verdict] - SEVERITY[b.verdict] || a.promiseId.localeCompare(b.promiseId));
}

function paint(verdict: Verdict, style: Style): (s: string) => string {
  switch (verdict) {
    case 'holds':
      return style.green;
    case 'broken':
      return (s) => style.bold(style.red(s));
    case 'looks-kept':
      return (s) => style.dim(style.green(s));
    case 'looks-broken':
    case 'cant-tell':
      return style.yellow;
    default:
      return style.dim;
  }
}

const short = (sha: string): string => sha.slice(0, 7);
/** A full commit sha as 7 characters; branch names and short refs stay as they are. */
export function shortRef(ref: string): string {
  return /^[0-9a-f]{40,64}$/u.test(ref) ? short(ref) : ref;
}
function repoName(repo: string): string {
  return repo.split(/[\\/]/u).filter(Boolean).pop() ?? repo;
}
function money(usd: number): string {
  return usd > 0 && usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}
function oneLine(s: string, max = 72): string {
  const flat = s.replace(/\s+/gu, ' ').trim();
  if (max < 1) return '';
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
/** Words of `s` in lines of at most `max` characters; at most `lines` lines (the last one cut with …). */
function wrap(s: string, max: number, lines = 3): string[] {
  const words = s.replace(/\s+/gu, ' ').trim().split(' ').filter(Boolean);
  const out: string[] = [];
  let line = '';
  for (const word of words) {
    if (line && line.length + 1 + word.length > max) {
      out.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  if (line) out.push(line);
  const kept = out.slice(0, lines).map((l) => oneLine(l, max));
  if (out.length > lines) kept[lines - 1] = oneLine(out.slice(lines - 1).join(' '), max);
  return kept;
}
function firstQuoteLine(quote: string, max = 72): string {
  return oneLine(quote.split('\n').find((l) => l.trim().length > 0) ?? '', max);
}
export function policyWhere(quote: PolicyQuote, sources?: Readonly<Record<string, string>>): string {
  const file = sources?.[quote.alias] ?? quote.alias;
  if (quote.jsonPointer) return `${file}#${quote.jsonPointer}`;
  return quote.line ? `${file}:${quote.line}` : file;
}
/** A text quote in double quotes; a JSON setting (already a JSON value) as is. */
export function policyText(quote: PolicyQuote, max = 100): string {
  return quote.jsonPointer ? oneLine(quote.text, max) : `"${oneLine(quote.text, Math.max(1, max - 2))}"`;
}
function where(result: CheckResult): string {
  const c = result.citations[0];
  return c ? `${c.path}:${c.startLine}` : '';
}
function headerParts(run: CheckRun, options: Pick<RenderOptions, 'model'> = {}): string[] {
  const head = run.target.head;
  const onBranch = run.snapshot.branch && head === run.snapshot.commit;
  const at = onBranch ? `${run.snapshot.branch} @ ${short(head)}` : short(head);
  const touched = run.results.length + run.checklist.length;
  const scope = run.target.kind === 'diff' ? `${at} vs ${shortRef(run.target.base ?? '?')}` : at;
  const count =
    run.target.kind === 'diff'
      ? `${touched} of ${run.summary.promises} promises touched`
      : `${touched} of ${run.summary.promises} promises checked`;
  const ai = options.model === undefined ? [] : [modelLabel(options.model)];
  return [repoName(run.snapshot.repo), scope, count, ...ai, money(run.costUsd), `mode: ${run.failMode}`];
}
/**
 * The incremental line (WP-C): what changed since the last verified pair and how much was checked again, e.g.
 * "Policies 1a2b3c4 unchanged · code main..9f8e7d6: rechecked 2 of 11 promises, reused 9". null when there is nothing
 * to say (a first run).
 */
export function incrementalLine(run: CheckRun, options: Pick<RenderOptions, 'since' | 'video'> = {}): string | null {
  const inc = run.incremental;
  if (!inc) return null;
  const since = options.since ?? null;
  if (inc.skippedUnchanged) {
    if (options.video) return 'Nothing to recheck: code and policies unchanged since the last verified run.';
    const from = since?.runId ?? run.results.find((r) => r.reused)?.reused?.fromRun ?? 'before';
    return `Nothing to recheck: code and policies unchanged since run ${from}.`;
  }
  if (inc.reused === 0 && !since) return null;
  const ps = run.policyState ? short(run.policyState) : '?';
  const policies =
    !since || !run.policyState
      ? `Policies ${ps}`
      : since.policyState === run.policyState
        ? `Policies ${ps} unchanged`
        : `Policies changed (${short(since.policyState)} -> ${ps})`;
  const head = short(run.target.head);
  const from = run.target.kind === 'diff' ? shortRef(run.target.base ?? '?') : since ? short(since.commit) : null;
  const code = from === null ? `code ${head}` : from === head ? `code ${head} unchanged` : `code ${from}..${head}`;
  const n = inc.rechecked + inc.reused;
  return `${policies} · ${code}: rechecked ${inc.rechecked} of ${n} promise${n === 1 ? '' : 's'}, reused ${inc.reused}`;
}
/** "(reused from <run>)" for a reused result; nothing when the whole run was copied (the header says so). */
function reusedNote(run: CheckRun, r: CheckResult, video = false): string | null {
  if (!r.reused || run.incremental?.skippedUnchanged) return null;
  return video ? '(reused)' : `(reused from ${r.reused.fromRun})`;
}
function uncovered(run: CheckRun): string[] {
  return run.results
    .filter((r) => r.level !== 'rule' && !(r.ruleResults && r.ruleResults.length > 0))
    .map((r) => r.promiseId)
    .sort();
}
function verdictLine(run: CheckRun): string {
  const s = run.summary;
  const extra: string[] = [];
  if (s.looksBroken > 0) extra.push(`${s.looksBroken} look${s.looksBroken === 1 ? 's' : ''} broken (AI read, not blocking)`);
  if (s.cantTell > 0) extra.push(`${s.cantTell} can't tell`);
  if (s.notChecked > 0) extra.push(`${s.notChecked} not checked`);
  const tail = extra.length ? ` ${extra.join(', ')}.` : '';
  if (s.broken > 0) {
    return run.failMode === 'block'
      ? `Failed: ${s.broken} broken.${tail}`
      : `Found ${s.broken} broken (mode: ${run.failMode}, not blocking).${tail}`;
  }
  return `Passed: nothing broken.${tail}`;
}
/** One useful next step, worst problem first. */
export function nextHint(run: CheckRun, options: Pick<RenderOptions, 'infeasible'> = {}): string {
  const cmd = BRAND.command;
  const sorted = bySeverity(run.results);
  const infeasible = new Set(options.infeasible ?? []);
  const broken = sorted.find((r) => r.verdict === 'broken');
  if (broken) {
    const at = where(broken);
    return `Next: fix the code (${at || broken.promiseId}), or change the policy and run ${cmd} compile.`;
  }
  const looksBroken = sorted.find((r) => r.verdict === 'looks-broken');
  if (looksBroken) {
    const at = where(looksBroken);
    const rule = infeasible.has(looksBroken.promiseId) ? '' : `, or ${cmd} rule propose ${looksBroken.promiseId} to check it by a rule`;
    return `Next: look at ${looksBroken.promiseId}${at ? ` (${at})` : ''}: an AI hint, it does not block${rule}.`;
  }
  const propose = uncovered(run).find((id) => !infeasible.has(id));
  if (propose) return `Next: ${cmd} rule propose ${propose} (a rule checks it with no AI on every run)`;
  if (run.status === 'incomplete') return `Next: run ${cmd} check again; some checks could not run (reasons above).`;
  if (run.target.kind === 'diff' && run.checklist.length > 0) {
    return `Next: tick the "Before merge" items in the PR (${run.checklist.map((c) => c.promiseId).join(', ')}); nothing here blocks it.`;
  }
  return run.target.kind === 'diff'
    ? 'Next: push or open the PR; nothing here blocks it.'
    : `Next: check each change with ${cmd} check --diff main (or ${cmd} hook install pre-push).`;
}

/* ------------------------------ terminal ------------------------------ */

const BOX_MAX = 96;
const LABEL_W = 9; // 'Promise  '

/** The hero frame: one boxed block per BROKEN promise, with the policy quote, the code line and the rule. */
function brokenBlock(run: CheckRun, r: CheckResult, style: Style, options: RenderOptions, width: number): string[] {
  const boxW = Math.min(width, BOX_MAX);
  const textW = Math.max(10, boxW - 2 - LABEL_W);
  const red = (s: string): string => style.bold(style.red(s));
  const full = ` ${SYMBOLS.broken} BROKEN · ${r.promiseId} · proved by a rule, no AI `;
  const title = full.length + 4 <= boxW ? full : ` ${SYMBOLS.broken} BROKEN · ${r.promiseId} `;
  const head = `┏━${title}${'━'.repeat(Math.max(2, boxW - 2 - title.length))}`;
  const out: string[] = [red(head)];
  const row = (label: string, text: string, strong = false): void => {
    const body = strong ? style.bold(text) : text;
    out.push(`${red('┃')} ${style.dim(label.padEnd(LABEL_W))}${body}`);
  };
  const flat = (s: string): string => s.replace(/\s+/gu, ' ').trim();
  if (flat(r.wording) !== flat(r.policyQuote.text)) row('Promise', oneLine(r.wording, textW));
  const quote = policyText(r.policyQuote, textW);
  const at = policyWhere(r.policyQuote, options.sources);
  if (quote.length + 2 + at.length <= textW) row('Policy', `${quote}  ${style.dim(at)}`);
  else {
    row('Policy', quote);
    row('', style.dim(oneLine(at, textW)));
  }
  const atHead = r.citations.filter((x) => x.commit === run.target.head);
  const c = atHead[0];
  if (c) {
    const more = atHead.length > 1 ? `  (+${atHead.length - 1} more)` : '';
    row('Code', `${c.path}:${c.startLine}${more}`);
    const line = firstQuoteLine(c.quote, textW);
    if (line) row('', line, true);
  }
  const was = r.citations.find((x) => x.commit !== run.target.head);
  if (was) {
    const ref = run.target.base ? shortRef(run.target.base) : short(was.commit);
    const label = `${c && c.path === was.path ? `line ${was.startLine}` : `${was.path}:${was.startLine}`} on ${ref}`;
    const line = firstQuoteLine(was.quote, textW - label.length - 3);
    row('Was', line ? `${line}  ${style.dim(`(${label})`)}` : style.dim(label));
  }
  if (r.trigger) wrap(r.trigger, textW, 2).forEach((l, i) => row(i === 0 ? 'Why' : '', l));
  const message = r.explanation ?? r.ruleResults?.find((x) => x.outcome === 'fail')?.message;
  if (message) {
    const lines = wrap(message, textW);
    lines.forEach((l, i) => row(i === 0 ? 'Rule' : '', l));
  }
  const note = reusedNote(run, r, options.video === true);
  if (note) row('', style.dim(oneLine(note, textW)));
  out.push(red(`┗${'━'.repeat(Math.max(4, boxW - 1))}`));
  return out;
}

export function renderRunText(run: CheckRun, style: Style, options0: RenderOptions = {}): string {
  const video = options0.video ?? videoFromEnv();
  const options: RenderOptions = { ...options0, video };
  const width = video ? VIDEO_WIDTH : Math.max(40, Math.floor(options.width ?? 80));
  const out: string[] = [];
  const parts = [BRAND.command, ...headerParts(run, options)];
  if (parts.join(' · ').length <= width) out.push(style.bold(parts.join(' · ')));
  else out.push(style.bold(parts.slice(0, 3).join(' · ')), `  ${parts.slice(3).join(' · ')}`);
  if (run.snapshot.dirty && run.target.head === run.snapshot.commit) {
    out.push(style.dim(oneLine(`Note: uncommitted changes are not checked; this run read commit ${short(run.target.head)}.`, width)));
  }
  const inc = incrementalLine(run, options);
  if (inc && inc.length <= width) out.push(inc);
  else if (inc) {
    // Break after the code range ("... · code a..b" / "  rechecked ..."), or before "since run" on the fast path.
    const since = inc.indexOf(' since run ');
    const cut = since > 0 ? since : inc.indexOf(': ');
    const skip = since > 0 ? 1 : 2;
    if (cut > 0) out.push(oneLine(inc.slice(0, cut), width), `  ${oneLine(inc.slice(cut + skip), width - 2)}`);
    else out.push(oneLine(inc, width));
  }

  const sorted = bySeverity(run.results);
  const broken = sorted.filter((r) => r.verdict === 'broken');
  const rest = sorted.filter((r) => r.verdict !== 'broken');
  for (const r of broken) out.push('', ...brokenBlock(run, r, style, options, width));
  if (broken.length > 0 && (rest.length > 0 || run.checklist.length > 0)) out.push('');

  const idW = Math.max(0, ...rest.map((r) => r.promiseId.length), ...run.checklist.map((c) => c.promiseId.length));
  const labelW = Math.max(0, ...rest.map((r) => LABELS[r.verdict].length));
  const indentW = 2 + idW + 2;
  const indent = ' '.repeat(indentW);
  const restW = width - indentW - labelW - 2;
  const shortNotes = new Map<string, string[]>();
  for (const r of rest) {
    const color = paint(r.verdict, style);
    const label = LABELS[r.verdict];
    let tail = '';
    if (r.verdict === 'not-checked') tail = style.dim(oneLine(r.reason ?? 'not checked', restW));
    else {
      const w = where(r);
      const c = r.citations[0];
      if (w && c && r.verdict === 'looks-broken') {
        const room = restW - w.length - 2;
        tail = room > 8 ? `${w}  ${style.dim(firstQuoteLine(c.quote, room))}` : oneLine(w, restW);
      } else if (w) tail = oneLine(w, restW);
    }
    const rowText = `${color(SYMBOLS[r.verdict])} ${r.promiseId.padEnd(idW)}  ${color(label)}${tail ? ' '.repeat(labelW - label.length + 2) + tail : ''}`;
    // "(reused from <run>)" when it fits on the row; else "(reused)", named in one line under the list.
    const note = reusedNote(run, r, video);
    const plainLen = rowText.replace(/\u001b\[[0-9;]*m/gu, '').length;
    if (note && plainLen + note.length + 2 <= width && !video) out.push(`${rowText}  ${style.dim(note)}`);
    else if (note) {
      // Video: every reused row says "(reused)" and one line under the list counts them (no run ids).
      out.push(plainLen + 10 <= width ? `${rowText}  ${style.dim('(reused)')}` : rowText);
      const ids = shortNotes.get(r.reused?.fromRun ?? '') ?? [];
      ids.push(r.promiseId);
      shortNotes.set(r.reused?.fromRun ?? '', ids);
    } else out.push(rowText);
    if (r.trigger) out.push(`${indent}${style.dim(oneLine(r.trigger, width - indentW))}`);
    if (r.verdict === 'looks-broken') {
      const at = policyWhere(r.policyQuote, options.sources);
      const room = width - indentW - at.length - 3;
      out.push(room > 12 ? `${indent}${policyText(r.policyQuote, room)}   ${style.dim(at)}` : `${indent}${style.dim(oneLine(at, width - indentW))}`);
    }
    if (r.level === 'ai-read' && r.verdict !== 'looks-kept') {
      const why = r.reason ?? r.explanation;
      if (why) out.push(`${indent}${style.dim(oneLine(why, width - indentW))}`);
    }
  }
  if (video && shortNotes.size > 1) {
    // One count line in video mode, however many earlier runs the results came from.
    const all = [...shortNotes.values()].flat();
    shortNotes.clear();
    shortNotes.set('', all);
  }
  for (const [from, ids] of shortNotes) {
    const text = video
      ? `Reused ${ids.length} result${ids.length === 1 ? '' : 's'} from the last verified run (same code and rules, not checked again).`
      : `Reused from run ${from} (same code and rules, not checked again): ${ids.join(', ')}`;
    wrap(text, width - 2, 3).forEach((l, i) => out.push(style.dim(i === 0 ? l : `  ${l}`)));
  }
  for (const item of run.checklist) {
    out.push(`${style.blue('☐')} ${item.promiseId.padEnd(idW)}  ${oneLine(item.text, width - indentW)}`);
  }
  if (run.results.length === 0 && run.checklist.length === 0) {
    out.push(style.dim(run.target.kind === 'diff' ? 'No promise is touched by this change.' : 'No accepted promises to check.'));
  }
  out.push('', `Covered by rules: ${style.bold(`${run.summary.coveredByRules} of ${run.summary.codePromises}`)} code promises`);
  if (run.status === 'incomplete') {
    out.push(style.yellow("Incomplete: some checks could not run (their reasons are above); they count as CAN'T TELL / NOT CHECKED."));
  }
  const verdict = verdictLine(run);
  out.push(run.summary.broken > 0 && run.failMode === 'block' ? style.bold(style.red(verdict)) : verdict);
  const recheck = `Re-check this record with no AI: ${BRAND.command} verify ${options.runPath ?? '<run.json>'}`;
  if (video && recheck.length > width) {
    out.push(style.dim('Re-check this record with no AI:'), style.dim(`  ${BRAND.command} verify ${options.runPath ?? '<run.json>'}`));
  } else out.push(style.dim(recheck));
  if (options.next !== false) out.push(nextHint(run, options));
  return out.join('\n');
}

/* ------------------------------ Markdown (PR comments) ------------------------------ */

function cell(s: string): string {
  return s.replace(/\|/gu, '\\|').replace(/\s+/gu, ' ').trim();
}
function fence(text: string): string {
  const ticks = text.includes('```') ? '~~~~' : '```';
  return `${ticks}text\n${text}\n${ticks}`;
}

export function renderRunMarkdown(run: CheckRun, options: RenderOptions = {}): string {
  const s = run.summary;
  const title =
    s.broken > 0
      ? `### ✗ ${BRAND.name}: ${s.broken} promise${s.broken === 1 ? '' : 's'} broken`
      : s.looksBroken > 0
        ? `### ? ${BRAND.name}: nothing broken; ${s.looksBroken} look${s.looksBroken === 1 ? 's' : ''} broken (AI read)`
        : `### ✓ ${BRAND.name}: nothing broken`;
  const out: string[] = [title, '', headerParts(run, options).map((p, i) => (i < 2 ? `\`${p}\`` : p)).join(' · '), ''];
  const inc = incrementalLine(run, options);
  if (inc) out.push(inc, '');
  if (run.results.length > 0) {
    out.push('| | Promise | Result | Where |', '|---|---|---|---|');
    for (const r of bySeverity(run.results)) {
      const w = where(r);
      const plain = r.verdict === 'not-checked' ? `${LABELS[r.verdict]}: ${r.reason ?? ''}` : LABELS[r.verdict];
      const extras = [reusedNote(run, r), r.trigger ?? null].filter((x): x is string => x !== null);
      const result = extras.length > 0 ? `${plain} ${extras.join(' · ')}` : plain;
      const whereCell = w ? `\`${cell(w)}\`` : r.verdict === 'broken' && r.explanation ? cell(oneLine(r.explanation, 120)) : '';
      out.push(`| ${SYMBOLS[r.verdict]} | **${r.promiseId}** ${cell(r.wording)} | ${cell(result)} | ${whereCell} |`);
    }
    out.push('');
  } else {
    out.push(run.target.kind === 'diff' ? 'No promise is touched by this change.' : 'No accepted promises to check.', '');
  }
  const evidence = bySeverity(run.results).filter(
    (r) => r.verdict !== 'holds' && (r.citations.length > 0 || r.explanation || r.reason),
  );
  if (evidence.length > 0) {
    out.push(`<details><summary>Evidence (code quotes copied from git by ${BRAND.name}, not by the AI)</summary>`, '');
    for (const r of evidence) {
      out.push(`**${r.promiseId}** · ${LABELS[r.verdict]} · policy: ${policyText(r.policyQuote, 200)} (\`${policyWhere(r.policyQuote, options.sources)}\`)`, '');
      for (const c of r.citations.slice(0, 3)) {
        out.push(`\`${c.path}:${c.startLine}${c.endLine > c.startLine ? `-${c.endLine}` : ''}\` @ \`${short(c.commit)}\``, fence(c.quote), '');
      }
      if (r.explanation) out.push(`${r.level === 'ai-read' ? 'AI read' : 'Rule'}: ${oneLine(r.explanation, 400)}`, '');
      if (r.reason && r.verdict !== 'not-checked') out.push(`Note: ${oneLine(r.reason, 300)}`, '');
    }
    out.push('</details>', '');
  }
  if (run.checklist.length > 0) {
    out.push('**Before merge**', '');
    for (const item of run.checklist) out.push(`- [ ] **${item.promiseId}** ${item.text.replace(/^Before merge: /u, '')}`);
    out.push('');
  }
  out.push(
    `Covered by rules: ${s.coveredByRules} of ${s.codePromises} code promises. HOLDS/BROKEN come from rules (no AI); "read by AI" results are hints and never block.`,
  );
  if (run.status === 'incomplete') out.push('', "**Incomplete:** some checks could not run; they count as CAN'T TELL / NOT CHECKED.");
  out.push(
    '',
    `<sub>${verdictLine(run)} Record \`${run.id}\` · digest \`${run.digest.slice(0, 12)}\` · re-check with no AI: \`${BRAND.command} verify ${options.runPath ?? '<run.json>'}\`</sub>`,
  );
  return out.join('\n');
}
