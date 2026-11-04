// Owner: DS-A. The answer's [[path:12-14]] markers, copied by the program from git at the snapshot (or from the locked
// policy text). Model text never becomes evidence: a marker the program cannot copy is listed as unresolved.
import type { Citation } from '../../contracts.js';
import { isSecretFile } from '../../model/secrets.js';
import { DISCUSS_LIMITS, parseCiteMarkers, type PolicyExcerpt, type UnresolvedCite } from '../contract.js';
import type { CodeReader } from '../tools/code-reader.js';
import type { DiscussWorkspace } from './workspace.js';

export interface ResolvedEvidence {
  readonly citations: Citation[];
  readonly policy: PolicyExcerpt[];
  readonly unresolved: UnresolvedCite[];
  /** False when the answer has no markers (no evidence event is sent). */
  readonly any: boolean;
}

async function policyExcerpt(ws: DiscussWorkspace, path: string, start: number, end: number): Promise<PolicyExcerpt | 'not-found' | 'out-of-range'> {
  const alias = ws.sourceAlias(path);
  if (!alias) return 'not-found';
  const locked = await ws.policyText(alias);
  if (!locked) return 'not-found';
  const lines = locked.text.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  if (end > lines.length) return 'out-of-range';
  return {
    alias,
    where: ws.data.sources[alias] ?? alias,
    startLine: start,
    endLine: end,
    text: lines.slice(start - 1, end).join('\n'),
    sha256: locked.entry.sha256,
  };
}

export async function resolveEvidence(text: string, ws: DiscussWorkspace, code: CodeReader): Promise<ResolvedEvidence> {
  const markers = parseCiteMarkers(text);
  const citations: Citation[] = [];
  const policy: PolicyExcerpt[] = [];
  const unresolved: UnresolvedCite[] = [];
  const seen = new Set<string>();
  for (const m of markers) {
    if (seen.has(m.marker)) continue;
    seen.add(m.marker);
    if (seen.size > DISCUSS_LIMITS.maxCiteMarkers) break;
    if (m.endLine < m.startLine || m.startLine < 1) {
      unresolved.push({ marker: m.marker, reason: 'bad-marker' });
      continue;
    }
    if (m.endLine - m.startLine + 1 > DISCUSS_LIMITS.maxCiteLines) {
      unresolved.push({ marker: m.marker, reason: 'too-long' });
      continue;
    }
    let path: string;
    try {
      path = code.normalize(m.path);
    } catch {
      unresolved.push({ marker: m.marker, reason: 'bad-marker' });
      continue;
    }
    if (isSecretFile(path)) {
      unresolved.push({ marker: m.marker, reason: 'secret-file' });
      continue;
    }
    let lines: string[] | null = null;
    try {
      lines = await code.lines(path);
    } catch {
      lines = null;
    }
    if (lines) {
      const c = await code.copy(path, m.startLine, m.endLine);
      if (c) citations.push(c);
      else unresolved.push({ marker: m.marker, reason: 'out-of-range' });
      continue;
    }
    const p = await policyExcerpt(ws, path, m.startLine, m.endLine);
    if (typeof p === 'string') unresolved.push({ marker: m.marker, reason: p });
    else policy.push(p);
  }
  return { citations, policy, unresolved, any: markers.length > 0 };
}
