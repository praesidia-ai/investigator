// Owner: DS-A. The session transcript: .jurator/local/discuss/<YYYY-MM-DDTHH-MM-SS>.md (gitignored), rewritten after
// every turn through a temp file and a rename. Masked text only; evidence fences are the program's copies from git.
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { BRAND } from '../../brand.js';
import type { Citation } from '../../contracts.js';
import { formatUsd } from '../../model/cost.js';
import { maskSecrets } from '../../model/secrets.js';
import type { PolicyExcerpt, UnresolvedCite } from '../contract.js';

export interface TranscriptTool {
  readonly label: string;
  readonly summary: string;
  readonly ok: boolean;
}

export interface TranscriptTurn {
  readonly turn: number;
  readonly question: string;
  tools: TranscriptTool[];
  answer: string | null;
  citations: readonly Citation[];
  policy: readonly PolicyExcerpt[];
  unresolved: readonly UnresolvedCite[];
  usd: number;
  status: 'running' | 'answered' | 'cancelled' | 'error';
  error: string | null;
  totalUsd: number;
  /** DS-C: action cards shown, actions run (with the program's summary and the command's output), policy diffs. */
  notes?: string[];
}

export interface TranscriptHeader {
  readonly root: string;
  readonly snapshot: string;
  readonly repos: ReadonlyArray<{ readonly name: string; readonly commit: string }>;
  model: string;
  budgetUsd: number;
  readonly startedAt: string;
}

const fence = (body: string): string => {
  const ticks = body.includes('```') ? '````' : '```';
  return `${ticks}\n${body}\n${ticks}`;
};
const mask = (s: string): string => maskSecrets(s).text;

export function renderTranscript(header: TranscriptHeader, turns: readonly TranscriptTurn[]): string {
  const out: string[] = [
    `# ${BRAND.name} discuss`,
    '',
    `- Root: ${header.root}`,
    `- Snapshot: ${header.snapshot}`,
    ...header.repos.map((r) => `  - ${r.name || '(repo)'} @ ${r.commit}`),
    `- Model: ${header.model} · Budget: ${formatUsd(header.budgetUsd)}`,
    `- Started: ${header.startedAt}`,
    `- The agent looks things up and proposes steps; nothing runs or changes without the user's yes. Evidence below is copied from git by the program.`,
  ];
  for (const t of turns) {
    out.push('', `## ${t.turn} · You`, '', mask(t.question));
    const tag = t.status === 'cancelled' ? ' (cancelled)' : t.status === 'error' ? ' (error)' : t.status === 'running' ? ' (running)' : '';
    out.push('', `## ${t.turn} · ${BRAND.name}${tag}`, '');
    for (const tool of t.tools) out.push(`- ${tool.ok ? '' : '✗ '}${tool.label} · ${tool.summary}`);
    if (t.tools.length) out.push('');
    if (t.notes?.length) out.push(...t.notes.map(mask), '');
    if (t.answer) out.push(mask(t.answer), '');
    if (t.error) out.push(`> ${t.error}`, '');
    if (t.citations.length || t.policy.length) {
      out.push(`Evidence, copied by the program at ${header.snapshot.slice(0, 7)}:`, '');
      for (const c of t.citations) {
        const range = c.endLine > c.startLine ? `${c.startLine}-${c.endLine}` : `${c.startLine}`;
        const body = c.quote.split('\n').map((l, i) => `${String(c.startLine + i).padStart(String(c.endLine).length)}  ${l}`).join('\n');
        out.push(`${c.path}:${range} @ ${c.commit.slice(0, 7)}`, fence(body), '');
      }
      for (const p of t.policy) {
        const body = p.text.split('\n').map((l, i) => `${String(p.startLine + i).padStart(String(p.endLine).length)}  ${l}`).join('\n');
        out.push(`${p.where}:${p.startLine}-${p.endLine} (policy ${p.alias}, sha256 ${p.sha256.slice(0, 12)})`, fence(body), '');
      }
    }
    for (const u of t.unresolved) out.push(`- not verified: ${u.marker} (${u.reason})`);
    if (t.unresolved.length) out.push('');
    out.push(`_${formatUsd(t.usd)} this turn · ${formatUsd(t.totalUsd)} of ${formatUsd(header.budgetUsd)}_`);
  }
  return `${out.join('\n')}\n`;
}

export async function writeTranscript(path: string, header: TranscriptHeader, turns: readonly TranscriptTurn[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, renderTranscript(header, turns), 'utf8');
  await rename(tmp, path);
}

/** `2026-11-04T11-30-00` from a date (UTC), for the transcript file name. */
export function transcriptStamp(d: Date): string {
  return d.toISOString().slice(0, 19).replace(/:/gu, '-');
}
