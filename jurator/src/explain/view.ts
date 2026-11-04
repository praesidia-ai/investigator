// Owner: HZ-1. The rows of a finding box (backlog 15): the plain summary first, then Found (path:line before each
// code line), To fix, and the policy sentence once. Details (all evidence, the rule's pattern and proof) only when asked.
import { BRAND } from '../brand.js';
import type { CodeSnapshot } from '../contracts.js';
import type { FindingRow } from '../ui/index.js';
import { genericActual } from './plain.js';
import { summaryLabel, type Finding, type Summary } from './summary.js';

export interface FindingView {
  readonly finding: Finding;
  readonly summary: Summary;
  /** The id people type (short on screens). */
  readonly id: string;
  /** Where the policy sentence lives ("docs/privacy.md:12"). */
  readonly policyWhere?: string | undefined;
  /** Rows after Found and before To fix (e.g. "Was" in a diff, "Checked" for the trigger). */
  readonly extra?: readonly FindingRow[] | undefined;
  /** Shown only in details (--verbose, explain): rule, pattern, proof... */
  readonly details?: readonly FindingRow[] | undefined;
  /** Every evidence line and the details. */
  readonly verbose?: boolean | undefined;
  /** Evidence lines shown when not verbose (default 3). */
  readonly maxEvidence?: number | undefined;
}

export function findingRows(v: FindingView): FindingRow[] {
  const { finding: f, summary: s } = v;
  const rows: FindingRow[] = [];
  rows.push({ full: true, text: s.summary, maxLines: 4 });
  rows.push({ full: true, text: summaryLabel(s), tone: 'muted' });
  if (s.note) rows.push({ label: 'AI note', text: s.note, tone: 'accent', maxLines: 2 });
  const limit = v.verbose ? f.evidence.length : (v.maxEvidence ?? 3);
  f.evidence.slice(0, limit).forEach((e, i) => {
    const value = !genericActual(e.actual) && e.allowed ? ` · has ${e.actual}, allowed ${e.allowed}` : '';
    rows.push({ label: i === 0 ? 'Found' : '', text: `${e.path}:${e.line}${value}`, tone: 'accent', maxLines: 2 });
    if (e.code.trim()) rows.push({ label: '', text: e.code, tone: 'code', lineNo: e.line });
  });
  if (f.evidence.length > limit) {
    rows.push({ label: '', text: `+${f.evidence.length - limit} more: ${BRAND.command} explain ${v.id}`, tone: 'muted' });
  }
  rows.push(...(v.extra ?? []));
  rows.push({ label: 'To fix', text: s.toFix, maxLines: 3 });
  rows.push({ label: 'Policy', text: quoted(f.policy), where: v.policyWhere, maxLines: v.verbose ? 6 : 2 });
  if (v.verbose) rows.push(...(v.details ?? []));
  return rows;
}

const short = (sha: string): string => sha.slice(0, 7);

/** The policy sentence in double quotes; a JSON value (a setting) is shown as it is. */
export function quoted(policy: string): string {
  const t = policy.replace(/\s+/gu, ' ').trim();
  return /^["[{]/u.test(t) || /^(?:true|false|null|-?\d[\d.]*)$/u.test(t) ? t : `"${t}"`;
}

/**
 * Header facts for the code that was read (backlog 17): each repo's branch @ commit in a workspace (not the composite
 * commit), or the repo's own. `head` is the commit read when it is not the working tree's (then shown alone).
 */
export function repoFacts(snapshot: CodeSnapshot | null | undefined, head?: string): Array<[string, string]> {
  if (!snapshot) return head ? [['commit', short(head)]] : [];
  const repos = snapshot.repos ?? [];
  if (repos.length > 0 && (!head || head === snapshot.commit)) {
    return repos.map((r) => [r.name, `${r.branch ?? 'detached'} @ ${short(r.commit)}${r.dirty ? ' (uncommitted changes not read)' : ''}`] as [string, string]);
  }
  if (head && head !== snapshot.commit) return [['commit', short(head)]];
  return [['', snapshot.branch ? `${snapshot.branch} @ ${short(snapshot.commit)}` : short(snapshot.commit)]];
}
