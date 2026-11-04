// Owner: WP-D. PreToolUse hooks for coding agents (Claude Code and Muse Code share the same answer shape).
import { resolve as resolvePath } from 'node:path';
import { BRAND } from '../brand.js';
import type { CheckResult, CheckRun } from '../contracts.js';
import { policyWhere } from '../render/index.js';
import { failOpenHint, uncheckedLines, uncheckedOf } from './failmode.js';
import { blockingResults } from './prepush.js';
import { analyzeShell, touchesHookFiles, touchesJurator } from './shell.js';

export type AgentKind = 'claude' | 'muse';

/** The parts of a PreToolUse payload Jurator reads. Both agents send `tool_name`, `tool_input` and `cwd`. */
export interface ToolEvent {
  readonly toolName: string;
  readonly toolInput: unknown;
  readonly cwd: string;
}

/** `warning`: the push goes ahead although something could not be checked (fail-open); the hook says so loudly. */
export type HookDecision = { readonly kind: 'allow'; readonly warning?: string } | { readonly kind: 'deny'; readonly reason: string };

export interface PushCheckOutcome {
  /** null when there is nothing to check (no .jurator/ in this repo). */
  readonly run: CheckRun | null;
  readonly runPath: string | null;
  /** Source alias -> locator, so the policy line reads docs/privacy.md:7 rather than privacy:7. */
  readonly sources?: Readonly<Record<string, string>>;
}

export interface AgentHookDeps {
  /** Runs the rules-only check (no AI) for `main...HEAD` in the repo at `cwd`. */
  checkPush(cwd: string): Promise<PushCheckOutcome>;
}

/** Muse Code caps hook stdout at 16 KiB; keep the reason well under it. */
const MAX_REASON = 6000;

export function parseToolEvent(text: string, fallbackCwd: string): ToolEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const toolName = typeof record.tool_name === 'string' ? record.tool_name : null;
  if (!toolName) return null;
  const cwd = typeof record.cwd === 'string' && record.cwd.length > 0 ? record.cwd : fallbackCwd;
  return { toolName, toolInput: record.tool_input ?? {}, cwd };
}

export function isShellTool(name: string): boolean {
  return /^(bash|shell|sh|zsh|terminal)$|shell|bash|exec_command|run_command|terminal_cmd|execute_command/iu.test(name);
}

export function isWriteTool(name: string): boolean {
  if (isShellTool(name) || name.startsWith('mcp__')) return false;
  return /edit|write|patch|create|replace|delete|remove|move|rename/iu.test(name);
}

function quoteWord(word: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/u.test(word) ? word : `'${word.replace(/'/gu, `'\\''`)}'`;
}

/** The shell command string from a tool input (`command`, `cmd`, `script`, an argv array, or a raw string). */
export function shellCommandOf(input: unknown): string | null {
  if (typeof input === 'string') return input;
  if (!input || typeof input !== 'object') return null;
  const record = input as Record<string, unknown>;
  for (const key of ['command', 'cmd', 'script', 'commandLine', 'argv', 'args']) {
    const v = record[key];
    if (typeof v === 'string') return v;
    // argv: quote each word so `['bash', '-c', 'git push --no-verify']` keeps its script as one word.
    if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return v.map(quoteWord).join(' ');
  }
  return null;
}

/** Every path a file tool would touch: string values under path-like keys, plus file headers inside patches. */
export function pathsOf(input: unknown, depth = 0): string[] {
  const out: string[] = [];
  if (depth > 5 || input === null || input === undefined) return out;
  if (typeof input === 'string') {
    for (const m of input.matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gmu)) out.push((m[1] ?? '').trim());
    for (const m of input.matchAll(/^(?:\+\+\+|---) (?:[ab]\/)?(\S+)/gmu)) out.push(m[1] ?? '');
    for (const m of input.matchAll(/^\*\*\* Move to: (.+)$/gmu)) out.push((m[1] ?? '').trim());
    return out;
  }
  if (Array.isArray(input)) {
    for (const item of input) out.push(...pathsOf(item, depth + 1));
    return out;
  }
  if (typeof input === 'object') {
    for (const [key, v] of Object.entries(input as Record<string, unknown>)) {
      const pathKey = /path|file|target|dest|notebook|^to$|^from$/iu.test(key);
      if (pathKey && typeof v === 'string') out.push(v);
      else if (pathKey && Array.isArray(v)) out.push(...v.filter((x): x is string => typeof x === 'string'));
      else out.push(...pathsOf(v, depth + 1));
    }
  }
  return out;
}

const JURATOR_EDIT_REASON =
  `${BRAND.name}: ${BRAND.folder}/ holds your team's promises and rules, so agents may not edit it directly. ` +
  `Change it through ${BRAND.command} commands (for example \`${BRAND.command} rule propose <promise-id>\`), which a person reviews.`;

const HOOK_FILES_REASON =
  `${BRAND.name}: this changes where git looks for hooks, or the hook files themselves (core.hooksPath, .git/hooks/, ` +
  '.claude/settings*.json, .muse/hooks.json), which would turn the promise check off. A person changes these, not an agent.';

const DECIDE_REASON =
  `${BRAND.name}: accepting promises or rules (\`accept\`, \`rule accept\`, \`--accept\`) and ruling on conflicts are ` +
  `decisions a person makes, so agents may not run them. Ask the person to review it: \`${BRAND.command} rule list\` and ` +
  `\`${BRAND.command} promises\` show what is waiting.`;

const NO_VERIFY_REASON =
  `${BRAND.name}: this push skips git hooks (--no-verify or core.hooksPath), so the promise check would not run. ` +
  'Push without skipping hooks; if a promise is broken, fix the code first.';

function locationOf(result: CheckResult): string {
  const c = result.citations[0] ?? result.ruleResults?.flatMap((r) => r.hits)[0];
  if (!c) return '';
  const range = c.endLine > c.startLine ? `${c.startLine}-${c.endLine}` : `${c.startLine}`;
  const quote = c.quote.split('\n')[0]?.trim() ?? '';
  return `${c.path}:${range}${quote ? `  ${quote}` : ''}`;
}

/** Plain-text evidence for broken promises: what was promised, where it is written, which line breaks it. */
export function brokenReason(
  results: readonly CheckResult[],
  runPath: string | null,
  sources?: Readonly<Record<string, string>>,
): string {
  const n = results.length;
  const lines = [`${BRAND.name} blocked this push: ${n} promise${n === 1 ? ' is' : 's are'} broken (proved by a rule, no AI).`];
  for (const r of results) {
    lines.push(`- ${r.promiseId} BROKEN: ${r.wording}`);
    const q = r.policyQuote;
    lines.push(`  Policy (${policyWhere(q, sources)}): "${q.text.trim()}"`);
    const where = locationOf(r);
    if (where) lines.push(`  Code: ${where}`);
    const message = r.explanation ?? r.ruleResults?.find((x) => x.outcome === 'fail')?.message;
    if (message) lines.push(`  Rule: ${message}`);
  }
  lines.push(`Fix the code so the promise holds, or change the policy (a person reviews it) and run ${BRAND.command} compile; then push again.`);
  if (runPath) lines.push(`Full record (re-check it with no AI): ${BRAND.command} verify ${runPath}`);
  const text = lines.join('\n');
  return text.length > MAX_REASON ? `${text.slice(0, MAX_REASON - 20)}\n... (cut short)` : text;
}

/** Plain text for a push that could not be fully checked (a rule error or timeout). */
export function uncheckedReason(lines: readonly string[], failClosed: boolean): string {
  const head = failClosed
    ? `${BRAND.name} blocked this push: some promises could not be checked, and fail-closed is on.`
    : `WARNING: ${BRAND.name} could not check some promises; this push is NOT fully checked.`;
  const tail = failClosed
    ? `Fix the rule (\`${BRAND.command} rule test\` shows the error), or ask a person to push.`
    : failOpenHint();
  const text = [head, ...lines, tail].join('\n');
  return text.length > MAX_REASON ? `${text.slice(0, MAX_REASON - 20)}\n... (cut short)` : text;
}

export interface DecideOptions {
  /** Deny the push when a rule errors or times out (default: allow with a warning). */
  readonly failClosed?: boolean;
}

export async function decideToolUse(event: ToolEvent, deps: AgentHookDeps, options: DecideOptions = {}): Promise<HookDecision> {
  if (isWriteTool(event.toolName)) {
    const paths = pathsOf(event.toolInput);
    if (paths.some(touchesJurator)) return { kind: 'deny', reason: JURATOR_EDIT_REASON };
    if (paths.some(touchesHookFiles)) return { kind: 'deny', reason: HOOK_FILES_REASON };
    return { kind: 'allow' };
  }
  if (!isShellTool(event.toolName)) return { kind: 'allow' };
  const command = shellCommandOf(event.toolInput);
  if (!command) return { kind: 'allow' };
  const shell = analyzeShell(command);
  if (shell.writesJurator) return { kind: 'deny', reason: JURATOR_EDIT_REASON };
  if (shell.decides) return { kind: 'deny', reason: DECIDE_REASON };
  if (shell.tampersHooks) return { kind: 'deny', reason: HOOK_FILES_REASON };
  if (!shell.pushes) return { kind: 'allow' };
  if (shell.skipsHooks) return { kind: 'deny', reason: NO_VERIFY_REASON };
  const dir = shell.pushDir ? resolveDir(event.cwd, shell.pushDir) : event.cwd;
  const outcome = await deps.checkPush(dir);
  if (!outcome.run) return { kind: 'allow' };
  const broken = blockingResults(outcome.run);
  if (broken.length > 0) return { kind: 'deny', reason: brokenReason(broken, outcome.runPath, outcome.sources) };
  const unchecked = uncheckedOf(outcome.run);
  if (unchecked.length === 0) return { kind: 'allow' };
  const reason = uncheckedReason(uncheckedLines(unchecked), options.failClosed === true);
  return options.failClosed === true ? { kind: 'deny', reason } : { kind: 'allow', warning: reason };
}

/** `cd ~/x` and `$VARS` are not expanded (no shell is run): those pushes are checked in the hook's own cwd. */
function resolveDir(cwd: string, dir: string): string {
  if (dir.startsWith('~') || dir.includes('$')) return cwd;
  return resolvePath(cwd, dir);
}

/**
 * The stdout a hook prints: a deny decision as JSON, or nothing for allow (exit 0, no output). A Claude Code allow with
 * a warning prints `systemMessage` (shown to the person; it does not approve the tool call). Muse Code gets the
 * warning on stderr only (its hook answer shape documents deny, not systemMessage).
 */
export function formatDecision(agent: AgentKind, decision: HookDecision): string | null {
  if (decision.kind === 'allow') return decision.warning && agent === 'claude' ? JSON.stringify({ systemMessage: decision.warning }) : null;
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: decision.reason,
    },
  });
}
