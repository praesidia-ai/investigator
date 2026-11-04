// Owner: WP-P. Command flows over injected dependencies (the command files wire the real store, git and model).
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  alias as aliasSchema,
  type Config,
  type Contradiction,
  type ModelClient,
  type ModelUsage,
  type PolicyDocument,
  type PolicySourceConfig,
  type PromiseRecord,
  type Store,
} from '../contracts.js';
import { JuratorError } from '../util/errors.js';
import { matchesAny } from '../util/glob.js';
import { byPromiseId, compilePolicy, isStructured, LOCAL_ALIAS } from './compile.js';
import { findContradictions, type ContradictionStats } from './contradictions.js';
import { BRAND } from '../brand.js';

export interface SourceReport {
  readonly alias: string;
  readonly locator: string;
  readonly structured: boolean;
  /** True when the policy text did not change since its promises were compiled (no model call). */
  readonly skipped: boolean;
  /** Live (non-retired) promises after this compile. */
  readonly promises: number;
  /** Quotes the program found word for word / drafts the compiler proposed. */
  readonly found: number;
  readonly total: number;
  readonly dropped: ReadonlyArray<{ wording: string; reason: string }>;
  /** R4-FIX: what the program changed in a promise's typed fields and why (e.g. a number with no unit). */
  readonly notes?: readonly string[];
  readonly added: string[];
  readonly reworded: string[];
  readonly retired: string[];
}
export interface CompileReport {
  readonly sources: SourceReport[];
  readonly contradictions: Contradiction[];
  readonly contradictionsChecked: boolean;
  /** How the pairs were decided this run (null when conflicts were not re-checked). */
  readonly conflictCheck: ContradictionStats | null;
  readonly accepted: string[];
  readonly usage: ModelUsage[];
  readonly costUsd: number;
  readonly mode: 'live' | 'scripted' | 'none';
}
export interface CompileDeps {
  readonly store: Store;
  /** Fetches every configured source and saves texts + lock (connectors' pullSources with write=true). */
  readonly pull: () => Promise<{ docs: PolicyDocument[] }>;
  /** Repo-relative code files, used as scope hints. */
  readonly codeFiles: () => Promise<string[]>;
  readonly model: ModelClient | null;
  readonly now: Date;
}

const active = (p: PromiseRecord) => p.status !== 'retired';
const aliasOf = (id: string) => id.slice(0, id.lastIndexOf('.'));

export async function runCompile(
  deps: CompileDeps,
  opts: { readonly accept: boolean; readonly force: boolean },
): Promise<CompileReport> {
  const { store, model, now } = deps;
  const { docs } = await deps.pull();
  const existing = await store.readPromises();
  const codeFiles = await deps.codeFiles().catch(() => [] as string[]);
  // R5-A: in a multi-repo workspace the compiler sees one overview per repo and every code scope names its repo.
  const config = await store.readConfig().catch(() => null);
  const workspace = config?.repos && config.repos.length > 1 ? { repos: config.repos.map((r) => r.name), codeScope: config.codeScope } : undefined;
  const usage: ModelUsage[] = [];
  const sources: SourceReport[] = [];
  const byAlias = new Map<string, PromiseRecord[]>();
  for (const p of existing) byAlias.set(aliasOf(p.id), [...(byAlias.get(aliasOf(p.id)) ?? []), p]);
  const touched = new Set<string>();

  for (const doc of docs) {
    const before = byAlias.get(doc.alias) ?? [];
    const structured = isStructured(doc);
    const live = before.filter(active);
    const unchanged = live.length > 0 && live.every((p) => p.quote.policySha256 === doc.sha256);
    if (unchanged && !opts.force) {
      sources.push({
        alias: doc.alias,
        locator: doc.locator,
        structured,
        skipped: true,
        promises: live.length,
        found: live.length,
        total: live.length,
        dropped: [],
        added: [],
        reworded: [],
        retired: [],
      });
      continue;
    }
    const result = await compilePolicy(doc, before, model, now, { codeFiles, workspace });
    usage.push(...result.usage);
    const prev = new Map(before.map((p) => [p.id, p]));
    const after = result.promises;
    const kept = after.filter(active);
    sources.push({
      alias: doc.alias,
      locator: doc.locator,
      structured,
      skipped: false,
      promises: kept.length,
      found: kept.length,
      total: kept.length + result.dropped.length,
      dropped: result.dropped,
      ...(result.notes ? { notes: result.notes } : {}),
      added: after.filter((p) => !prev.has(p.id)).map((p) => p.id),
      reworded: after
        .filter((p) => (p.rewordedFrom?.length ?? 0) > (prev.get(p.id)?.rewordedFrom?.length ?? 0))
        .map((p) => p.id),
      retired: after.filter((p) => p.status === 'retired' && prev.get(p.id)?.status !== 'retired').map((p) => p.id),
    });
    byAlias.set(doc.alias, after);
    // Write each source as soon as it is compiled, so a later failure does not lose paid-for work.
    await store.writePromises(doc.alias, [...after].sort(byPromiseId));
  }

  const accepted: string[] = [];
  if (opts.accept) {
    for (const [a, list] of byAlias) {
      if (!list.some((p) => p.status === 'draft')) continue;
      byAlias.set(
        a,
        list.map((p) => {
          if (p.status !== 'draft') return p;
          accepted.push(p.id);
          return { ...p, status: 'accepted' as const };
        }),
      );
      touched.add(a);
    }
  }
  for (const a of touched) await store.writePromises(a, (byAlias.get(a) ?? []).sort(byPromiseId));

  const all = [...byAlias.values()].flat();
  let contradictions = await store.readContradictions();
  let contradictionsChecked = false;
  let conflictCheck: ContradictionStats | null = null;
  const recompiled = sources.some((s) => !s.skipped);
  if (recompiled || opts.force) {
    // The program compares typed facets first (no AI); the model, when there is one, reads only undecided pairs.
    const found = await findContradictions(all, contradictions, model);
    usage.push(...found.usage);
    contradictions = found.contradictions;
    contradictionsChecked = true;
    conflictCheck = found.stats;
    await store.writeContradictions(contradictions);
  }
  return {
    sources,
    contradictions,
    contradictionsChecked,
    conflictCheck,
    accepted: accepted.sort(),
    usage,
    costUsd: usage.reduce((sum, u) => sum + u.usd, 0),
    mode: model ? model.mode : 'none',
  };
}

/** Accepts draft promises by id (or all drafts). Unknown or retired ids are an error; nothing is written then. */
/** A person rules on a conflict: 'real' (fix a source) or 'not-a-conflict' (both can be kept). */
export async function ruleConflict(
  store: Store,
  id: string,
  status: 'real' | 'not-a-conflict',
  ruling: { by: string; why: string; at: string },
): Promise<Contradiction> {
  const all = await store.readContradictions();
  const c = all.find((x) => x.id === id);
  if (!c) throw new JuratorError('UNKNOWN_CONFLICT', `No conflict ${id}. Run ${BRAND.command} conflicts to see the ids.`);
  if (ruling.why.trim().length < 3) throw new JuratorError('BAD_INPUT', 'Say why with --why "<reason>".');
  const updated: Contradiction = { ...c, status, ruling: { ...ruling, why: ruling.why.trim() } };
  await store.writeContradictions(all.map((x) => (x.id === id ? updated : x)));
  return updated;
}

export async function acceptPromises(
  store: Store,
  ids: readonly string[],
  all: boolean,
): Promise<{ accepted: string[]; already: string[] }> {
  const promises = await store.readPromises();
  const byId = new Map(promises.map((p) => [p.id, p]));
  const want = all ? promises.filter((p) => p.status === 'draft').map((p) => p.id) : [...new Set(ids)];
  for (const id of want) {
    const p = byId.get(id);
    if (!p) throw new JuratorError('UNKNOWN_PROMISE', `No promise ${id}. Run ${BRAND.command} promises to see the ids.`);
    if (p.status === 'retired') {
      throw new JuratorError('PROMISE_RETIRED', `${id} is retired (its sentence left the policy); it cannot be accepted.`);
    }
  }
  const accepted = want.filter((id) => byId.get(id)?.status === 'draft');
  const already = want.filter((id) => byId.get(id)?.status === 'accepted');
  const aliases = new Set(accepted.map(aliasOf));
  for (const a of aliases) {
    const items = promises
      .filter((p) => aliasOf(p.id) === a)
      .map((p) => (accepted.includes(p.id) ? { ...p, status: 'accepted' as const } : p))
      .sort(byPromiseId);
    await store.writePromises(a, items);
  }
  return { accepted: accepted.sort(), already: already.sort() };
}

/** Repo-relative, '/'-separated path for a user-given file path. */
export function repoPath(repoRoot: string, cwd: string, file: string): string {
  const abs = isAbsolute(file) ? file : resolve(cwd, file);
  return relative(repoRoot, abs).split(sep).join('/');
}

/** Promises whose scope (or the default code scope when empty) matches any of `files`. */
export function promisesFor(
  promises: readonly PromiseRecord[],
  files: readonly string[],
  codeScope: readonly string[],
): PromiseRecord[] {
  return promises.filter((p) => {
    const globs = p.scope.length ? p.scope : codeScope;
    return files.some((f) => matchesAny(f, globs));
  });
}

export function aliasFromPath(path: string): string {
  const base = basename(path, extname(path))
    .toLowerCase()
    .replace(/[^a-z0-9-]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 32);
  return /^[a-z]/u.test(base) ? base : `p-${base}`.slice(0, 32);
}

/** Adds a policy file to config.sources. JSON exports with Praesidia settings use the praesidia connector. */
export async function addFileSource(
  store: Store,
  cwd: string,
  file: string,
  wantAlias: string | undefined,
): Promise<{ source: PolicySourceConfig; already: boolean }> {
  const locator = repoPath(store.repoRoot, cwd, file);
  if (locator.startsWith('..')) throw new JuratorError('BAD_INPUT', `${file} is outside this repo.`);
  const abs = join(store.repoRoot, locator);
  const info = await stat(abs).catch(() => null);
  if (!info?.isFile()) throw new JuratorError('BAD_INPUT', `No file at ${locator}.`);
  const config = await store.readConfig();
  const same = config.sources.find((s) => s.locator === locator);
  if (same) return { source: same, already: true };
  const name = wantAlias ?? aliasFromPath(locator);
  if (!aliasSchema.safeParse(name).success) {
    throw new JuratorError('BAD_INPUT', `"${name}" is not a valid alias (lowercase letters, digits and -; starts with a letter).`);
  }
  if (config.sources.some((s) => s.alias === name)) {
    throw new JuratorError('BAD_INPUT', `The alias ${name} is taken. Pick another with --alias.`);
  }
  let connector = 'file';
  if (extname(locator).toLowerCase() === '.json') {
    const text = await readFile(abs, 'utf8');
    if (/"(dataRetentionDays|allowedTools)"\s*:/u.test(text)) connector = 'praesidia';
  }
  const source: PolicySourceConfig = { alias: name, connector, locator };
  const next: Config = { ...config, sources: [...config.sources, source] };
  await store.writeConfig(next);
  return { source, already: false };
}

/** Appends one sentence to .jurator/sources/local.md and makes sure the `local` source is configured. */
export async function addLocalPromise(store: Store, sentence: string): Promise<{ path: string; added: boolean }> {
  const clean = sentence.replace(/\s+/gu, ' ').trim();
  if (clean.length < 3) throw new JuratorError('BAD_INPUT', 'Write the promise as a sentence, e.g. --promise "We never log tokens."');
  const abs = join(store.dir, 'sources', `${LOCAL_ALIAS}.md`);
  const locator = relative(store.repoRoot, abs).split(sep).join('/');
  const current = await readFile(abs, 'utf8').catch(() => '');
  const lines = current.split('\n').map((l) => l.replace(/^\s*-\s+/u, '').trim());
  const added = !lines.includes(clean);
  if (added) {
    const head = current.length ? (current.endsWith('\n') ? current : `${current}\n`) : `# Local promises\n\nAdded with \`${BRAND.command} add --promise\`. Each line is kept word for word.\n\n`;
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, `${head}- ${clean}\n`, 'utf8');
  }
  const config = await store.readConfig();
  if (!config.sources.some((s) => s.alias === LOCAL_ALIAS)) {
    await store.writeConfig({ ...config, sources: [...config.sources, { alias: LOCAL_ALIAS, connector: 'file', locator }] });
  }
  return { path: locator, added };
}
