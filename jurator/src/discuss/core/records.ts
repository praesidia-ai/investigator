// Owner: DS-A. Rows the slash commands return and the tools describe: promises, findings, rules, promise details.
// Verdict words come from src/render LABELS; every code line is re-copied from git by the program.
import { anchorIn } from '../../bindings/index.js';
import type { CheckResult, CheckRun, Citation, PromiseRecord, Rule } from '../../contracts.js';
import { maskSecrets } from '../../model/secrets.js';
import { bySeverity, LABELS } from '../../render/index.js';
import { DISCUSS_LIMITS, type FindingRow, type PolicyExcerpt, type PromiseDetail, type PromiseRow, type RuleRow } from '../contract.js';
import type { CodeReader } from '../tools/code-reader.js';
import type { DiscussWorkspace } from './workspace.js';

export function ruleRow(r: Rule): RuleRow {
  return {
    id: r.id,
    promiseId: r.promiseId,
    status: r.status,
    description: r.description,
    mode: r.mode,
    globs: r.globs,
    provenToFail: r.provenBy?.failedAsExpected === true,
  };
}

export function lastResult(run: CheckRun | null, promiseId: string): CheckResult | null {
  return run?.results.find((r) => r.promiseId === promiseId) ?? null;
}

export function promiseRow(ws: DiscussWorkspace, p: PromiseRecord): PromiseRow {
  const { rules, bindings, lastRun } = ws.data;
  return {
    id: p.id,
    wording: p.wording,
    kind: p.kind,
    checkable: p.checkable,
    rules: rules.filter((r) => r.promiseId === p.id && r.status === 'accepted').length,
    bindings: bindings.filter((b) => b.promiseId === p.id).length,
    verdict: lastResult(lastRun, p.id)?.verdict ?? null,
  };
}

/** Accepted promises (or the given ones), sorted by id as the store keeps them. */
export function promiseRows(ws: DiscussWorkspace, filter: (p: PromiseRecord) => boolean = (p) => p.status === 'accepted'): PromiseRow[] {
  return ws.data.promises.filter(filter).map((p) => promiseRow(ws, p));
}

/** A run citation re-copied from git at the run's commit (masked); the stored quote (masked) when git cannot. */
export async function recopy(code: CodeReader, c: Citation): Promise<Citation> {
  try {
    const fresh = await code.copy(c.path, c.startLine, c.endLine, c.commit);
    if (fresh) return fresh;
  } catch {
    // fall through: the record's quote was copied from git when the run was made
  }
  return { ...c, quote: maskSecrets(c.quote, c.path).text };
}

export async function findingRow(code: CodeReader, r: CheckResult): Promise<FindingRow> {
  const citations: Citation[] = [];
  for (const c of r.citations.slice(0, DISCUSS_LIMITS.maxFindingCitations)) citations.push(await recopy(code, c));
  return {
    promiseId: r.promiseId,
    wording: r.wording,
    verdict: r.verdict,
    level: r.level,
    label: LABELS[r.verdict],
    explanation: r.explanation ?? r.reason ?? null,
    citations,
  };
}

/** The last run's results, worst first. */
export async function findingRows(ws: DiscussWorkspace, code: CodeReader): Promise<FindingRow[]> {
  const run = ws.data.lastRun;
  if (!run) return [];
  const out: FindingRow[] = [];
  for (const r of bySeverity(run.results).slice(0, DISCUSS_LIMITS.maxPromiseRows)) out.push(await findingRow(code, r));
  return out;
}

/** 1-based line of a UTF-16 offset. */
function lineAt(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < Math.min(offset, text.length); i += 1) if (text.charCodeAt(i) === 10) line += 1;
  return line;
}

/** The policy lines a promise quotes, copied from the locked source text (.jurator/sources/). */
export async function quoteExcerpt(ws: DiscussWorkspace, p: PromiseRecord): Promise<PolicyExcerpt> {
  const where = ws.data.sources[p.quote.alias] ?? p.quote.alias;
  const locked = await ws.policyText(p.quote.alias);
  const sha = locked?.entry.sha256 ?? p.quote.policySha256;
  if (locked && p.quote.start !== undefined && p.quote.end !== undefined && p.quote.end <= locked.text.length) {
    const startLine = lineAt(locked.text, p.quote.start);
    const endLine = Math.max(startLine, lineAt(locked.text, Math.max(p.quote.start, p.quote.end - 1)));
    const lines = locked.text.split('\n').slice(startLine - 1, endLine);
    return { alias: p.quote.alias, where, startLine, endLine, text: lines.join('\n'), sha256: sha };
  }
  const line = p.quote.line ?? 1;
  return {
    alias: p.quote.alias,
    where: p.quote.jsonPointer ? `${where}#${p.quote.jsonPointer}` : where,
    startLine: line,
    endLine: line,
    text: p.quote.text,
    sha256: sha,
  };
}

export async function promiseDetail(ws: DiscussWorkspace, code: CodeReader, p: PromiseRecord): Promise<PromiseDetail> {
  const bindings: Array<PromiseDetail['bindings'][number]> = [];
  for (const b of ws.data.bindings.filter((x) => x.promiseId === p.id)) {
    let citation: Citation | null = null;
    let moved = true;
    try {
      const lines = await code.lines(b.path);
      const anchored = anchorIn(b, lines.join('\n'));
      if (anchored) {
        citation = await code.copy(b.path, anchored.startLine, anchored.endLine);
        moved = anchored.status !== 'same';
      }
    } catch {
      citation = null;
    }
    bindings.push({ id: b.id, symbol: b.symbol, citation, moved });
  }
  const result = lastResult(ws.data.lastRun, p.id);
  return {
    row: promiseRow(ws, p),
    policy: await quoteExcerpt(ws, p),
    rules: ws.data.rules.filter((r) => r.promiseId === p.id).map(ruleRow),
    bindings,
    finding: result ? await findingRow(code, result) : null,
  };
}

export function findPromise(ws: DiscussWorkspace, id: string): PromiseRecord | null {
  const want = id.trim();
  return ws.data.promises.find((p) => p.id === want) ?? null;
}
