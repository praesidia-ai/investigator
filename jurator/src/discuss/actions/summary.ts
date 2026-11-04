// Owner: DS-C. What a run changed, made by the program from the .jurator/ records before and after (never from the
// command's printed text, whose layout other areas own): new check findings, new or changed draft promises, proposed
// or accepted rules, bindings. These lines go to the screen and, as data, to the agent.
import { BRAND } from '../../brand.js';
import type { CheckRun, PromiseRecord, Rule } from '../../contracts.js';
import { bySeverity, LABELS } from '../../render/index.js';
import type { DiscussWorkspace } from '../core/workspace.js';

const cmd = BRAND.command;

export interface RecordsBefore {
  readonly promises: ReadonlyMap<string, Pick<PromiseRecord, 'status' | 'wording'>>;
  readonly rules: ReadonlyMap<string, Pick<Rule, 'status' | 'description'>>;
  readonly bindings: number;
  readonly runId: string | null;
}

export function recordsOf(ws: DiscussWorkspace): RecordsBefore {
  const d = ws.data;
  return {
    promises: new Map(d.promises.map((p) => [p.id, { status: p.status, wording: p.wording }] as const)),
    rules: new Map(d.rules.map((r) => [r.id, { status: r.status, description: r.description }] as const)),
    bindings: d.bindings.length,
    runId: d.lastRun?.id ?? null,
  };
}

const one = (s: string, max = 140): string => {
  const flat = s.replace(/\s+/gu, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? '' : 's'}`;

/** The findings of a run, worst first, one line each (verdict words from src/render LABELS). */
export function runLines(run: CheckRun, max = 12): string[] {
  const s = run.summary;
  const counts = [
    s.broken ? `${s.broken} broken` : '',
    s.looksBroken ? `${s.looksBroken} looks broken` : '',
    s.cantTell ? `${s.cantTell} can't tell` : '',
    s.holds ? `${s.holds} holds` : '',
    s.looksKept ? `${s.looksKept} looks kept` : '',
    s.notChecked ? `${s.notChecked} not checked` : '',
  ].filter(Boolean);
  const out = [`Check ${run.id} at ${run.snapshot.commit.slice(0, 7)}: ${counts.join(', ') || 'nothing to check'} (${plural(s.promises, 'promise')}).`];
  // What needs attention, worst first; what holds is only counted above.
  const worst = bySeverity(run.results).filter((r) => r.verdict === 'broken' || r.verdict === 'looks-broken' || r.verdict === 'cant-tell');
  for (const r of worst.slice(0, max)) {
    const at = r.citations[0] ? ` ${r.citations[0].path}:${r.citations[0].startLine}` : '';
    const why = r.explanation ?? r.reason ?? '';
    out.push(`- ${r.promiseId} ${LABELS[r.verdict]}${at}${why ? `: ${one(why, 110)}` : ''}`);
  }
  if (worst.length > max) out.push(`- … ${worst.length - max} more (/findings lists them all)`);
  const unchecked = run.results.filter((r) => r.verdict === 'not-checked').map((r) => r.promiseId);
  if (unchecked.length) out.push(`Not checked: ${unchecked.slice(0, 12).join(', ')}${unchecked.length > 12 ? ` and ${unchecked.length - 12} more` : ''}.`);
  return out;
}

/** Program-made lines: what the records say changed since `before`. */
export function changeLines(before: RecordsBefore, ws: DiscussWorkspace): string[] {
  const d = ws.data;
  const out: string[] = [];
  const run = d.lastRun;
  if (run && run.id !== before.runId) out.push(...runLines(run));

  const added: PromiseRecord[] = [];
  const changed: string[] = [];
  for (const p of d.promises) {
    const was = before.promises.get(p.id);
    if (!was) added.push(p);
    else if (was.status !== p.status) changed.push(`${p.id}: ${was.status} -> ${p.status} · "${one(p.wording, 100)}"`);
    else if (was.wording !== p.wording) changed.push(`${p.id}: reworded to "${one(p.wording, 100)}"`);
  }
  if (added.length) {
    const drafts = added.filter((p) => p.status === 'draft');
    out.push(`${plural(added.length, 'new promise')}${drafts.length ? ` (${drafts.length} draft${drafts.length === 1 ? '' : 's'}, waiting for the user's /accept)` : ''}:`);
    for (const p of added.slice(0, 12)) out.push(`- ${p.id} [${p.status}, ${p.kind}] ${one(p.wording, 110)}`);
    if (added.length > 12) out.push(`- … ${added.length - 12} more (${cmd} promises --all)`);
  }
  for (const c of changed.slice(0, 12)) out.push(`- ${c}`);

  const newRules: Rule[] = [];
  for (const r of d.rules) {
    const was = before.rules.get(r.id);
    if (!was || was.status !== r.status || was.description !== r.description) newRules.push(r);
  }
  if (newRules.length) {
    out.push(`${plural(newRules.length, 'rule')} new or changed:`);
    for (const r of newRules.slice(0, 12)) {
      const proof = r.provenBy?.failedAsExpected ? 'proven able to fail' : 'not proven to fail';
      out.push(`- ${r.id} for ${r.promiseId} [${r.status}, ${proof}] ${one(r.description, 100)}`);
    }
    const proposed = newRules.filter((r) => r.status === 'proposed');
    if (proposed.length) out.push(`Proposed rules wait for the user's decision: /rule accept <rule id>.`);
  }
  const b = d.bindings.length - before.bindings;
  if (b !== 0) out.push(`${b > 0 ? `${plural(b, 'binding')} added` : `${plural(-b, 'binding')} removed`} (${d.bindings.length} in all).`);
  if (out.length === 0) out.push('No records changed.');
  return out;
}

/** Plain words for an exit code. */
export function exitWords(code: number, command: string): string {
  if (code === 0) return 'ok';
  if (code === 1) return command === 'check' ? 'a promise is broken' : 'drift or a broken promise found';
  return 'the command failed';
}
