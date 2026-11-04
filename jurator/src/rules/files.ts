// Owner: WP-R. Loading the files a rule covers from git (never the working tree), and rule coverage.
import type { GitRepo, PromiseRecord, Rule, SourceFile } from '../contracts.js';

/** Tracked files at `commit` matching any glob, read from git. `cache` (path -> text) avoids reading a file twice. */
export async function loadRuleFiles(
  repo: GitRepo,
  commit: string,
  globs: readonly string[],
  cache: Map<string, string> = new Map(),
): Promise<SourceFile[]> {
  const paths = [...new Set(await repo.listFiles(commit, globs))].sort();
  const out: SourceFile[] = [];
  for (const path of paths) {
    let text = cache.get(path);
    if (text === undefined) {
      text = await repo.readFile(commit, path);
      cache.set(path, text);
    }
    out.push({ path, text });
  }
  return out;
}

/** The headline number: accepted code promises with at least one accepted rule. */
export function ruleCoverage(
  promises: readonly PromiseRecord[],
  rules: readonly Rule[],
): { covered: number; codePromises: number; uncovered: string[] } {
  const code = promises.filter((p) => p.status === 'accepted' && p.checkable === 'code');
  const has = (id: string): boolean => rules.some((r) => r.promiseId === id && r.status === 'accepted');
  const uncovered = code.filter((p) => !has(p.id)).map((p) => p.id);
  return { covered: code.length - uncovered.length, codePromises: code.length, uncovered };
}

/** Accepted rules for one promise, sorted by id: what `check` runs. */
export function acceptedRulesFor(promiseId: string, rules: readonly Rule[]): Rule[] {
  return rules.filter((r) => r.promiseId === promiseId && r.status === 'accepted').sort((a, b) => (a.id < b.id ? -1 : 1));
}
