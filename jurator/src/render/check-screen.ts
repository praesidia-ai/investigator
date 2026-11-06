// Owner: R4-UI2, HZ-1. The check screen in the new look: header (each repo's branch @ commit), a boxed finding per
// BROKEN promise (proved by a rule) and per LOOKS BROKEN (an AI hint), then one table for everything else with the
// promise's plain wording, summary cards and one Next. Each box starts with a plain summary (written by AI from the
// program's evidence, or by the program), then Found (path:line before each code line), To fix, the policy sentence
// once. Same facts as renderRunText (plain output and --json are unchanged).
import { basename } from 'node:path';
import { BRAND } from '../brand.js';
import type { CheckResult, CheckRun } from '../contracts.js';
import { findingRows, fromCheckResult, repoFacts, ruleLine, templateSummary, type ShortIds } from '../explain/index.js';
import type { BadgeKind, FindingRow, Ui } from '../ui/index.js';
import { bySeverity, incrementalLine, limitedNote, nextHint, policyWhere, shortRef, type RenderOptions } from './index.js';
import { modelLabel } from './video.js';

const short = (sha: string): string => sha.slice(0, 7);
const where = (r: CheckResult): string => {
  const c = r.citations[0];
  return c ? `${c.path}:${c.startLine}` : '';
};
const first = (s: string): string => (s.split('\n').find((l) => l.trim() !== '') ?? '').trim();
const sameIds: ShortIds = { short: (id) => id, full: (id) => id };

/** "acme-notes" or "investigator workspace · 2 repos" from the run itself. */
export function runWorkspace(run: CheckRun): string {
  const repos = (run.snapshot as { repos?: readonly unknown[] }).repos ?? [];
  const name = basename(run.snapshot.repo) || run.snapshot.repo;
  return repos.length > 0 ? `${name} workspace · ${repos.length} repo${repos.length === 1 ? '' : 's'}` : name;
}

function findingBox(ui: Ui, run: CheckRun, r: CheckResult, options: RenderOptions): string[] {
  const ids = options.ids ?? sameIds;
  const id = ids.short(r.promiseId);
  const finding = fromCheckResult(run, r, options.rules ?? []);
  if (!finding) return [];
  const summary = options.summaries?.get(r.promiseId) ?? templateSummary(finding, id);
  const extra: FindingRow[] = [];
  const was = r.citations.find((x) => x.commit !== run.target.head);
  if (was) {
    const ref = run.target.base ? shortRef(run.target.base) : short(was.commit);
    extra.push({ label: 'Was', text: `${was.path}:${was.startLine} on ${ref}`, tone: 'muted' });
    const line = first(was.quote);
    if (line) extra.push({ label: '', text: line, tone: 'code', lineNo: was.startLine });
  }
  if (r.trigger) extra.push({ label: 'Checked', text: `because the change ${r.trigger}`, tone: 'muted', maxLines: 2 });
  if (r.reused && !run.incremental?.skippedUnchanged) extra.push({ label: '', text: options.video ? '(reused)' : `(reused from ${r.reused.fromRun})`, tone: 'muted' });
  const failed = r.ruleResults?.find((x) => x.outcome === 'fail');
  const rule = failed ? options.rules?.find((x) => x.id === failed.ruleId) : undefined;
  const details: FindingRow[] = [];
  if (rule) {
    details.push({ label: 'Rule', text: `${rule.id} (${rule.mode}): ${ruleLine(rule)}`, maxLines: 3 });
    details.push({ label: 'Pattern', text: rule.pattern, maxLines: 4 });
  }
  const message = r.level === 'rule' ? (r.explanation ?? failed?.message) : undefined;
  if (message) details.push({ label: 'Message', text: message, tone: 'muted', maxLines: 3 });
  if (r.level === 'ai-read' && r.explanation) details.push({ label: 'AI read', text: r.explanation, tone: 'muted', maxLines: 4 });
  const kind: BadgeKind = r.verdict === 'broken' ? 'broken' : 'looks-broken';
  return ui.finding({
    kind,
    id,
    title: kind === 'broken' ? 'proved by a rule, no AI' : 'read by AI: a hint, does not block',
    rows: findingRows({ finding, summary, id, policyWhere: policyWhere(r.policyQuote, options.sources), extra, details, verbose: ui.caps.verbose }),
  });
}

export function renderRunScreen(run: CheckRun, ui: Ui, options: RenderOptions = {}): string[] {
  const out: string[] = [];
  const ids = options.ids ?? sameIds;
  const head = run.target.head;
  const touched = run.results.length + run.checklist.length;
  const count = `${touched} of ${run.summary.promises} promises ${run.target.kind === 'diff' ? 'touched' : 'checked'}`;
  // HZ-1 (backlog 17): each repo's branch @ commit, not the workspace's composite commit.
  const code = repoFacts(run.snapshot, head);
  const vs: Array<[string, string]> = run.target.kind === 'diff' ? [['vs', shortRef(run.target.base ?? '?')]] : [];
  out.push(
    ...ui.header({
      command: run.target.kind === 'diff' ? 'check --diff' : 'check',
      workspace: runWorkspace(run),
      model: options.model === undefined ? undefined : options.model ? modelLabel(options.model).replace(/^AI: /u, '') : 'no AI',
      facts: [...code, ...vs, ['', count], ['cost', `$${run.costUsd.toFixed(2)}${(options.summaryUsd ?? 0) >= 0.005 ? ` + $${(options.summaryUsd ?? 0).toFixed(2)} summaries` : ''}`], ['mode', run.failMode]],
    }),
  );
  if (run.snapshot.dirty && head === run.snapshot.commit) out.push(...ui.hint(`   Note: uncommitted changes are not checked; this run read commit ${short(head)}.`));
  const inc = incrementalLine(run, options);
  if (inc) out.push(...ui.hint(`   ${inc}`));

  const sorted = bySeverity(run.results);
  const boxed = sorted.filter((r) => r.verdict === 'broken' || r.verdict === 'looks-broken');
  const rest = sorted.filter((r) => r.verdict !== 'broken' && r.verdict !== 'looks-broken');
  for (const r of boxed) out.push('', ...findingBox(ui, run, r, options));

  if (rest.length > 0 || run.checklist.length > 0) {
    out.push(...ui.section(boxed.length > 0 ? 'Other results' : 'Results', `${rest.length + run.checklist.length}`));
    const rows: string[][] = [];
    const notes: Array<string | undefined> = [];
    for (const r of rest) {
      const parts: string[] = [];
      if (r.verdict === 'cant-tell') {
        const finding = fromCheckResult(run, r, options.rules ?? []);
        const s = options.summaries?.get(r.promiseId) ?? (finding ? templateSummary(finding, ids.short(r.promiseId)) : undefined);
        const text = s?.by === 'ai' ? s.summary : (r.explanation ?? r.reason ?? '');
        if (text) parts.push(`${text}${s?.by === 'ai' ? ' (summary by AI)' : ''}`);
      } else if (r.verdict === 'not-checked') parts.push(r.reason ?? 'not checked');
      else if (r.level === 'ai-read' && r.verdict === 'looks-kept' && where(r)) parts.push(`read by AI at ${where(r)}`);
      if (limitedNote(r)) parts.push(`${limitedNote(r)}${r.assurance?.warning ? `: ${r.assurance.warning}` : ''}`);
      if (r.trigger) parts.push(`checked because the change ${r.trigger}`);
      if (r.reused && !run.incremental?.skippedUnchanged && (parts.length > 0 || ui.caps.verbose)) parts.push('(reused)');
      rows.push([ui.badge(r.verdict as BadgeKind), ids.short(r.promiseId), r.wording]);
      notes.push(parts.length > 0 ? parts.join(' · ') : undefined);
    }
    for (const item of run.checklist) {
      rows.push([ui.tone(`${ui.caps.unicode ? '☐' : '[ ]'} BEFORE MERGE`, 'accent'), ids.short(item.promiseId), item.text.replace(/^Before merge:\s*/u, '')]);
      notes.push(undefined);
    }
    out.push(
      ...ui.table({
        columns: [{ header: 'Result', min: 10 }, { header: 'Promise', min: 6 }, { header: 'What it promises', flex: true, min: 20 }],
        rows,
        wrap: 2,
        notes,
        noteLines: 3,
      }),
    );
  }
  if (run.results.length === 0 && run.checklist.length === 0) {
    out.push('', ...ui.hint(run.target.kind === 'diff' ? '  No promise is touched by this change.' : '  No accepted promises to check.'));
  }
  if (run.status === 'incomplete') {
    out.push('', ui.line("Incomplete: some checks could not run (their reasons are above); they count as CAN'T TELL / NOT CHECKED.", 'accent'));
  }
  if (boxed.length > 0 && !ui.caps.verbose) out.push('', ...ui.hint(`  Details (rule, pattern, every line found): --verbose, or ${BRAND.command} explain ${ids.short(boxed[0]?.promiseId ?? '<promise>')}`));
  const s = run.summary;
  const limited = run.results.filter((r) => limitedNote(r) !== null).length;
  const holds = run.results.filter((r) => r.verdict === 'holds').length - limited;
  out.push('');
  out.push(
    ...ui.cards([
      { value: String(s.broken), label: s.broken > 0 && run.failMode === 'block' ? 'broken: blocks' : 'broken', tone: s.broken > 0 ? 'broken' : 'muted' },
      { value: String(holds), label: 'hold (rules)', tone: holds > 0 ? 'kept' : 'muted' },
      ...(limited > 0 ? [{ value: String(limited), label: 'hold, limited (known misses)', tone: 'accent' as const }] : []),
      { value: String(s.looksBroken + s.cantTell), label: 'AI hints', tone: s.looksBroken > 0 ? 'broken' : 'muted' },
      { value: `${s.coveredByRules}/${s.codePromises}`, label: 'covered by rules', tone: 'accent' },
    ]),
  );
  out.push(...ui.hint('  Re-check this record with no AI:'), ...ui.hint(`    ${BRAND.command} verify ${options.runPath ?? '<run.json>'}`));
  if (options.next !== false) out.push(...ui.next(nextHint(run, options)));
  return out;
}
