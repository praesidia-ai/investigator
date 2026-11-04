// Owner: WP-D. Git and agent hooks: pre-push (git), PreToolUse (Claude Code, Muse Code), and their installers.
export type HookKind = 'pre-push' | 'claude' | 'muse';
export const HOOK_KINDS: readonly HookKind[] = ['pre-push', 'claude', 'muse'];

export { analyzeShell, touchesHookFiles, touchesJurator, type ShellAnalysis } from './shell.js';
export {
  AGENT_HOOK_TIMEOUT_MS,
  FAIL_CLOSED_ENV,
  FAIL_CLOSED_FLAG,
  failClosedFrom,
  HOOK_TIMEOUT_ENV,
  HookTimeoutError,
  PRE_PUSH_TIMEOUT_MS,
  timeoutFrom,
  uncheckedOf,
  withDeadline,
  type HookOptions,
  type Unchecked,
} from './failmode.js';
export {
  blockingResults,
  choosePushTarget,
  defaultBaseCandidates,
  isZeroSha,
  parsePrePushInput,
  targetFromCandidates,
  type CheckTarget,
  type HookGit,
  type PushUpdate,
} from './prepush.js';
export {
  brokenReason,
  decideToolUse,
  formatDecision,
  parseToolEvent,
  uncheckedReason,
  type AgentHookDeps,
  type DecideOptions,
  type AgentKind,
  type HookDecision,
  type PushCheckOutcome,
  type ToolEvent,
} from './agent.js';
export { agentPushTarget, displayPath, runAgentHook, runPrePush, type HookDeps, type HookIo, type RenderExtra } from './run.js';
export { installHook, launcherCommand, shellQuote, stableNodePath, type InstallOptions, type InstallResult, type Launcher } from './install.js';
export { gitHooksDir, gitTopLevel, makeHookGit } from './git.js';
export { rulesCheck, type RulesCheckOutcome } from './checker.js';
