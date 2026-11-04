// Owner: FU-1. Red-team evasions kept with each rule as extra mutants: `rule propose --redteam` stores the evasions a
// judge confirmed (closed = the kept rule fails on them; open = it still passes them), and `rule test` re-runs each one
// on the tested commit. Lives in .jurator/local/ (gitignored) because rules.json has no field for it (contracts are
// append-only and owned by the orchestrator). Format:
// { "version": 1, "rules": { "<ruleId>": { "promiseId", "commit", "evasions": [{ path, find, replace, why, judgeNote, round, closed }] } } }
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import type { PromiseRecord, Rule, SourceFile } from '../contracts.js';
import { runOnEdit } from './propose.js';
import { showEdit } from './redteam.js';
import type { HardenReport } from './repair.js';

export const MUTANTS_FILE = join('local', 'rule-mutants.json');
export const mutantsPath = (juratorDir: string): string => join(juratorDir, MUTANTS_FILE);

const storedEvasionSchema = z.object({
  path: z.string(),
  find: z.string(),
  replace: z.string(),
  why: z.string(),
  judgeNote: z.string(),
  round: z.number().int().min(0),
  closed: z.boolean(),
});
export type StoredEvasion = z.infer<typeof storedEvasionSchema>;
const fileSchema = z.object({
  version: z.literal(1),
  rules: z.record(z.string(), z.object({ promiseId: z.string(), commit: z.string(), evasions: z.array(storedEvasionSchema) })),
});
export type MutantsFile = z.infer<typeof fileSchema>;
const EMPTY: MutantsFile = { version: 1, rules: {} };

/** The stored evasions. A missing or broken file is empty. */
export async function readMutants(juratorDir: string): Promise<MutantsFile> {
  try {
    const parsed = fileSchema.safeParse(JSON.parse(await readFile(mutantsPath(juratorDir), 'utf8')));
    return parsed.success ? parsed.data : { version: 1, rules: {} };
  } catch {
    return { version: 1, rules: {} };
  }
}

/** Writes the file (atomic rename). Never throws: false when it could not be written. */
export async function writeMutants(juratorDir: string, data: MutantsFile): Promise<boolean> {
  const path = mutantsPath(juratorDir);
  try {
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    const sorted: MutantsFile = { version: 1, rules: Object.fromEntries(Object.entries(data.rules).sort(([a], [b]) => (a < b ? -1 : 1))) };
    await writeFile(tmp, `${JSON.stringify(sorted, null, 2)}\n`, 'utf8');
    await rename(tmp, path);
    return true;
  } catch {
    return false;
  }
}

/** The file after a propose run: each hardened rule's evasions replace its old entry; entries for gone rules leave. */
export function nextMutants(current: MutantsFile, reports: readonly HardenReport[], commit: string, rules: readonly Rule[]): MutantsFile {
  const live = new Set(rules.map((r) => r.id));
  const out: MutantsFile['rules'] = {};
  for (const [id, entry] of Object.entries(current.rules)) if (live.has(id)) out[id] = entry;
  for (const r of reports) {
    if (!live.has(r.rule.id)) continue;
    const evasions: StoredEvasion[] = [
      ...r.closed.map((e) => ({ ...e.edit, why: e.why, judgeNote: e.judgeNote, round: e.round, closed: true })),
      ...r.open.map((e) => ({ ...e.edit, why: e.why, judgeNote: e.judgeNote, round: e.round, closed: false })),
    ];
    if (evasions.length === 0) delete out[r.rule.id];
    else out[r.rule.id] = { promiseId: r.promiseId, commit, evasions };
  }
  return { ...EMPTY, rules: out };
}

export interface MutantResult {
  readonly ruleId: string;
  readonly n: number;
  readonly edit: string;
  readonly closed: boolean;
  /**
   * caught: the rule failed on the evasion (as proven) · missed: it passed a closed evasion (the rule got weaker) ·
   * still-open: it passes an evasion it never caught · now-caught: it fails on one it used to pass · not-applied: the code
   * changed, so the edit no longer applies · error: the rule could not run.
   */
  readonly outcome: 'caught' | 'missed' | 'still-open' | 'now-caught' | 'not-applied' | 'error';
  readonly message: string;
}

/** Re-runs each stored evasion of `rule` on the code at `commit` (the edit applied in memory, no AI). */
export async function testMutants(
  rule: Rule,
  promise: PromiseRecord | undefined,
  evasions: readonly StoredEvasion[],
  commit: string,
  loadFiles: (globs: readonly string[]) => Promise<SourceFile[]>,
): Promise<MutantResult[]> {
  const out: MutantResult[] = [];
  for (const [i, e] of evasions.entries()) {
    const edit = { path: e.path, find: e.find, replace: e.replace };
    const base = { ruleId: rule.id, n: i + 1, edit: showEdit(edit, 90), closed: e.closed };
    if (!promise) {
      out.push({ ...base, outcome: 'error', message: `promise ${rule.promiseId} is missing` });
      continue;
    }
    const res = await runOnEdit(rule, promise, [], commit, edit, loadFiles);
    if (!res.applied) out.push({ ...base, outcome: 'not-applied', message: res.reason });
    else if (res.outcome === 'error') out.push({ ...base, outcome: 'error', message: res.message });
    else if (res.outcome === 'fail') out.push({ ...base, outcome: e.closed ? 'caught' : 'now-caught', message: res.message });
    else out.push({ ...base, outcome: e.closed ? 'missed' : 'still-open', message: e.why });
  }
  return out;
}
