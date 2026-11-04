// Owner: X-FRONTEND. Reads what the report needs from the store and one CheckRun (default: the newest saved run).
import { readFile } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { BRAND } from '../brand.js';
import { checkRunSchema, type CheckRun, type Store } from '../contracts.js';
import { JuratorError } from '../util/errors.js';
import { listRuns } from '../workspace/index.js';
import type { ReportInput } from './model.js';

/** Shows a path relative to the repo when it lives inside it, so the page does not carry home-folder paths. */
export function displayPath(path: string, repoRoot: string): string {
  const rel = relative(repoRoot, path);
  if (rel && !rel.startsWith('..') && !isAbsolute(rel)) return rel.split(sep).join('/');
  return path;
}

export async function readRunFile(path: string): Promise<CheckRun> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    throw new JuratorError('BAD_RUN_FILE', `Could not read ${path} as JSON: ${why}`);
  }
  const parsed = checkRunSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new JuratorError(
      'BAD_RUN_FILE',
      `${path} is not a ${BRAND.name} run record (${issue ? `${issue.path.join('.') || '(root)'}: ${issue.message}` : 'wrong shape'}).`,
    );
  }
  return parsed.data;
}

export interface LoadOptions {
  /** Absolute path of a run.json; when absent the newest run under .jurator/local/runs/ is used (or none). */
  readonly runPath?: string;
  readonly now: () => Date;
}

export async function loadReportInput(store: Store, options: LoadOptions): Promise<ReportInput> {
  const config = await store.readConfig();
  const [promises, rules, contradictions] = await Promise.all([
    store.readPromises(),
    store.readRules(),
    store.readContradictions(),
  ]);
  let run: CheckRun | null = null;
  let runPath: string | undefined;
  if (options.runPath) {
    runPath = resolve(options.runPath);
    run = await readRunFile(runPath);
  } else {
    const runs = await listRuns(store);
    run = runs.at(-1) ?? null;
    if (run) runPath = join(store.dir, 'local', 'runs', run.id, 'run.json');
  }
  const sources: Record<string, string> = {};
  for (const s of config.sources) sources[s.alias] = s.locator;
  return {
    promises,
    rules,
    contradictions,
    sources,
    run,
    ...(runPath ? { runPath: displayPath(runPath, store.repoRoot) } : {}),
    repoName: basename(store.repoRoot),
    generatedAt: options.now(),
  };
}
