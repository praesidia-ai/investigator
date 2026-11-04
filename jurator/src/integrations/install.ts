// Owner: WP-D. `jurator hook install`: adds Jurator to git and agent hook files, never clobbering what is there.
import { existsSync, realpathSync } from 'node:fs';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { delimiter, dirname, isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JuratorError } from '../util/errors.js';
import { prettyJson } from '../util/json.js';
import type { HookKind } from './index.js';
import { BRAND } from '../brand.js';
import { FAIL_CLOSED_ENV, FAIL_CLOSED_FLAG } from './failmode.js';

/** templates/ sits at the package root: two levels up from both src/integrations and dist/integrations. */
export const TEMPLATES_DIR = fileURLToPath(new URL('../../templates/hooks/', import.meta.url));

export interface Launcher {
  /** Absolute path of the node binary. */
  readonly node: string;
  /** Absolute path of jurator's bin.js. */
  readonly bin: string;
}

export interface InstallOptions {
  readonly repoRoot: string;
  /** Where git looks for hooks (core.hooksPath or .git/hooks). Needed for pre-push. */
  readonly hooksDir: string | null;
  readonly launcher: Launcher;
  /** Claude Code only: write .claude/settings.local.json (not committed) instead of .claude/settings.json. */
  readonly local?: boolean;
  /** Block (pre-push) or deny (agent) when the check cannot finish, instead of a warning. */
  readonly failClosed?: boolean;
  readonly templatesDir?: string;
}

export interface InstallResult {
  readonly kind: HookKind;
  /** installed: written now · already: Jurator was there · manual: a file exists we will not touch */
  readonly status: 'installed' | 'already' | 'manual';
  readonly path: string;
  readonly lines: string[];
}

/**
 * A node path that survives upgrades: the first `node` on PATH that is the same binary as `execPath`
 * (e.g. /opt/homebrew/bin/node instead of /opt/homebrew/Cellar/node/26.10.0_1/bin/node), else `execPath`.
 */
export function stableNodePath(execPath: string, pathEnv: string | undefined): string {
  let real: string;
  try {
    real = realpathSync(execPath);
  } catch {
    return execPath;
  }
  for (const dir of (pathEnv ?? '').split(delimiter)) {
    if (!dir || !isAbsolute(dir)) continue;
    const candidate = join(dir, 'node');
    try {
      if (realpathSync(candidate) === real) return candidate;
    } catch {
      // not there; keep looking
    }
  }
  return execPath;
}

/** POSIX single-quote a value for sh. */
export function shellQuote(value: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/u.test(value) ? value : `'${value.replace(/'/gu, `'\\''`)}'`;
}

export function launcherCommand(l: Launcher): string {
  return `${shellQuote(l.node)} ${shellQuote(l.bin)}`;
}

function fill(value: unknown, vars: Readonly<Record<string, string>>): unknown {
  if (typeof value === 'string') return Object.entries(vars).reduce((s, [k, v]) => s.replaceAll(`{{${k}}}`, v), value);
  if (Array.isArray(value)) return value.map((v) => fill(v, vars));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, fill(v, vars)]));
  }
  return value;
}

export async function installHook(kind: HookKind, options: InstallOptions): Promise<InstallResult> {
  const templates = options.templatesDir ?? TEMPLATES_DIR;
  if (kind === 'pre-push') return installPrePush(options, templates);
  const file =
    kind === 'claude'
      ? join(options.repoRoot, '.claude', options.local ? 'settings.local.json' : 'settings.json')
      : join(options.repoRoot, '.muse', 'hooks.json');
  const template = kind === 'claude' ? 'claude-settings.json' : 'muse-hooks.json';
  const vars = {
    COMMAND: launcherCommand(options.launcher),
    FLAGS: options.failClosed ? ` ${FAIL_CLOSED_FLAG}` : '',
    BRAND_NAME: BRAND.name,
  };
  return mergeJsonHooks(kind, file, join(templates, template), vars, options.repoRoot, options.failClosed === true);
}

async function installPrePush(options: InstallOptions, templates: string): Promise<InstallResult> {
  if (!options.hooksDir) throw new JuratorError('NOT_A_GIT_REPO', 'Not inside a git repository, so there is no pre-push hook to install.');
  const path = join(options.hooksDir, 'pre-push');
  const envPrefix = options.failClosed ? `${FAIL_CLOSED_ENV}=1 ` : '';
  const runLine = `${envPrefix}${launcherCommand(options.launcher)} hook run pre-push "$@" || exit 1`;
  if (existsSync(path)) {
    const current = await readFile(path, 'utf8');
    if (current.includes('hook run pre-push')) {
      return { kind: 'pre-push', status: 'already', path, lines: [`${BRAND.name} is already in ${path}.`] };
    }
    return {
      kind: 'pre-push',
      status: 'manual',
      path,
      lines: [
        `A pre-push hook already exists at ${path}; ${BRAND.name} did not change it.`,
        'Add this line to it (near the top: it reads the refs git sends on stdin, so it must read them first):',
        `  ${runLine}`,
      ],
    };
  }
  const text = (await readFile(join(templates, 'pre-push'), 'utf8'))
    .replaceAll('{{NODE}}', shellQuote(options.launcher.node))
    .replaceAll('{{BIN}}', shellQuote(options.launcher.bin))
    .replaceAll('{{FAIL_CLOSED}}', options.failClosed ? '1' : '${' + FAIL_CLOSED_ENV + ':-0}')
    .replaceAll('{{FAIL_CLOSED_ENV}}', FAIL_CLOSED_ENV)
    .replaceAll('{{BRAND_NAME}}', BRAND.name)
    .replaceAll('{{BRAND_COMMAND}}', BRAND.command);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text, 'utf8');
  await chmod(path, 0o755);
  return {
    kind: 'pre-push',
    status: 'installed',
    path,
    lines: [
      `Installed the git pre-push hook: ${path}`,
      'Every git push now runs your rules on the pushed commits (no AI, offline).',
      options.failClosed
        ? 'Fail-closed: if a rule errors or times out, the push is blocked.'
        : `If a rule errors or times out, the push goes ahead with a warning (${FAIL_CLOSED_FLAG} to block instead).`,
    ],
  };
}

interface HookGroup {
  matcher?: string;
  hooks?: Array<{ command?: unknown }>;
}

async function mergeJsonHooks(
  kind: 'claude' | 'muse',
  file: string,
  templatePath: string,
  vars: Readonly<Record<string, string>>,
  repoRoot: string,
  failClosed: boolean,
): Promise<InstallResult> {
  const marker = `hook run ${kind}`;
  const template = fill(JSON.parse(await readFile(templatePath, 'utf8')), vars) as { hooks: { PreToolUse: HookGroup[] } };
  let settings: Record<string, unknown> = {};
  if (existsSync(file)) {
    const raw = await readFile(file, 'utf8');
    try {
      const parsed: unknown = raw.trim() ? JSON.parse(raw) : {};
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
      settings = parsed as Record<string, unknown>;
    } catch {
      throw new JuratorError('BAD_SETTINGS_FILE', `${file} is not a JSON object, so ${BRAND.name} did not change it. Fix it and run this again.`);
    }
  }
  const hooks = (settings.hooks && typeof settings.hooks === 'object' && !Array.isArray(settings.hooks) ? settings.hooks : {}) as Record<string, unknown>;
  const pre = Array.isArray(hooks.PreToolUse) ? (hooks.PreToolUse as HookGroup[]) : [];
  const shown = relative(repoRoot, file) || file;
  const already = pre.some((g) => Array.isArray(g?.hooks) && g.hooks.some((h) => typeof h?.command === 'string' && h.command.includes(marker)));
  if (already) return { kind, status: 'already', path: file, lines: [`${BRAND.name} is already in ${shown}.`] };
  settings.hooks = { ...hooks, PreToolUse: [...pre, ...template.hooks.PreToolUse] };
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, prettyJson(settings), 'utf8');
  const agent = kind === 'claude' ? 'Claude Code' : 'Muse Code';
  const lines = [
    `Added a ${agent} PreToolUse hook to ${shown}.`,
    `${agent} can no longer push a broken promise, skip hooks, edit ${BRAND.folder}/, or accept rules for you.`,
  ];
  if (failClosed) lines.push('Fail-closed: if the check cannot finish, the push is denied.');
  if (kind === 'claude' && !file.endsWith('settings.local.json')) {
    lines.push('It holds absolute paths for this machine; use --local to write .claude/settings.local.json instead.');
  }
  if (kind === 'muse') lines.push('Muse Code runs project hooks only in a trusted folder (accept the trust prompt, or --trust-workspace).');
  lines.push('Start a new agent session to load it.');
  return { kind, status: 'installed', path: file, lines };
}
