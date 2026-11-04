// Owner: WP-W. Finds policy files for `jurator init` (no AI, filesystem only, never reads outside the repo).
import { readdir, readFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { alias as aliasSchema, type PolicySourceConfig } from '../contracts.js';
import { JuratorError } from '../util/errors.js';
import { BRAND } from '../brand.js';

const POLICY_NAME = /privacy|security|terms|policy/iu;
/** A policy file anywhere in the repo (e.g. `tpl/help/privacy.md`, `apps/docs/policies/security.mdx`) by exact name. */
const POLICY_FILE = /^(?:privacy|privacy[-_ ]?(?:policy|notice|statement)|security|security[-_ ]?policy|gdpr|data[-_ ]?(?:policy|protection|processing)|dpa|subprocessors)$/iu;
const DOC_EXT = new Set(['.md', '.mdx', '.markdown']);
const SKIP_DIRS = new Set(['node_modules', '.git', BRAND.folder, 'dist', 'build']);
/** Folders that never hold the product's code (scope inference), on top of SKIP_DIRS and dot-folders. */
const NOT_CODE_DIRS = new Set([
  ...SKIP_DIRS, 'vendor', 'third_party', 'docs', 'doc', 'test', 'tests', '__tests__', 'spec', 'examples', 'example',
  'fixtures', 'scripts', 'coverage', 'out', 'target',
]);
const CODE_EXT = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'go', 'py', 'rb', 'java', 'kt', 'rs', 'php', 'cs', 'swift', 'ex', 'exs',
  'scala', 'vue', 'svelte', 'prisma',
]);
/** Bounds for the repo walks: a monorepo with 100k files must not make `init` slow. */
const MAX_DEPTH = 8;
const MAX_WALK_FILES = 50_000;

/** `Privacy Policy.md` -> `privacy-policy`; always a valid alias. */
export function aliasFromName(fileName: string): string {
  let slug = basename(fileName, extname(fileName))
    .toLowerCase()
    .replace(/[^a-z0-9-]+/gu, '-')
    .replace(/-+/gu, '-')
    .replace(/^-|-$/gu, '');
  if (!/^[a-z]/u.test(slug)) slug = `p-${slug}`;
  slug = slug.slice(0, 32).replace(/-$/u, '');
  return aliasSchema.parse(slug || 'policy');
}

function isDoc(name: string): boolean {
  return DOC_EXT.has(extname(name).toLowerCase());
}

/** Every file under `rel` (repo-relative, '/'-separated), skipping `skip` folders and dot-folders, bounded. */
async function walk(root: string, rel: string, skip: ReadonlySet<string>, out: string[], depth = 0): Promise<void> {
  if (depth > MAX_DEPTH || out.length >= MAX_WALK_FILES) return;
  let entries;
  try {
    entries = await readdir(join(root, rel), { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const e of entries) {
    if (out.length >= MAX_WALK_FILES) return;
    const path = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (!skip.has(e.name) && !e.name.startsWith('.')) await walk(root, path, skip, out, depth + 1);
    } else if (e.isFile()) out.push(path);
  }
}

async function isPraesidiaExport(path: string): Promise<boolean> {
  try {
    const raw: unknown = JSON.parse(await readFile(path, 'utf8'));
    return Boolean(raw && typeof raw === 'object' && ('dataRetentionDays' in raw || 'allowedTools' in raw));
  } catch {
    return false;
  }
}

function uniqueAlias(wanted: string, taken: Set<string>): string {
  let a = wanted;
  for (let n = 2; taken.has(a); n += 1) a = aliasSchema.parse(`${wanted.slice(0, 29)}-${n}`);
  taken.add(a);
  return a;
}

/**
 * Policy files in a repo (file connector): `docs/**` and root Markdown (`.md`, `.mdx`, `.markdown`) whose name has
 * privacy|security|terms|policy, plus Markdown anywhere named exactly like a policy (`privacy`, `security`, `gdpr`,
 * `data-policy`, ...), e.g. `tpl/help/privacy.md` or `apps/docs/content/docs/policies/security.mdx`. And
 * `policies/*.json` with a `dataRetentionDays` or `allowedTools` key (praesidia connector).
 */
export async function detectSources(
  repoRoot: string,
  /** R4-WS workspace mode: skip the code repo folders, and every Markdown file under `policies/` is a policy. */
  options: { readonly skipDirs?: readonly string[]; readonly policiesFolder?: boolean } = {},
): Promise<PolicySourceConfig[]> {
  const all: string[] = [];
  await walk(repoRoot, '', options.skipDirs ? new Set([...SKIP_DIRS, ...options.skipDirs]) : SKIP_DIRS, all);
  const texts = all
    .filter((p) => isDoc(p))
    .filter((p) => {
      const name = basename(p);
      const nearTop = !p.includes('/') || p.startsWith('docs/');
      if (options.policiesFolder === true && p.startsWith('policies/')) return true;
      return (nearTop && POLICY_NAME.test(name)) || POLICY_FILE.test(basename(name, extname(name)));
    })
    .sort();

  const praesidia: string[] = [];
  try {
    for (const e of await readdir(join(repoRoot, 'policies'), { withFileTypes: true })) {
      if (e.isFile() && e.name.toLowerCase().endsWith('.json') && (await isPraesidiaExport(join(repoRoot, 'policies', e.name)))) {
        praesidia.push(`policies/${e.name}`);
      }
    }
  } catch {
    // no policies/ folder
  }
  praesidia.sort();

  const taken = new Set<string>();
  const sources: PolicySourceConfig[] = texts.map((locator) => ({
    alias: uniqueAlias(aliasFromName(locator), taken),
    connector: 'file',
    locator,
  }));
  for (const locator of praesidia) {
    const wanted = praesidia.length === 1 ? 'praesidia' : aliasFromName(locator);
    sources.push({ alias: uniqueAlias(wanted, taken), connector: 'praesidia', locator });
  }
  return sources;
}

/** Parses `alias=connector:locator` (from `--source`). */
export function parseSourceFlag(value: string, knownConnectors: readonly string[]): PolicySourceConfig {
  const m = /^([^=]+)=([^:]+):(.+)$/u.exec(value);
  if (!m) {
    throw new JuratorError('BAD_ARGS', `--source "${value}" should look like alias=connector:locator, e.g. privacy=file:docs/privacy.md.`);
  }
  const [, a, connector, locator] = m as unknown as [string, string, string, string];
  const parsed = aliasSchema.safeParse(a);
  if (!parsed.success) {
    throw new JuratorError('BAD_ARGS', `Alias "${a}" must be lowercase letters, digits or '-', starting with a letter.`);
  }
  if (!knownConnectors.includes(connector)) {
    throw new JuratorError('UNKNOWN_CONNECTOR', `No connector "${connector}". Known connectors: ${knownConnectors.join(', ')}.`);
  }
  return { alias: parsed.data, connector, locator };
}

/**
 * Where the product's code lives, for `config.codeScope`. Keeps `fallback` (the default `src/**`, `app/**`, `lib/**`)
 * when the repo has code in one of those folders, so existing layouts do not change. Otherwise one glob per top folder
 * and code extension (`handlers/**\/*.go`, `packages/**\/*.tsx`) plus root files (`*.go`), skipping docs, tests,
 * vendored and build folders; `fallback` again when no code is found.
 */
export async function detectCodeScope(repoRoot: string, fallback: readonly string[]): Promise<string[]> {
  const files: string[] = [];
  await walk(repoRoot, '', NOT_CODE_DIRS, files);
  const fallbackTops = new Set(fallback.map((g) => g.split('/')[0] as string));
  const globs = new Set<string>();
  for (const path of files) {
    const ext = extname(path).slice(1).toLowerCase();
    if (!CODE_EXT.has(ext)) continue;
    const slash = path.indexOf('/');
    if (slash < 0) {
      globs.add(`*.${ext}`);
      continue;
    }
    const top = path.slice(0, slash);
    if (fallbackTops.has(top)) return [...fallback];
    globs.add(`${top}/**/*.${ext}`);
  }
  return globs.size > 0 ? [...globs].sort() : [...fallback];
}
