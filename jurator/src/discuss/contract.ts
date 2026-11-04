// Owner: DS-0. The core <-> UI contract of `jurator discuss`.
//
// Copy this file VERBATIM to `src/discuss/contract.ts` (DS-A and DS-B both add it with identical bytes, so the merge
// on `next` is clean). Neither task edits it. If a change is unavoidable it is append-only (new optional fields, new
// union members), recorded in the task journal, and made identically in both branches.
//
// DS-A implements `DiscussSession` (src/discuss/core/**) and exports `openDiscussSession: OpenDiscussSession`.
// DS-B renders the events and slash results (src/discuss/tui/**) and drives a fake session until DS-A lands.
//
// Principles carried by the types:
//  - Read-only: no event, slash result or tool can accept, waive, edit or write anything except the session
//    transcript under .jurator/local/discuss/ (gitignored). Actions are `next` hints: the exact command the user runs.
//  - Evidence is program output: every `Citation.quote` and `PolicyExcerpt.text` is copied by the program from git at
//    `SessionInfo.snapshot` (or from the stored policy text) and masked; model text never becomes evidence.
//  - The words follow the level: verdict labels come from src/render LABELS, never from the model.
import type { Citation, CodeSnapshot, Level, Verdict } from '../contracts.js';

/* ============================== models and limits ============================== */

export type DiscussModel = 'wonder' | 'spark';
export const DISCUSS_MODEL_IDS: Readonly<Record<DiscussModel, string>> = {
  wonder: 'muse-wonder-1.0',
  spark: 'muse-spark-1.3',
};

export const DISCUSS_LIMITS = {
  /** Session budget in USD when `--budget` is absent. */
  defaultBudgetUsd: 3,
  /** Model calls in one turn (each call may ask for several tools at once). */
  maxRoundsPerTurn: 12,
  /** Tool calls in one turn, all rounds together. */
  maxToolCallsPerTurn: 40,
  /** Characters of one tool result sent back to the model (longer results are cut and say so). */
  maxToolResultChars: 12_000,
  /** search_code: hits in total and per file; characters per hit line. */
  maxSearchHits: 50,
  maxSearchHitsPerFile: 5,
  maxLineChars: 240,
  /** read_lines: lines per call. */
  maxReadLines: 120,
  /** list_files: paths per call. */
  maxListFiles: 300,
  /** policy_text: lines per call. */
  maxPolicyLines: 200,
  /** Evidence boxes the UI shows per tool result before "+N more" (all are kept in the transcript). */
  maxEvidenceShown: 3,
  /** Lines shown in one evidence box before "… N more in the transcript". */
  maxBoxLines: 8,
  /** Cite markers resolved per answer, and lines per marker. */
  maxCiteMarkers: 10,
  maxCiteLines: 30,
  /** list_promises / last_check rows, list_rules rows, compare_policies pairs, show_finding citations. */
  maxPromiseRows: 200,
  maxRuleRows: 100,
  maxComparePairs: 50,
  maxFindingCitations: 5,
  /** Tool results older than this many turns are replaced by their one-line summary in the model history. */
  keepToolResultsTurns: 2,
  /** Ctrl-C on an empty editor arms exit; a second press within this window exits. */
  exitConfirmMs: 2000,
  /** The editor grows to this many lines, then scrolls. */
  maxEditorLines: 8,
  /** Pastes longer than this many lines show as `[paste #n +N lines]` in the editor. */
  pasteMarkerLines: 10,
} as const;

/* ============================== tools (read-only) ============================== */

export const DISCUSS_TOOL_NAMES = [
  'list_promises',
  'explain_promise',
  'last_check',
  'show_finding',
  'list_rules',
  'search_code',
  'read_lines',
  'list_files',
  'policy_text',
  'compare_policies',
  // DS-C: proposals only. They run nothing; the program shows a card and waits for the user.
  'propose_action',
  'propose_policy_edit',
] as const;
export type DiscussToolName = (typeof DISCUSS_TOOL_NAMES)[number];

/** Policy text copied by the program from .jurator/sources/<alias>.* (the locked version), 1-based lines. */
export interface PolicyExcerpt {
  readonly alias: string;
  /** e.g. 'docs/privacy.md' or the connector locator. */
  readonly where: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly text: string;
  readonly sha256: string;
}

/** A `[[path:12-14]]` marker in the answer that the program could not copy from git at the snapshot. */
export interface UnresolvedCite {
  readonly marker: string;
  readonly reason: 'not-found' | 'secret-file' | 'out-of-range' | 'too-long' | 'bad-marker';
}

/* ============================== session ============================== */

export interface DiscussRepoInfo {
  /** The path prefix in a multi-repo workspace ('' for a single repo). */
  readonly name: string;
  readonly branch: string | null;
  readonly commit: string;
  readonly dirty: boolean;
}

/** What the header and footer show. `info()` returns a fresh copy; the UI may call it after every event. */
export interface SessionInfo {
  /** Absolute workspace root (the folder holding .jurator/). */
  readonly root: string;
  /** Folder name of the root, for the header. */
  readonly name: string;
  readonly repos: readonly DiscussRepoInfo[];
  /** The code every tool reads, fixed when the session opens (a commit, never the working tree). */
  readonly snapshot: CodeSnapshot;
  readonly model: DiscussModel;
  readonly modelId: string;
  readonly mode: 'live' | 'scripted';
  readonly budgetUsd: number;
  readonly spentUsd: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Accepted promises. */
  readonly promises: number;
  readonly lastCheck: {
    readonly id: string;
    readonly createdAt: string;
    readonly commit: string;
    /** True when the run's commit is not the session snapshot (its findings may be out of date). */
    readonly stale: boolean;
    readonly broken: number;
    readonly looksBroken: number;
  } | null;
  /** Where the transcript is written (after every turn); null with --no-save. */
  readonly transcriptPath: string | null;
  /** True while a `send` is running. */
  readonly busy: boolean;
  readonly turns: number;
  /** DS-C: the action waiting for the user's yes or no (only one at a time). */
  readonly pendingAction?: ActionCard | null;
  /** DS-C: the policy edit waiting for /apply. */
  readonly pendingEdit?: PolicyEditCard | null;
}

export interface OpenDiscussOptions {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly model?: DiscussModel;
  readonly budgetUsd?: number;
  /** Directory of recorded turns: no network call is ever made (tests, demos). */
  readonly scriptedDir?: string;
  /** False: no transcript file (`--no-save`). Default true. */
  readonly save?: boolean;
  readonly now?: () => Date;
}

/** Throws JuratorError NO_WORKSPACE / MODEL_KEY_REQUIRED / BAD_INPUT before any screen is drawn. */
export type OpenDiscussSession = (options: OpenDiscussOptions) => Promise<DiscussSession>;

export interface DiscussSession {
  info(): SessionInfo;
  /**
   * One user turn. Yields events in this order:
   *   turn-start, then any number of rounds of [thinking, (tool-call, tool-result)*, usage], then text (once, `full`;
   *   or several `delta`s), then evidence (only when the answer has cite markers), then done.
   * `done` is always the last event, exactly once, also after `error` or a cancel. Never throws: failures are an
   * `error` event followed by `done`. A second `send` while one runs yields error BUSY + done.
   * Aborting `signal` stops the model call in flight and the tool loop; the turn ends with done {reason:'cancelled'}
   * and is dropped from the model's history (it stays in the transcript, marked cancelled). The session stays usable.
   */
  send(text: string, signal: AbortSignal): AsyncIterable<DiscussEvent>;
  /**
   * A line starting with '/'. Needs no model and spends nothing. Unknown commands and bad arguments return
   * {kind:'error'}; it never throws. '/exit' returns {kind:'exit'} and the UI exits after `close()`.
   */
  slash(line: string): Promise<SlashResult>;
  /** Flushes the transcript. Safe to call twice. */
  close(): Promise<void>;
  /**
   * DS-C: runs the pending action (the user said yes) as a new turn: turn-start, action-start, action-output*,
   * action-done, then the agent discusses the result (thinking/tool/usage/text/evidence), then done. Same rules as send.
   */
  confirm?(signal: AbortSignal): AsyncIterable<DiscussEvent>;
  /** DS-C: the user said no: the card is dropped and the agent is told on the next turn. */
  decline?(): Promise<SlashResult>;
}

/* ============================== events ============================== */

export type DiscussErrorCode =
  | 'BUSY'
  | 'BUDGET'
  | 'ROUND_LIMIT'
  | 'MODEL_KEY_REQUIRED'
  | 'MODEL_FAILED'
  | 'MODEL_INCOMPLETE'
  | 'SCRIPT_MISSING'
  | 'TOOL_FAILED'
  | 'BAD_INPUT';

export type DiscussEvent =
  | { readonly type: 'turn-start'; readonly turn: number; readonly at: string }
  /** A model call started (round 1 = first call of the turn). No reasoning text is ever shown or stored. */
  | { readonly type: 'thinking'; readonly turn: number; readonly round: number }
  | {
      readonly type: 'tool-call';
      readonly turn: number;
      /** Unique within the session; pairs the call with its result. */
      readonly id: string;
      readonly name: DiscussToolName;
      readonly args: Readonly<Record<string, unknown>>;
      /** One short line made by the program, e.g. `search_code "upload"` or `read_lines api/app.ts:12-30`. */
      readonly label: string;
    }
  | {
      readonly type: 'tool-result';
      readonly turn: number;
      readonly id: string;
      readonly name: DiscussToolName;
      readonly ok: boolean;
      /** One short line made by the program, e.g. `12 hits in 4 files` or `refused: .env files are never read`. */
      readonly summary: string;
      /** Code copied from git at the snapshot, masked. Shown as boxes for read_lines/show_finding/explain_promise. */
      readonly evidence?: readonly Citation[];
      readonly policy?: readonly PolicyExcerpt[];
      /** True when the result sent to the model was cut at a limit. */
      readonly truncated?: boolean;
      readonly ms: number;
    }
  /** The answer. The live provider is non-streaming, so DS-A sends one `full`; a later streaming provider sends deltas. */
  | { readonly type: 'text'; readonly turn: number; readonly full: string; readonly delta?: never }
  | { readonly type: 'text'; readonly turn: number; readonly delta: string; readonly full?: never }
  /**
   * The answer's `[[path:12-14]]` markers, each copied by the program from git at the snapshot (masked). Shown as
   * evidence boxes under the answer; markers that could not be copied are listed as unverified.
   */
  | {
      readonly type: 'evidence';
      readonly turn: number;
      readonly citations: readonly Citation[];
      readonly policy: readonly PolicyExcerpt[];
      readonly unresolved: readonly UnresolvedCite[];
    }
  /** After every model call. in/out/usd are that call's; totals are the session's. */
  | {
      readonly type: 'usage';
      readonly turn: number;
      readonly in: number;
      readonly out: number;
      readonly usd: number;
      readonly totalUsd: number;
      readonly budgetUsd: number;
    }
  | {
      readonly type: 'done';
      readonly turn: number;
      readonly reason: 'answered' | 'cancelled' | 'error';
      readonly ms: number;
      /** This turn's cost, all rounds. */
      readonly usd: number;
    }
  | {
      readonly type: 'error';
      readonly turn: number;
      readonly code: DiscussErrorCode;
      /** Plain words, no upstream text, no key. */
      readonly message: string;
      /** The exact next step, e.g. `/budget 5` or `jurator check`. */
      readonly next?: string;
    }
  /** DS-C: action cards, policy edit cards and confirmed runs. */
  | DiscussActionEvent;

/* ============================== slash commands ============================== */

export interface SlashCommandInfo {
  /** Without the slash, e.g. 'explain'. */
  readonly name: string;
  /** e.g. '<promise id>' or 'wonder|spark'; '' when none. */
  readonly args: string;
  readonly summary: string;
}

/** The commands, in /help order. DS-B completes from this list; DS-A dispatches on it. */
export const DISCUSS_SLASH_COMMANDS: readonly SlashCommandInfo[] = [
  { name: 'help', args: '', summary: 'Keys and commands' },
  { name: 'promises', args: '', summary: 'The accepted promises' },
  { name: 'findings', args: '', summary: 'What the last check found' },
  { name: 'explain', args: '<promise id>', summary: 'A promise: quote, rules, bindings, last verdict' },
  { name: 'rule', args: '<promise id | rule id>', summary: 'The rules of a promise' },
  { name: 'model', args: 'wonder|spark', summary: 'Show or switch the model' },
  { name: 'cost', args: '', summary: 'Tokens and dollars, per turn and in total' },
  { name: 'budget', args: '<usd>', summary: 'Show or set the session budget' },
  { name: 'save', args: '', summary: 'Write the transcript now and show its path' },
  { name: 'clear', args: '', summary: 'Start a fresh conversation (the model forgets it)' },
  { name: 'exit', args: '', summary: 'Leave (Ctrl-D)' },
];

export interface PromiseRow {
  readonly id: string;
  readonly wording: string;
  readonly kind: 'must' | 'must-not' | 'may';
  readonly checkable: 'code' | 'process' | 'runtime';
  readonly rules: number;
  readonly bindings: number;
  /** From the last check, when it has this promise. */
  readonly verdict: Verdict | null;
}

export interface FindingRow {
  readonly promiseId: string;
  readonly wording: string;
  readonly verdict: Verdict;
  readonly level: Level;
  /** From src/render LABELS, e.g. 'BROKEN (rule, no AI)'. */
  readonly label: string;
  readonly explanation: string | null;
  readonly citations: readonly Citation[];
}

export interface RuleRow {
  readonly id: string;
  readonly promiseId: string;
  readonly status: 'proposed' | 'accepted';
  readonly description: string;
  readonly mode: 'must-match' | 'must-not-match' | 'each-near';
  readonly globs: readonly string[];
  readonly provenToFail: boolean;
}

export interface PromiseDetail {
  readonly row: PromiseRow;
  readonly policy: PolicyExcerpt;
  readonly rules: readonly RuleRow[];
  /** Bound lines re-copied from git at the snapshot; `moved` when the anchored text is no longer there. */
  readonly bindings: ReadonlyArray<{ readonly id: string; readonly symbol: string | null; readonly citation: Citation | null; readonly moved: boolean }>;
  readonly finding: FindingRow | null;
}

export interface TurnCost {
  readonly turn: number;
  readonly question: string;
  readonly in: number;
  readonly out: number;
  readonly usd: number;
}

export type SlashResult =
  | { readonly kind: 'help'; readonly commands: readonly SlashCommandInfo[]; readonly keys: ReadonlyArray<{ readonly key: string; readonly does: string }> }
  | { readonly kind: 'promises'; readonly items: readonly PromiseRow[] }
  | {
      readonly kind: 'findings';
      readonly run: { readonly id: string; readonly createdAt: string; readonly commit: string; readonly stale: boolean } | null;
      readonly items: readonly FindingRow[];
      /** e.g. `jurator check` when there is no run or it is stale. */
      readonly next?: string;
    }
  | { readonly kind: 'explain'; readonly detail: PromiseDetail }
  | { readonly kind: 'rule'; readonly promiseId: string; readonly rules: readonly RuleRow[]; readonly next?: string }
  | { readonly kind: 'model'; readonly model: DiscussModel; readonly modelId: string; readonly changed: boolean }
  | { readonly kind: 'cost'; readonly turns: readonly TurnCost[]; readonly in: number; readonly out: number; readonly totalUsd: number; readonly budgetUsd: number }
  | { readonly kind: 'budget'; readonly budgetUsd: number; readonly spentUsd: number; readonly changed: boolean }
  | { readonly kind: 'saved'; readonly path: string }
  | { readonly kind: 'cleared' }
  | { readonly kind: 'exit' }
  | { readonly kind: 'error'; readonly code: 'UNKNOWN_COMMAND' | 'BAD_INPUT' | 'NOT_FOUND' | 'BUSY' | 'NO_SAVE'; readonly message: string; readonly usage?: string }
  /** DS-C: the user's decisions and answers to action cards. */
  | DecisionResult;

/* ============================== helpers both sides use ============================== */

export interface CiteMarker {
  /** The marker as written, e.g. '[[api/app.ts:12-14]]'. */
  readonly marker: string;
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
}

/**
 * The cite markers the model writes in an answer: `[[path:12]]` or `[[path:12-14]]` (workspace paths keep their repo
 * prefix). DS-A resolves them against git; DS-B renders each one dim in the answer text and the boxes below it.
 * Markers whose end is before their start are returned as written; the resolver reports them as 'bad-marker'.
 */
export function parseCiteMarkers(text: string): CiteMarker[] {
  const out: CiteMarker[] = [];
  for (const m of text.matchAll(/\[\[([^\]\s:]+):(\d{1,7})(?:-(\d{1,7}))?\]\]/gu)) {
    const startLine = Number(m[2]);
    out.push({ marker: m[0], path: m[1] ?? '', startLine, endLine: m[3] === undefined ? startLine : Number(m[3]) });
  }
  return out;
}

/** True for input the UI sends to `slash` instead of `send` ('/x', not '//x' and not a bare '/'). */
export function isSlashLine(text: string): boolean {
  const t = text.trimStart();
  return t.startsWith('/') && !t.startsWith('//') && /^\/[a-z]/u.test(t);
}

/** Commands whose name starts with what was typed after '/', for Tab completion. */
export function completeSlash(prefix: string): SlashCommandInfo[] {
  const p = prefix.replace(/^\//u, '').toLowerCase();
  return [...DISCUSS_SLASH_COMMANDS, ...DISCUSS_DECISION_COMMANDS].filter((c) => c.name.startsWith(p));
}

/** A turn both sides can use in tests: DS-A's scripted tests expect this shape, DS-B's fake session replays it. */
export const EXAMPLE_TURN: readonly DiscussEvent[] = [
  { type: 'turn-start', turn: 1, at: '2026-11-04T11:30:00.000Z' },
  { type: 'thinking', turn: 1, round: 1 },
  { type: 'tool-call', turn: 1, id: 't1', name: 'search_code', args: { pattern: 'chrome.storage' }, label: 'search_code "chrome.storage"' },
  { type: 'tool-result', turn: 1, id: 't1', name: 'search_code', ok: true, summary: '3 hits in 2 files', ms: 41 },
  { type: 'usage', turn: 1, in: 5210, out: 310, usd: 0.027, totalUsd: 0.027, budgetUsd: 3 },
  { type: 'thinking', turn: 1, round: 2 },
  { type: 'tool-call', turn: 1, id: 't2', name: 'read_lines', args: { path: 'chrome-extension/src/background.ts', start: 40, end: 44 }, label: 'read_lines chrome-extension/src/background.ts:40-44' },
  {
    type: 'tool-result',
    turn: 1,
    id: 't2',
    name: 'read_lines',
    ok: true,
    summary: '5 lines',
    evidence: [
      {
        path: 'chrome-extension/src/background.ts',
        commit: '9f3c2a1e',
        startLine: 40,
        endLine: 44,
        quote: "async function saveDraft(d) {\n  await chrome.storage.local.set({ draft: d });\n}\n\n",
      },
    ],
    ms: 12,
  },
  { type: 'usage', turn: 1, in: 5900, out: 420, usd: 0.032, totalUsd: 0.059, budgetUsd: 3 },
  {
    type: 'text',
    turn: 1,
    full: 'The extension writes drafts to `chrome.storage.local` in **saveDraft** [[chrome-extension/src/background.ts:41]].',
  },
  {
    type: 'evidence',
    turn: 1,
    citations: [
      { path: 'chrome-extension/src/background.ts', commit: '9f3c2a1e', startLine: 41, endLine: 41, quote: '  await chrome.storage.local.set({ draft: d });' },
    ],
    policy: [],
    unresolved: [],
  },
  { type: 'done', turn: 1, reason: 'answered', ms: 6120, usd: 0.059 },
];

/* ============================== DS-C: actions the user confirms (appended) ============================== */
//
// The agent still never runs, accepts or writes anything itself. It may PROPOSE one Jurator command as an action card
// (what runs, why, estimated cost and time); the program runs it in-process only after the user confirms (Enter/y or
// /run) and feeds a program-made summary of the result back into the conversation. Decisions (accept, waive, rule
// accept, conflict rulings, policy edits) are never actions: the agent drafts the slash command and the user types it.

/** The Jurator commands the agent may propose. Everything else (accept, conflicts --rule, --accept flags) is refused. */
export const DISCUSS_ACTION_COMMANDS = ['init', 'pull', 'compile', 'rule propose', 'bind', 'check', 'report', 'explain', 'status'] as const;
export type DiscussActionCommand = (typeof DISCUSS_ACTION_COMMANDS)[number];

/** A proposed run, made by the program from the agent's structured request (the agent never writes the argv). */
export interface ActionCard {
  /** Unique within the session, e.g. 'a1'. */
  readonly id: string;
  readonly command: DiscussActionCommand;
  /** What runs in-process, without the command name, e.g. ['check', '--diff', 'main', '--budget', '2.85']. */
  readonly argv: readonly string[];
  /** The line the user would type, e.g. 'jurator check --diff main' (no internal flags such as --budget). */
  readonly line: string;
  /** The agent's reason, shown as its words (never evidence). Program-proposed cards say who proposed them. */
  readonly why: string;
  /** Who proposed it: the agent, or the program (e.g. compile after /apply). */
  readonly by: 'agent' | 'program';
  /** True when the command may call the model (it spends money). */
  readonly paid: boolean;
  /** The program's estimate, in USD and seconds, and what it is based on. */
  readonly estimate: { readonly lowUsd: number; readonly highUsd: number; readonly lowSeconds: number; readonly highSeconds: number; readonly basis: string };
  /** The most this run may spend (passed as --budget where the command takes one); null for free commands. */
  readonly capUsd: number | null;
}

/** A proposed change to a policy file: the old lines are copied by the program from the file, the new ones are the agent's. */
export interface PolicyEditCard {
  readonly id: string;
  readonly alias: string;
  /** The policy file, relative to the workspace root (e.g. 'docs/privacy.md'). */
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  /** The current lines, copied from the file by the program. */
  readonly before: string;
  /** The proposed lines (agent text: a draft, never evidence). */
  readonly after: string;
  /** A unified diff made by the program from before/after. */
  readonly diff: string;
  readonly why: string;
  /** sha256 of the whole file when the edit was proposed: /apply refuses when the file changed since. */
  readonly fileSha256: string;
}

/** The action events (members of DiscussEvent). */
export type DiscussActionEvent =
  | { readonly type: 'action-proposed'; readonly turn: number; readonly action: ActionCard }
  | { readonly type: 'policy-edit-proposed'; readonly turn: number; readonly edit: PolicyEditCard }
  | { readonly type: 'action-start'; readonly turn: number; readonly action: ActionCard }
  /** One line the running command printed (ANSI stripped, secrets masked). */
  | { readonly type: 'action-output'; readonly turn: number; readonly id: string; readonly line: string }
  | {
      readonly type: 'action-done';
      readonly turn: number;
      readonly id: string;
      readonly line: string;
      readonly exitCode: number;
      readonly ms: number;
      /** What the command's model calls cost (also added to the session's meter). */
      readonly usd: number;
      /** Program-made lines: what changed in the records (findings, drafts, rules, bindings). */
      readonly summary: readonly string[];
    };

/** What the user's decision commands return (/accept, /rule accept, /apply, /no). Members of SlashResult. */
export type DecisionResult =
  | { readonly kind: 'declined'; readonly action: ActionCard }
  | {
      readonly kind: 'decision';
      /** The command that ran, e.g. 'jurator accept privacy.03'. */
      readonly line: string;
      readonly exitCode: number;
      /** Program-made: exactly what changed in the records, e.g. 'privacy.03: draft -> accepted · "…"'. */
      readonly changes: readonly string[];
      readonly output: readonly string[];
      readonly next?: string;
    }
  | { readonly kind: 'applied'; readonly edit: PolicyEditCard; readonly next: ActionCard | null };

/** Slash commands added by DS-C (shown after the others in /help). */
export const DISCUSS_DECISION_COMMANDS: readonly SlashCommandInfo[] = [
  { name: 'run', args: '', summary: 'Run the proposed action (or press Enter / y)' },
  { name: 'no', args: '', summary: 'Skip the proposed action (or press n / Esc)' },
  { name: 'accept', args: '<promise ids> | --all', summary: 'Accept draft promises (your decision; shows what changes)' },
  { name: 'rule accept', args: '<rule id> | --all', summary: 'Accept a proposed rule (your decision; shows what changes)' },
  { name: 'apply', args: '', summary: 'Write the proposed policy edit to the policy file' },
];

/** True when the session can run confirmed actions (the core can; the UI's fake cannot). */
export function canRunActions(s: DiscussSession): s is DiscussSession & Required<Pick<DiscussSession, 'confirm' | 'decline'>> {
  return typeof s.confirm === 'function' && typeof s.decline === 'function';
}
