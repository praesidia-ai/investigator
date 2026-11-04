// Owner: WP-R. A small per-machine cache of promises the model last judged infeasible as rules, so the tool stops
// suggesting `rule propose <id>` for them. Lives in .jurator/local/ (gitignored): a cache, not the record.
// Format (read by WP-K2's check output too): a JSON array of promise ids, sorted, e.g. ["praesidia.02","privacy.03"].
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export const INFEASIBLE_FILE = join('local', 'infeasible.json');

/** Path of the cache inside a .jurator directory. */
export const infeasiblePath = (juratorDir: string): string => join(juratorDir, INFEASIBLE_FILE);

/** Promise ids the model last judged infeasible. A missing or broken file is an empty list. */
export async function readInfeasible(juratorDir: string): Promise<string[]> {
  try {
    const value: unknown = JSON.parse(await readFile(infeasiblePath(juratorDir), 'utf8'));
    if (!Array.isArray(value)) return [];
    return [...new Set(value.filter((v): v is string => typeof v === 'string'))].sort();
  } catch {
    return [];
  }
}

/** Writes the list (sorted, unique). Never throws: a cache that cannot be written only means more hints later. */
export async function writeInfeasible(juratorDir: string, ids: readonly string[]): Promise<boolean> {
  const path = infeasiblePath(juratorDir);
  try {
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify([...new Set(ids)].sort(), null, 2)}\n`, 'utf8');
    await rename(tmp, path);
    return true;
  } catch {
    return false;
  }
}

/** The new list after a propose run: add ids judged infeasible, drop ids that now have a rule. */
export function nextInfeasible(current: readonly string[], add: readonly string[], remove: readonly string[]): string[] {
  const out = new Set(current);
  for (const id of add) out.add(id);
  for (const id of remove) out.delete(id);
  return [...out].sort();
}
