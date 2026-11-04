// Owner: WP-D. The real rules-only check behind every hook: no AI, no network, the store's accepted rules only.
import { runCheck } from '../check/index.js';
import { mergeById, workspaceAt } from '../check/at-commit.js';
import type { CheckRun } from '../contracts.js';
import { openRepo } from '../git/index.js';
import { findRepoRoot, openStore } from '../workspace/index.js';
import type { CheckTarget } from './prepush.js';

export interface RulesCheckOutcome {
  /** null when the repo has no .jurator/ (nothing to check). */
  readonly run: CheckRun | null;
  /** Where the run record was saved, when saving worked. */
  readonly runPath: string | null;
  /** Source alias -> locator (e.g. 'privacy' -> 'docs/privacy.md'), so output can say docs/privacy.md:7. */
  readonly sources?: Readonly<Record<string, string>>;
  /** The commit whose committed rules were used (the push base), when it had any. */
  readonly rulesFrom?: string;
}

export async function rulesCheck(cwd: string, target: CheckTarget, now: () => Date): Promise<RulesCheckOutcome> {
  const root = await findRepoRoot(cwd);
  const store = openStore(root);
  if (!(await store.exists())) return { run: null, runPath: null };
  const repo = await openRepo(root);
  const config = await store.readConfig();
  const sources = Object.fromEntries(config.sources.map((s) => [s.alias, s.locator] as const));
  // A branch must not weaken its own rule: run the rules committed at the push base. Rules that exist only here
  // (new on this branch, not yet at the base) are added; for the same id the base wins.
  let rulesFrom: string | undefined;
  let deps = {};
  if (target.kind === 'diff') {
    const atBase = await workspaceAt(repo, target.base);
    if (atBase.rules !== null) {
      rulesFrom = target.base;
      deps = { rules: mergeById(atBase.rules, await store.readRules()) };
    }
  }
  const run = await runCheck({ repo, store, model: null, target, aiRead: false, now }, deps);
  let runPath: string | null = null;
  try {
    runPath = await store.writeRun(run);
  } catch {
    runPath = null; // the verdict still stands; only the saved record is missing
  }
  return rulesFrom ? { run, runPath, sources, rulesFrom } : { run, runPath, sources };
}
