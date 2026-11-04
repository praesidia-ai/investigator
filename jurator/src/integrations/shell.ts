// Owner: WP-D (hardened by FU-3). Reads a shell command line the way a hook needs to: does it push, skip hooks,
// write .jurator/, or record a person's decision? A rough reader on purpose (no shell is ever run): it splits on
// ; && || | & ( ) and newlines, honours simple quotes, and reads into `bash -c`, `eval`, `$(...)`, `xargs`,
// `find -exec` and inline interpreter code (`python -c`, `node -e`, heredocs). It cannot see inside a script file.

import { BRAND } from '../brand.js';

export interface ShellAnalysis {
  /** The command runs `git push` somewhere. */
  readonly pushes: boolean;
  /** The push skips git hooks (`--no-verify`, `-c core.hooksPath=...`, GIT_CONFIG_* env). */
  readonly skipsHooks: boolean;
  /** Directory the push runs in, from `git -C <dir>` or an earlier `cd <dir>`, as written (may be relative). */
  readonly pushDir: string | null;
  /** The command looks like it changes files under .jurator/ (rm, mv, redirect, sed -i, tee, python -c ...). */
  readonly writesJurator: boolean;
  /** It records a person's decision: `jurator accept`, `rule accept`, `--accept`, `conflicts --rule`, `decide`. */
  readonly decides: boolean;
  /** It turns the hooks off for later pushes: `git config core.hooksPath`, or writes to .git/hooks/ or agent hook settings. */
  readonly tampersHooks: boolean;
}

const MAX_DEPTH = 4;
const WRAPPERS = new Set([
  'sudo', 'doas', 'command', 'builtin', 'env', 'exec', 'time', 'nohup', 'nice', 'ionice', 'xargs', 'timeout', 'stdbuf',
  'caffeinate', 'chronic', 'unbuffer', 'setsid', 'then', 'do', 'else', 'elif', 'if', 'while', 'until', '!', '{', '}',
]);
/** Wrapper options that take the next token as their value. */
const WRAPPER_VALUE_OPTS: Readonly<Record<string, readonly string[]>> = {
  sudo: ['-u', '-g', '-C', '-D', '-h', '-p', '-U', '-r', '-t'],
  doas: ['-u', '-C'],
  env: ['-u', '-C', '-S', '-P'],
  xargs: ['-I', '-L', '-n', '-P', '-d', '-E', '-s', '-a', '-J', '-R'],
  nice: ['-n'],
  ionice: ['-c', '-n', '-p'],
  timeout: ['-s', '-k'],
  stdbuf: ['-i', '-o', '-e'],
};
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'mksh', 'ash', 'fish', 'busybox']);
const INTERPRETER = /^(python[0-9.]*|pypy[0-9.]*|node|nodejs|deno|bun|perl|ruby|php|osascript|pwsh|powershell|lua|tclsh|rscript|tsx|ts-node)$/iu;
const WRITE_ANY_ARG = new Set([
  'rm', 'rmdir', 'mv', 'tee', 'truncate', 'touch', 'chmod', 'chown', 'chflags', 'unlink', 'mkdir', 'shred', 'sponge',
  'patch', 'ed', 'ex', 'vi', 'vim', 'nvim', 'nano', 'emacs',
]);
const WRITE_LAST_ARG = new Set(['cp', 'ln', 'install', 'rsync', 'dd', 'scp']);
const IN_PLACE = new Set(['sed', 'gsed', 'perl', 'ruby', 'awk', 'gawk']);
const GIT_WRITES = new Set(['rm', 'mv', 'restore', 'checkout', 'clean', 'apply', 'stash', 'switch', 'reset', 'am', 'cherry-pick', 'revert']);
/** In inline interpreter code: words that write, delete or move files. */
const CODE_WRITES = /write|unlink|rmtree|rmdir|remove|rename|replace|truncate|copy|move|chmod|mkdir|symlink|dump|\brm\b|\bmv\b|\bcp\b|\btee\b|open\s*\([^,)]*,\s*(?:mode\s*=\s*)?["'][wax+]|['"]w['"]/iu;

const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
const FOLDER = esc(BRAND.folder);
const TOUCHES_FOLDER = new RegExp(`(^|[\\\\/'"=:])${FOLDER}([\\\\/'"]|$)`, 'u');
const TOUCHES_HOOKS = /(^|[\\/'"=:])(\.git[\\/]hooks([\\/'"]|$)|\.claude[\\/]settings(\.local)?\.json|\.muse[\\/]hooks\.json)/u;

interface Protected {
  /** Cheap pre-check on the raw text. */
  mentions(text: string): boolean;
  touches(path: string): boolean;
}
const JURATOR: Protected = { mentions: (t) => t.includes(BRAND.folder), touches: (p) => TOUCHES_FOLDER.test(p) };
const HOOK_FILES: Protected = {
  mentions: (t) => /\.git[\\/]+hooks|\.claude[\\/]|\.muse[\\/]/u.test(t),
  touches: (p) => TOUCHES_HOOKS.test(p),
};

/** True when a path-like string names something inside a `.jurator` folder (or the folder itself). */
export function touchesJurator(path: string): boolean {
  return JURATOR.touches(path);
}

/** True for git's hook folder and the agent hook settings files (.claude/settings*.json, .muse/hooks.json). */
export function touchesHookFiles(path: string): boolean {
  return HOOK_FILES.touches(path);
}

export function splitSegments(command: string): string[] {
  const segments: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i] as string;
    if (quote) {
      current += ch;
      if (ch === '\\' && quote === '"' && i + 1 < command.length) {
        current += command[i + 1] as string;
        i += 1;
      } else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '\\' && i + 1 < command.length) {
      current += ch + (command[i + 1] as string);
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === ';' || ch === '\n' || ch === '|' || ch === '&' || ch === '(' || ch === ')' || ch === '`') {
      // `>&2`, `2>&1`, `&>` and `>|` are redirects, not separators.
      const prev = command[i - 1];
      const next = command[i + 1];
      if ((ch === '&' && (prev === '>' || next === '>')) || (ch === '|' && prev === '>')) {
        current += ch;
        continue;
      }
      segments.push(current);
      current = '';
      if ((ch === '|' || ch === '&') && next === ch) i += 1;
      continue;
    }
    current += ch;
  }
  segments.push(current);
  return segments.map((s) => s.trim()).filter((s) => s.length > 0);
}

export function tokenize(segment: string): string[] {
  const tokens: string[] = [];
  // A word may mix quoted and bare parts (`a"b c"d`); quotes are removed, backslash escapes are kept as the character.
  const re = /(?:"(?:[^"\\]|\\.)*"|'[^']*'|\\.|[^\s"'\\])+/gu;
  for (const m of segment.matchAll(re)) {
    tokens.push(
      m[0].replace(/"((?:[^"\\]|\\.)*)"|'([^']*)'|\\(.)/gu, (_all, dq: string | undefined, sq: string | undefined, bs: string | undefined) =>
        dq !== undefined ? dq.replace(/\\(.)/gu, '$1') : (sq ?? bs ?? ''),
      ),
    );
  }
  return tokens;
}

/** `$(...)` and backtick bodies, also inside double quotes (the shell runs them there too); not inside single quotes. */
export function substitutions(command: string): string[] {
  const out: string[] = [];
  let single = false;
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    if (ch === "'" && !single) {
      // a single quote inside double quotes is literal; good enough for a hook
      const close = command.indexOf("'", i + 1);
      const dq = (command.slice(0, i).match(/"/gu) ?? []).length % 2 === 1;
      if (!dq) {
        single = true;
        if (close < 0) break;
        i = close;
        single = false;
        continue;
      }
    }
    if (ch === '$' && command[i + 1] === '(') {
      let depth = 1;
      let j = i + 2;
      for (; j < command.length && depth > 0; j += 1) {
        if (command[j] === '(') depth += 1;
        else if (command[j] === ')') depth -= 1;
      }
      out.push(command.slice(i + 2, depth === 0 ? j - 1 : j));
      i = j - 1;
    } else if (ch === '`') {
      const close = command.indexOf('`', i + 1);
      out.push(command.slice(i + 1, close < 0 ? command.length : close));
      if (close < 0) break;
      i = close;
    }
  }
  return out.filter((s) => s.trim().length > 0);
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/u;

/** Strips `VAR=x`, wrappers (with their options) and shell keywords; returns the command and the env assignments. */
function stripPrefix(tokens: string[]): { tokens: string[]; assignments: string[] } {
  const assignments: string[] = [];
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i] as string;
    if (ASSIGNMENT.test(t)) {
      assignments.push(t);
      i += 1;
    } else if (WRAPPERS.has(base(t))) {
      const wrapper = base(t);
      i += 1;
      while (i < tokens.length && (tokens[i] as string).startsWith('-')) {
        const opt = tokens[i] as string;
        i += (WRAPPER_VALUE_OPTS[wrapper] ?? []).includes(opt) ? 2 : 1;
      }
      if (wrapper === 'timeout' && i < tokens.length && /^[0-9.]+[smhd]?$/u.test(tokens[i] as string)) i += 1;
    } else break;
  }
  return { tokens: tokens.slice(i), assignments };
}

function base(cmd: string): string {
  const parts = cmd.split('/');
  return parts[parts.length - 1] ?? cmd;
}

interface GitCall {
  readonly sub: string | null;
  readonly args: string[];
  readonly dir: string | null;
  readonly hooksOff: boolean;
}

const HOOKS_PATH = /core\.hookspath/iu;

function readGit(tokens: string[]): GitCall {
  let i = 1;
  let dir: string | null = null;
  let hooksOff = false;
  while (i < tokens.length) {
    const t = tokens[i] as string;
    if (t === '-C') {
      dir = tokens[i + 1] ?? null;
      i += 2;
    } else if (t === '-c' || t === '--config-env') {
      if (HOOKS_PATH.test(tokens[i + 1] ?? '')) hooksOff = true;
      i += 2;
    } else if (t.startsWith('--config-env=') || t.startsWith('-c')) {
      if (HOOKS_PATH.test(t)) hooksOff = true;
      i += 1;
    } else if (t === '--git-dir' || t === '--work-tree' || t === '--namespace' || t === '--exec-path' || t === '--super-prefix') {
      i += 2;
    } else if (t.startsWith('-')) {
      i += 1;
    } else break;
  }
  return { sub: tokens[i] ?? null, args: tokens.slice(i + 1), dir, hooksOff };
}

/** `git push --no-verify`; git also takes unambiguous abbreviations (`--no-veri`, `--no-verif`). */
const skipsVerify = (arg: string): boolean => /^--no-veri/u.test(arg);

/** `git config ... core.hooksPath <value>` / `--unset` / `set`: changes where git looks for hooks. Reads are fine. */
function setsHooksPath(args: readonly string[]): boolean {
  const key = args.findIndex((a) => HOOKS_PATH.test(a));
  if (key < 0) return false;
  const opts = args.slice(0, key);
  if (opts.some((a) => ['--get', '--get-all', '--get-regexp', '-l', '--list', 'get', 'list'].includes(a))) return false;
  if (opts.some((a) => ['--unset', '--unset-all', '--replace-all', '--add', 'set', 'unset'].includes(a))) return true;
  return args.length > key + 1 || /=/u.test(args[key] as string);
}

/** Output redirects in a segment (`> x`, `>> x`, `>| x`, `&> x`, `2> x`), as their targets. */
function redirectTargets(segment: string): string[] {
  const out: string[] = [];
  for (const m of segment.matchAll(/(?:^|[^<>&0-9])(?:[0-9]*|&)>{1,2}\|?\s*("[^"]*"|'[^']*'|[^\s;&|<>]+)/gu)) {
    const t = (m[1] ?? '').replace(/^["']|["']$/gu, '');
    if (t && !t.startsWith('&')) out.push(t);
  }
  return out;
}

function segmentWrites(segment: string, tokens: string[], area: Protected, inside: boolean): boolean {
  if (!inside && !area.mentions(segment)) return false;
  const hit = (path: string): boolean => (inside && !path.startsWith('/') && !path.startsWith('~') && !path.startsWith('..')) || area.touches(path);
  if (redirectTargets(segment).some((t) => t !== '/dev/null' && hit(t))) return true;
  const cmd = base(tokens[0] ?? '');
  const rest = tokens.slice(1);
  const operands = rest.filter((t) => !t.startsWith('-'));
  if (WRITE_ANY_ARG.has(cmd)) return operands.some(hit) || rest.some((t) => area.touches(t));
  if (WRITE_LAST_ARG.has(cmd)) {
    const last = operands[operands.length - 1];
    if (cmd === 'dd') return rest.some((t) => t.startsWith('of=') && hit(t.slice(3)));
    const target = rest.findIndex((t) => t === '-t' || t === '--target-directory');
    if (target >= 0 && hit(rest[target + 1] ?? '')) return true;
    return last !== undefined && hit(last);
  }
  if (IN_PLACE.has(cmd)) {
    const inPlace = rest.some((t) => t === '--in-place' || t.startsWith('--in-place=') || t === 'inplace' || /^-[a-zA-Z]*i/u.test(t));
    return inPlace && operands.some(hit);
  }
  if (cmd === 'curl' || cmd === 'wget') {
    const i = rest.findIndex((t) => t === '-o' || t === '-O' || t === '--output' || t === '--output-document');
    return (i >= 0 && hit(rest[i + 1] ?? '')) || rest.some((t) => /^--output(-document)?=/u.test(t) && hit(t.split('=')[1] ?? ''));
  }
  if (cmd === 'tar' || cmd === 'unzip' || cmd === 'bsdtar') {
    const i = rest.findIndex((t) => t === '-C' || t === '-d' || t === '--directory');
    return i >= 0 && hit(rest[i + 1] ?? '');
  }
  if (cmd === 'find') {
    return rest.some((t) => area.touches(t)) && rest.some((t) => t === '-delete' || t === '-exec' || t === '-execdir' || t === '-ok');
  }
  if (cmd === 'git') {
    const call = readGit(tokens);
    if (call.sub === null || !GIT_WRITES.has(call.sub)) return false;
    return call.args.some((a) => area.touches(a)) || (inside && ['checkout', 'restore', 'reset', 'clean', 'stash'].includes(call.sub));
  }
  return false;
}

/** The arguments after `jurator` when a segment runs it (directly, npx/pnpm/yarn, or `node .../bin.js`); else null. */
function juratorArgs(tokens: readonly string[]): string[] | null {
  const head = base(tokens[0] ?? '');
  const isKw = (t: string): boolean => {
    const b = base(t);
    return b === BRAND.command || b.startsWith(`${BRAND.command}@`) || b === `${BRAND.command}.js`;
  };
  if (isKw(head)) return tokens.slice(1);
  if (['npx', 'bunx', 'pnpx', 'npm', 'pnpm', 'yarn', 'bun'].includes(head)) {
    const at = tokens.slice(1, 6).findIndex(isKw);
    return at < 0 ? null : tokens.slice(at + 2).filter((t) => t !== '--');
  }
  if (/^(node|nodejs|bun|deno|tsx|ts-node)$/u.test(head)) {
    if (tokens.some((t) => /^(-e|-p|--eval|--print|-pe)$/u.test(t))) return null; // inline code, not a script
    const script = tokens.slice(1).findIndex((t) => !t.startsWith('-'));
    if (script < 0) return null;
    const path = tokens[script + 1] as string;
    if (/(^|\/)(dist|src)\/(bin|cli\/main)\.[jt]s$/u.test(path) || path.split('/').includes(BRAND.command) || isKw(path)) return tokens.slice(script + 2);
  }
  return null;
}

/** Commands that record a person's decision: a coding agent must not run them for the person. */
function isDecision(args: readonly string[]): boolean {
  const words = args.filter((a) => !a.startsWith('-'));
  const sub = words[0];
  if (args.some((a) => a === '--accept' || a.startsWith('--accept='))) return true;
  if (sub === 'accept' || sub === 'decide' || sub === 'waive') return true;
  if (sub === 'rule' && words[1] === 'accept') return true;
  if (sub === 'conflicts' && args.some((a) => /^--(rule|as)(=|$)/u.test(a))) return true;
  return false;
}

/** Inline code for an interpreter: what follows `-c`/`-e`/`--eval`/`-r`, or the whole line (heredocs, stdin). */
function looksInterpreted(code: string, analysis: Mutable): void {
  if (/\bgit\b[\s\S]{0,80}?\bpush\b/u.test(code)) {
    analysis.pushes = true;
    if (/no-veri|hookspath/iu.test(code)) analysis.skipsHooks = true;
  }
  if (HOOKS_PATH.test(code) && /config|environ|env\b|GIT_CONFIG/iu.test(code)) analysis.tampersHooks = true;
  if (JURATOR.mentions(code) && CODE_WRITES.test(code)) analysis.writesJurator = true;
  if (HOOK_FILES.mentions(code) && CODE_WRITES.test(code)) analysis.tampersHooks = true;
  const kw = new RegExp(`(?<![.\\w])${esc(BRAND.command)}\\b[\\s\\S]{0,60}?(\\baccept\\b|\\bdecide\\b|\\bwaive\\b|--accept|--rule\\b)`, 'u');
  if (kw.test(code)) analysis.decides = true;
}

type Mutable = { -readonly [K in keyof ShellAnalysis]: ShellAnalysis[K] };

/** A command whose name is computed (`$(echo git) push`, `$g push`, `git${IFS}push`) cannot be read: be cautious. */
const DYNAMIC_PUSH = /(\$\{?[A-Za-z_(]|`)[^;&|\n]*\bpush\b|\bgit\$/u;

function analyzeInto(command: string, a: Mutable, depth: number, startDir: string | null = null): void {
  if (depth > MAX_DEPTH) {
    // Nesting this deep is not how people push; read it the cautious way.
    looksInterpreted(command, a);
    return;
  }
  for (const inner of substitutions(command)) analyzeInto(inner, a, depth + 1, startDir);
  if (DYNAMIC_PUSH.test(command)) {
    a.pushes = true;
    if (/--no-veri|hookspath/iu.test(command)) a.skipsHooks = true;
  }
  let cdDir: string | null = startDir;
  let hooksEnv = false;
  let interpreted = false;
  for (const segment of splitSegments(command)) {
    const raw = tokenize(segment);
    const { tokens, assignments } = stripPrefix(raw);
    const envOff = assignments.some((x) => /^GIT_CONFIG/u.test(x) && HOOKS_PATH.test(x));
    const head = base(tokens[0] ?? '');
    const insideJurator = cdDir !== null && touchesJurator(cdDir);
    if (segmentWrites(segment, tokens, JURATOR, insideJurator)) a.writesJurator = true;
    if (segmentWrites(segment, tokens, HOOK_FILES, cdDir !== null && /(^|\/)\.git\/hooks\/?$/u.test(cdDir))) a.tampersHooks = true;
    if (head === 'export' || head === 'declare' || head === 'typeset' || (tokens.length === 0 && assignments.length > 0)) {
      if (tokens.slice(1).concat(assignments).some((x) => /^GIT_CONFIG/u.test(x) && HOOKS_PATH.test(x))) hooksEnv = true;
      continue;
    }
    if (head === 'cd' || head === 'pushd') {
      cdDir = tokens.filter((t) => !t.startsWith('-'))[1] ?? null;
      continue;
    }
    const kwArgs = juratorArgs(tokens);
    if (kwArgs && isDecision(kwArgs)) a.decides = true;
    if (SHELLS.has(head)) {
      const flag = tokens.findIndex((t, i) => i > 0 && /^-[a-zA-Z]*c[a-zA-Z]*$/u.test(t));
      const script = flag > 0 ? tokens.slice(flag + 1).find((t) => !t.startsWith('-')) : undefined;
      if (script !== undefined) analyzeInto(script, a, depth + 1, cdDir);
      continue;
    }
    if (head === 'eval') {
      analyzeInto(tokens.slice(1).join(' '), a, depth + 1, cdDir);
      continue;
    }
    if (head === 'find') {
      const exec = tokens.findIndex((t) => t === '-exec' || t === '-execdir' || t === '-ok');
      if (exec > 0) {
        const end = tokens.findIndex((t, i) => i > exec && (t === ';' || t === '\\;' || t === '+'));
        analyzeInto(tokens.slice(exec + 1, end < 0 ? undefined : end).join(' '), a, depth + 1);
      }
      continue;
    }
    if (INTERPRETER.test(head) && !kwArgs) {
      interpreted = true;
      continue;
    }
    if (head !== 'git') continue;
    const call = readGit(tokens);
    if (call.sub === 'config' && setsHooksPath(call.args)) a.tampersHooks = true;
    if (call.sub !== 'push') continue;
    a.pushes = true;
    a.pushDir = call.dir ?? cdDir;
    if (call.hooksOff || envOff || hooksEnv || call.args.some(skipsVerify)) a.skipsHooks = true;
  }
  // Inline code and heredoc bodies cannot be parsed as shell: look for the words instead.
  if (interpreted) looksInterpreted(command, a);
}

export function analyzeShell(command: string): ShellAnalysis {
  const a: Mutable = { pushes: false, skipsHooks: false, pushDir: null, writesJurator: false, decides: false, tampersHooks: false };
  analyzeInto(command, a, 0);
  return a;
}
