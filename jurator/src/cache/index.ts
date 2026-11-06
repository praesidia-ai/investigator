// Owner: WP-C. Content-addressed verdict cache + policy state (never rescan everything). Keep signatures.
//
// remember the pair (code commit, policy state). Policies same + code same -> nothing to recheck.
// Code changed -> only the promises whose code changed. Policies changed -> only the promises that changed.
// Every key is a sha256 over content (promise text, rule text, git blob ids), so a key hit is the same question.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { reanchor as realReanchor } from '../bindings/index.js';
import {
  checkResultSchema,
  commitSha,
  sha256Hex,
  type Binding,
  type CheckResult,
  type GitRepo,
  type PromiseRecord,
  type Rule,
  type Store,
} from '../contracts.js';
import { isWorkspaceRepo, repoParts, runGit } from '../git/index.js';
import { sha256, stableJson } from '../util/json.js';
import { PROMPT_VERSION } from '../model/preamble.js';

export type ReanchorFn = (
  binding: Binding,
  repo: GitRepo,
  commit: string,
) => Promise<{ startLine: number; endLine: number; quote: string; status: 'same' | 'moved' | 'changed' } | null>;

/* ------------------------------ digests ------------------------------ */

/**
 * The fields that decide a promise's verdict. Leaves out the policy file's sha and the quote's offsets: an edit
 * elsewhere in the same policy shifts them but does not change this promise, so it must not force a recheck.
 */
export function promiseDigest(p: PromiseRecord): string {
  return sha256(
    stableJson({
      id: p.id,
      wording: p.wording,
      quote: { alias: p.quote.alias, text: p.quote.text, jsonPointer: p.quote.jsonPointer ?? null },
      kind: p.kind,
      checkable: p.checkable,
      scope: [...p.scope].sort(),
      params: p.params ?? null,
      facets: p.facets ?? null,
      ...(p.obligation ? { obligation: p.obligation } : {}), // only when present: older digests stay the same
    }),
  );
}
/** The fields that decide what a rule says (not when it was written or proven). */
export function ruleDigest(r: Rule): string {
  return sha256(
    stableJson({
      id: r.id,
      promiseId: r.promiseId,
      description: r.description,
      mode: r.mode,
      pattern: r.pattern,
      flags: r.flags ?? '',
      anchor: r.anchor ?? null,
      within: r.within ?? null,
      globs: r.globs,
      ...(r.semantic ? { semantic: r.semantic } : {}), // only when present: older digests stay the same
    }),
  );
}
/** A promise with an empty scope is about the config's default code scope; the key must see that scope. */
export function withEffectiveScope(promises: readonly PromiseRecord[], codeScope: readonly string[]): PromiseRecord[] {
  return promises.map((p) => (p.scope.length > 0 ? p : { ...p, scope: [...codeScope] }));
}

/** sha256 over accepted promises' digests + accepted rules' digests (stable order). */
export function policyStateOf(promises: readonly PromiseRecord[], rules: readonly Rule[]): string {
  const ps = promises
    .filter((p) => p.status === 'accepted')
    .map((p) => `${p.id}:${promiseDigest(p)}`)
    .sort();
  const rs = rules
    .filter((r) => r.status === 'accepted')
    .map((r) => `${r.id}:${ruleDigest(r)}`)
    .sort();
  return sha256(stableJson({ promises: ps, rules: rs }));
}

/* ------------------------------ code identity ------------------------------ */

const trees = new Map<string, Promise<Map<string, string> | null>>();

/**
 * path -> blob id at `commit`; null when this is not a real git repo (test fakes). In a multi-repo workspace (R4-WS)
 * each repo's tree at its own commit, with repo-prefixed paths.
 */
async function treeOf(repo: GitRepo, commit: string): Promise<Map<string, string> | null> {
  if (!isWorkspaceRepo(repo)) return singleTreeOf(repo, commit);
  let parts;
  try {
    parts = await repoParts(repo, commit);
  } catch {
    return null;
  }
  const map = new Map<string, string>();
  for (const part of parts) {
    const tree = await singleTreeOf(part.repo, part.commit);
    if (!tree) return null;
    for (const [path, id] of tree) map.set(`${part.prefix}${path}`, id);
  }
  return map;
}

/** path -> blob id at `commit` from one `git ls-tree -r`; null when this is not a real git repo (test fakes). */
function singleTreeOf(repo: GitRepo, commit: string): Promise<Map<string, string> | null> {
  const key = `${repo.root}\0${commit}`;
  let tree = trees.get(key);
  if (!tree) {
    tree = (async () => {
      if (!/^[0-9a-f]{7,64}$/u.test(commit)) return null;
      try {
        const out = await runGit(repo.root, ['ls-tree', '-r', '-z', '--full-tree', commit]);
        if (out.code !== 0) return null;
        const map = new Map<string, string>();
        for (const entry of out.stdout.split('\0')) {
          const tab = entry.indexOf('\t');
          if (tab < 0) continue;
          const id = entry.slice(0, tab).split(' ')[2];
          if (id) map.set(entry.slice(tab + 1), id);
        }
        return map;
      } catch {
        return null;
      }
    })();
    trees.set(key, tree);
  }
  return tree;
}

/** [path, blob id] for each path at `commit` (git's blob id; sha256 of the text when git is not there). */
export async function blobIds(repo: GitRepo, commit: string, paths: readonly string[]): Promise<Array<[string, string]>> {
  const unique = [...new Set(paths)].sort();
  const tree = await treeOf(repo, commit);
  const out: Array<[string, string]> = [];
  for (const path of unique) {
    if (tree) {
      out.push([path, tree.get(path) ?? 'missing']);
      continue;
    }
    try {
      out.push([path, `sha256:${sha256(await repo.readFile(commit, path))}`]);
    } catch {
      out.push([path, 'missing']);
    }
  }
  return out;
}

/** Bump when the engine's answers can change for the same rule and code. Old cache entries then become misses. */
export const EVALUATOR_VERSION = '2';

/** What decides an answer besides promise, rules and code: the reader model, the config scope. */
export interface KeyIdentity {
  /** The AI reader, when one may answer: exact model identity (not its mode) and reasoning effort. */
  readonly reader?: { readonly id: string; readonly effort?: string | undefined } | null;
  readonly codeScope?: readonly string[];
}

/** The same identity as one sha256, for the zero-work fast path. */
export function engineIdentity(rules: readonly Rule[], codeScope: readonly string[], bindings: readonly Binding[] = []): string {
  const b = [...bindings].sort((x, y) => x.id.localeCompare(y.id)).map((x) => ({ id: x.id, promiseId: x.promiseId, path: x.path, quote: x.quote, expected: x.expected ?? null }));
  return sha256(stableJson({ evaluator: EVALUATOR_VERSION, analyzers: analyzersOf(rules), codeScope: [...codeScope].sort(), bindings: b }));
}
export function readerIdentity(reader: { id: string; effort?: string | undefined } | null): string | null {
  return reader ? `${reader.id}|${reader.effort ?? ''}|${PROMPT_VERSION}` : null;
}
const analyzersOf = (rules: readonly Rule[]): string[] =>
  rules.map((r) => (r.semantic ? `${r.id}:${r.semantic.adapter}@${r.semantic.adapterVersion}` : `${r.id}:regex`)).sort();

/**
 * sha256 over the promise, its accepted rules and its code dependency.
 *  - With rules: the blob ids of `scopeFiles` (the caller passes the files matching the rules' globs). Exact, because
 *    a rule's answer depends only on those files; bindings never narrow it (a new route in a new file must recheck).
 *  - Without rules but with bindings: the bound quotes re-anchored at `commit` (lost -> null) AND the blob ids of the
 *    files the AI read actually reads (`scopeFiles`): surrounding or imported code may matter, and a new file in scope
 *    is a new effect path. Files outside the scope still reuse.
 *  - Otherwise: the blob ids of `scopeFiles`.
 */
export async function cacheKeyFor(
  promise: PromiseRecord,
  rules: readonly Rule[],
  bindings: readonly Binding[],
  repo: GitRepo,
  commit: string,
  scopeFiles: readonly string[],
  reanchor: ReanchorFn = realReanchor,
  identity: KeyIdentity = {},
): Promise<string> {
  const ruleParts = rules.map((r) => `${r.id}:${ruleDigest(r)}`).sort();
  let code: unknown;
  const own = bindings.filter((b) => b.promiseId === promise.id).sort((a, b) => a.id.localeCompare(b.id));
  if (rules.length === 0 && own.length > 0) {
    const bound: Array<[string, string, string | null]> = [];
    for (const b of own) {
      let quote: string | null = null;
      try {
        quote = (await reanchor(b, repo, commit))?.quote ?? null;
      } catch {
        quote = null;
      }
      bound.push([b.id, b.path, quote]);
    }
    code = { bound, files: await blobIds(repo, commit, scopeFiles) };
  } else {
    code = { files: await blobIds(repo, commit, scopeFiles) };
  }
  // An AI read answers only when no rule does (or a rule could not run): the reader identity counts then.
  const reader = identity.reader ? { id: identity.reader.id, effort: identity.reader.effort ?? null } : null;
  return sha256(
    stableJson({
      v: 2,
      evaluator: EVALUATOR_VERSION,
      prompts: PROMPT_VERSION,
      analyzers: analyzersOf(rules),
      reader,
      codeScope: identity.codeScope ? [...identity.codeScope].sort() : null,
      promise: promiseDigest(promise),
      rules: ruleParts,
      code,
    }),
  );
}

/* ------------------------------ local cache files ------------------------------ */

const entrySchema = z.object({ result: checkResultSchema, runId: z.string().min(1), commit: commitSha });
const verifiedSchema = z.object({
  schemaVersion: z.literal(1),
  commit: commitSha,
  policyState: sha256Hex,
  runId: z.string().min(1),
  at: z.string().min(10),
  /** Engine identity (evaluator, analyzers, scope) and reader identity at that run; absent in old files = a miss. */
  engine: z.string().optional(),
  reader: z.string().nullable().optional(),
});

async function writeAtomic(path: string, text: string): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, text, 'utf8');
  await rename(tmp, path);
}
function cachePath(store: Store, key: string): string | null {
  return /^[0-9a-f]{64}$/u.test(key) ? join(store.dir, 'local', 'cache', `${key}.json`) : null;
}

/** Local cache under .jurator/local/cache/ (gitignored): cacheKey -> {result, runId, commit}. */
export async function lookup(store: Store, key: string): Promise<{ result: CheckResult; runId: string; commit: string } | null> {
  const path = cachePath(store, key);
  if (!path) return null;
  try {
    const parsed = entrySchema.safeParse(JSON.parse(await readFile(path, 'utf8')));
    return parsed.success ? parsed.data : null;
  } catch {
    return null; // missing or half-written: a miss, never an error
  }
}
export async function remember(store: Store, key: string, entry: { result: CheckResult; runId: string; commit: string }): Promise<void> {
  const path = cachePath(store, key);
  if (!path) return;
  const parsed = entrySchema.parse(entry);
  await writeAtomic(path, `${JSON.stringify(parsed, null, 2)}\n`);
}
/** The last verified pair for this repo: {code commit, policyState, runId, at}; null when none. */
export async function lastVerified(
  store: Store,
): Promise<{ commit: string; policyState: string; runId: string; at: string; engine?: string; reader?: string | null } | null> {
  try {
    const parsed = verifiedSchema.safeParse(JSON.parse(await readFile(join(store.dir, 'local', 'verified.json'), 'utf8')));
    if (!parsed.success) return null;
    const { commit, policyState, runId, at, engine, reader } = parsed.data;
    return { commit, policyState, runId, at, ...(engine !== undefined ? { engine } : {}), ...(reader !== undefined ? { reader } : {}) };
  } catch {
    return null;
  }
}
export async function recordVerified(
  store: Store,
  entry: { commit: string; policyState: string; runId: string; at: string; engine?: string; reader?: string | null },
): Promise<void> {
  const value = verifiedSchema.parse({ schemaVersion: 1, ...entry });
  await writeAtomic(join(store.dir, 'local', 'verified.json'), `${JSON.stringify(value, null, 2)}\n`);
}
