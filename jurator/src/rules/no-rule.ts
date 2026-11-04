// AC-A (SC-3 "also"): why a promise got no rule, saved per machine in .jurator/local/no-rule.json (gitignored), so a
// rejection (.16, .21, .26 in the live run) is not lost when the run's screen scrolls away. A cache, not the record.
// Format: { "<promiseId>": { "reason": "...", "infeasible": true|false, "commit": "<sha>", "at": "<iso time>" } }.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export const NO_RULE_FILE = join('local', 'no-rule.json');

export interface NoRuleEntry {
  readonly reason: string;
  /** True when the model itself judged no rule possible; false when the program rejected every answer. */
  readonly infeasible: boolean;
  readonly commit: string;
  readonly at: string;
}
export type NoRuleFile = Readonly<Record<string, NoRuleEntry>>;

export const noRulePath = (juratorDir: string): string => join(juratorDir, NO_RULE_FILE);

/** The saved reasons. A missing or broken file is empty. */
export async function readNoRule(juratorDir: string): Promise<NoRuleFile> {
  try {
    const value: unknown = JSON.parse(await readFile(noRulePath(juratorDir), 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const out: Record<string, NoRuleEntry> = {};
    for (const [id, e] of Object.entries(value as Record<string, unknown>)) {
      const r = e as Partial<NoRuleEntry> | null;
      if (r && typeof r.reason === 'string') {
        out[id] = { reason: r.reason, infeasible: r.infeasible === true, commit: typeof r.commit === 'string' ? r.commit : '', at: typeof r.at === 'string' ? r.at : '' };
      }
    }
    return out;
  } catch {
    return {};
  }
}

/** Writes the file (ids sorted). Never throws: a cache that cannot be written only loses the reasons. */
export async function writeNoRule(juratorDir: string, data: NoRuleFile): Promise<boolean> {
  const path = noRulePath(juratorDir);
  try {
    await mkdir(dirname(path), { recursive: true });
    const sorted = Object.fromEntries(Object.keys(data).sort().map((id) => [id, data[id]]));
    const tmp = `${path}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify(sorted, null, 2)}\n`, 'utf8');
    await rename(tmp, path);
    return true;
  } catch {
    return false;
  }
}

/** After a propose run: the new reasons replace old ones, and a promise that now has a rule leaves. */
export function nextNoRule(current: NoRuleFile, add: Readonly<Record<string, NoRuleEntry>>, covered: readonly string[]): NoRuleFile {
  const out: Record<string, NoRuleEntry> = { ...current, ...add };
  for (const id of covered) delete out[id];
  return out;
}
