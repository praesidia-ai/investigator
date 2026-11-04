// Owner: WP-K. Per-machine hints in .jurator/local/ (never committed, never evidence).
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Promise ids whose last rule proposal said no rule is possible (written by `rule propose` to
 * .jurator/local/infeasible.json as a JSON array of ids). A missing or unreadable file is an empty list.
 */
export async function readInfeasible(storeDir: string): Promise<string[]> {
  try {
    const value: unknown = JSON.parse(await readFile(join(storeDir, 'local', 'infeasible.json'), 'utf8'));
    return Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/** Width to cut terminal lines at: the terminal's columns on a TTY, else 80. */
export function terminalWidth(stream: { isTTY?: boolean; columns?: number } = process.stdout): number {
  return stream.isTTY && typeof stream.columns === 'number' && stream.columns > 0 ? stream.columns : 80;
}
