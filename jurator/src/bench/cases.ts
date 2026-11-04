// Owner: FX-3. Bench data: a baseline copy of the demo repo, its accepted promises and rules, and planted cases.
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { commitSha, itemsFile, promiseSchema, ruleSchema, type PromiseRecord, type Rule, type SourceFile } from '../contracts.js';
import { applyEdit, codeEditSchema, type CodeEdit } from '../rules/redteam.js';
import { JuratorError } from '../util/errors.js';
import { matchesAny } from '../util/glob.js';
import { describeIssues } from '../model/strict.js';

/** fixtures/bench/ next to src/ (from src/bench/ in tests, from dist/bench/ when built). */
export const DEFAULT_BENCH_DIR = fileURLToPath(new URL('../../fixtures/bench/', import.meta.url));

export const benchCaseSchema = z.object({
  id: z.string().regex(/^[A-Z][A-Z0-9-]*$/u),
  kind: z.enum(['break', 'harmless']),
  title: z.string().min(3),
  /** The promises this change breaks (empty for a harmless change). */
  breaks: z.array(z.string()),
  edits: z.array(codeEditSchema).min(1),
});
export type BenchCase = z.infer<typeof benchCaseSchema>;

export const benchFileSchema = z.object({
  schemaVersion: z.literal(1),
  repo: z.string().min(1),
  /** Folder under the bench dir holding the repo files at `commit`. */
  baseline: z.string().min(1),
  commit: commitSha,
  codeScope: z.array(z.string()).min(1),
  policies: z.array(z.object({ alias: z.string(), path: z.string() })).min(1),
  cases: z.array(benchCaseSchema).min(1),
});
export type BenchFile = z.infer<typeof benchFileSchema>;

export interface BenchPolicy {
  readonly alias: string;
  readonly path: string;
  readonly text: string;
}

export interface BenchData {
  readonly dir: string;
  readonly repo: string;
  readonly commit: string;
  readonly codeScope: readonly string[];
  /** Code files at the baseline (those in codeScope), sorted by path. */
  readonly files: readonly SourceFile[];
  readonly policies: readonly BenchPolicy[];
  readonly promises: readonly PromiseRecord[];
  readonly rules: readonly Rule[];
  readonly cases: readonly BenchCase[];
}

async function walk(root: string, dir: string, out: string[]): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await walk(root, full, out);
    else if (entry.isFile()) out.push(relative(root, full).split(sep).join('/'));
  }
}

async function readJson<T>(path: string, schema: z.ZodType<T>, what: string): Promise<T> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    throw new JuratorError('BENCH_DATA_INVALID', `Could not read ${what} at ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new JuratorError('BENCH_DATA_INVALID', `${what} at ${path} is not valid: ${describeIssues(parsed.error)}`);
  return parsed.data;
}

/** Loads cases.json, promises.json, rules.json and the baseline folder from a bench dir. */
export async function loadBench(dir: string = DEFAULT_BENCH_DIR): Promise<BenchData> {
  const root = resolve(dir);
  const bench = await readJson(join(root, 'cases.json'), benchFileSchema, 'The bench cases');
  const promises = (await readJson(join(root, 'promises.json'), itemsFile(promiseSchema), 'The bench promises')).items;
  const rules = (await readJson(join(root, 'rules.json'), itemsFile(ruleSchema), 'The bench rules')).items;
  const base = join(root, bench.baseline);
  const paths: string[] = [];
  await walk(base, base, paths);
  paths.sort();
  const files: SourceFile[] = [];
  for (const path of paths.filter((p) => matchesAny(p, bench.codeScope))) {
    files.push({ path, text: await readFile(join(base, path), 'utf8') });
  }
  const policies: BenchPolicy[] = [];
  for (const p of bench.policies) policies.push({ ...p, text: await readFile(join(base, p.path), 'utf8') });
  const ids = new Set(promises.map((p) => p.id));
  for (const c of bench.cases) {
    const unknown = c.breaks.filter((id) => !ids.has(id));
    if (unknown.length > 0) throw new JuratorError('BENCH_DATA_INVALID', `Case ${c.id} names unknown promises: ${unknown.join(', ')}`);
    if ((c.kind === 'break') !== c.breaks.length > 0) {
      throw new JuratorError('BENCH_DATA_INVALID', `Case ${c.id}: a break names the promise it breaks; a harmless change names none`);
    }
  }
  return { dir: root, repo: bench.repo, commit: bench.commit, codeScope: bench.codeScope, files, policies, promises, rules, cases: bench.cases };
}

export interface AppliedCase {
  readonly case: BenchCase;
  /** Every code file after the change. */
  readonly files: readonly SourceFile[];
  /** Changed paths, sorted. */
  readonly changed: readonly string[];
}

/** Applies a case's edits in order; a case that does not apply is a broken fixture (BAD data, exit 2). */
export function applyCase(data: Pick<BenchData, 'files'>, benchCase: BenchCase): AppliedCase {
  let files: readonly SourceFile[] = data.files;
  const changed = new Set<string>();
  for (const edit of benchCase.edits as readonly CodeEdit[]) {
    const out = applyEdit(files, edit);
    if (!out.ok) throw new JuratorError('BENCH_DATA_INVALID', `Case ${benchCase.id} does not apply: ${out.reason}`);
    files = out.files;
    changed.add(edit.path);
  }
  return { case: benchCase, files, changed: [...changed].sort() };
}
