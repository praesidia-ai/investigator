// Owner: DS-C. Policy drafting: the agent proposes new wording for some lines of a policy file; the program copies the
// current lines from the file, makes the diff, and writes it only when the user types /apply (and the file has not
// changed since). Only file sources inside the workspace can be edited; connector sources are edited where they live.
import { createHash } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { isAbsolute, join, normalize, relative } from 'node:path';
import { BRAND } from '../../brand.js';
import { isSecretFile } from '../../model/secrets.js';
import type { PolicyEditCard } from '../contract.js';
import type { DiscussWorkspace } from '../core/workspace.js';

export interface EditRequest {
  readonly source: string;
  readonly start: number;
  readonly end: number;
  readonly newText: string;
  readonly why: string;
}

export type EditBuild = { readonly ok: true; readonly card: PolicyEditCard } | { readonly ok: false; readonly summary: string; readonly text: string };

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');
const MAX_EDIT_LINES = 40;

/** The file path of a source alias, or why it cannot be edited here. */
function fileOf(ws: DiscussWorkspace, alias: string): { path: string } | { error: string } {
  const source = ws.data.config.sources.find((s) => s.alias === alias);
  if (!source) return { error: `There is no policy source "${alias}". Sources: ${ws.data.config.sources.map((s) => s.alias).join(', ') || 'none'}.` };
  if (source.connector !== 'file') {
    return { error: `${alias} comes from ${source.connector} (${source.locator}); edit it there, then the user runs ${BRAND.command} pull.` };
  }
  const rel = normalize(source.locator).replace(/^\.\//u, '');
  if (isAbsolute(rel) || rel.startsWith('..') || isSecretFile(rel)) return { error: `${alias} is not a file inside this workspace.` };
  return { path: rel };
}

/** A unified diff of one hunk (old lines from the file, new lines from the proposal). */
export function unifiedDiff(path: string, start: number, before: readonly string[], after: readonly string[]): string {
  return [
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -${start},${before.length} +${start},${after.length} @@`,
    ...before.map((l) => `-${l}`),
    ...after.map((l) => `+${l}`),
  ].join('\n');
}

export async function buildPolicyEdit(req: EditRequest, ws: DiscussWorkspace, id: string): Promise<EditBuild> {
  const alias = ws.sourceAlias(req.source);
  if (!alias) return { ok: false, summary: `no source ${req.source}`, text: `There is no policy source "${req.source}".` };
  const f = fileOf(ws, alias);
  if ('error' in f) return { ok: false, summary: 'refused: not an editable file', text: f.error };
  let text: string;
  try {
    text = await readFile(join(ws.root, f.path), 'utf8');
  } catch {
    return { ok: false, summary: `no file ${f.path}`, text: `${f.path} is not on disk.` };
  }
  const locked = await ws.policyText(alias);
  if (locked && locked.text !== text) {
    return {
      ok: false,
      summary: 'refused: the file changed since the last pull',
      text: `${f.path} changed since it was last pulled, so the line numbers from policy_text may not match. Ask the user to run ${BRAND.command} pull (or compile) first.`,
    };
  }
  const lines = text.split('\n');
  const count = lines.length > 1 && lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
  if (req.start < 1 || req.end < req.start || req.end > count) {
    return { ok: false, summary: `bad input: lines ${req.start}-${req.end} of ${count}`, text: `${f.path} has ${count} lines; give start and end within them.` };
  }
  if (req.end - req.start + 1 > MAX_EDIT_LINES) return { ok: false, summary: 'bad input: too many lines', text: `Edit at most ${MAX_EDIT_LINES} lines at a time.` };
  const before = lines.slice(req.start - 1, req.end);
  const after = req.newText.replace(/\r\n?/gu, '\n').replace(/\n$/u, '').split('\n');
  if (after.length > MAX_EDIT_LINES * 2) return { ok: false, summary: 'bad input: too many lines', text: 'The new wording is too long for one edit.' };
  if (after.join('\n') === before.join('\n')) return { ok: false, summary: 'no change', text: 'The new wording is the same as the current lines.' };
  const card: PolicyEditCard = {
    id,
    alias,
    path: f.path,
    startLine: req.start,
    endLine: req.end,
    before: before.join('\n'),
    after: after.join('\n'),
    diff: unifiedDiff(f.path, req.start, before, after),
    why: req.why.trim().slice(0, 400),
    fileSha256: sha256(text),
  };
  return { ok: true, card };
}

/** Writes the edit (temp file, rename). Refuses when the file changed since the card was made. */
export async function applyPolicyEdit(card: PolicyEditCard, root: string): Promise<{ ok: true } | { ok: false; message: string }> {
  const full = join(root, card.path);
  if (relative(root, full).startsWith('..')) return { ok: false, message: 'That file is outside the workspace.' };
  let text: string;
  try {
    text = await readFile(full, 'utf8');
  } catch {
    return { ok: false, message: `${card.path} is gone.` };
  }
  if (sha256(text) !== card.fileSha256) return { ok: false, message: `${card.path} changed since the edit was proposed; nothing was written. Ask for the edit again.` };
  const lines = text.split('\n');
  const next = [...lines.slice(0, card.startLine - 1), ...card.after.split('\n'), ...lines.slice(card.endLine)].join('\n');
  const tmp = `${full}.discuss-${process.pid}.tmp`;
  await writeFile(tmp, next);
  await rename(tmp, full);
  return { ok: true };
}
