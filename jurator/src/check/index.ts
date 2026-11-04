// Owner: WP-K. Runs a check and produces the one CheckRun record every surface renders.
//
// Order for each selected code promise (principle 2): accepted rules first (no AI, the only HOLDS/BROKEN), else an AI
// read (only LOOKS KEPT / LOOKS BROKEN / CAN'T TELL), else NOT CHECKED. Principle 3: every code quote in a result is
// copied by this program from git at the head commit; model text never becomes evidence.
import { BRAND } from '../brand.js';
import {
  checkRunSchema,
  type CheckOptions,
  type CheckResult,
  type CheckRun,
  type Binding,
  type Citation,
  type Config,
  type GitRepo,
  type Level,
  type ModelClient,
  type ModelUsage,
  type PromiseRecord,
  type Rule,
  type RuleRunResult,
  type SourceFile,
  type Store,
  type Verdict,
} from '../contracts.js';
import {
  changedLines as realChangedLines,
  readBindings as realReadBindings,
  touchedBindings as realTouchedBindings,
  anchorAll as realAnchorAll,
  type LineChange,
} from '../bindings/index.js';
import {
  cacheKeyFor,
  lastVerified,
  lookup,
  policyStateOf,
  recordVerified,
  remember,
  withEffectiveScope,
  type ReanchorFn,
} from '../cache/index.js';
import { rememberRepoCommits, repoCommitsFor, resolveBase } from '../git/index.js';
import { runRule as realRunRule } from '../rules/index.js';
import { NOTHING_TO_CHECK, type RunOptions } from '../rules/engine.js';
import { checkBindings, constraintOf, mergeById, valueBindings, workspaceAt } from './at-commit.js';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { matchesAny } from '../util/glob.js';
import { sha256, stableJson } from '../util/json.js';
import { AI_READ_INSTRUCTIONS, aiReadInput, aiReadSchema, type AiReadAnswer, type AiReadFile } from './prompts.js';
import { maskFileForModel } from '../model/secrets.js';
import { addUsage } from '../model/cost.js';
import { codeView, syntaxOf } from '../rules/code-text.js';
import { fairOrder, promiseWords } from '../rules/select.js';

export type RunRuleFn = (rule: Rule, files: readonly SourceFile[], commit: string, options?: RunOptions) => RuleRunResult;

/** Seams for tests; production code passes nothing. */
export interface CheckDeps {
  readonly runRule?: RunRuleFn;
  /** Max characters of code sent in one AI read (default ~40k). */
  readonly aiReadCharCap?: number;
  /** `--full`: check every selected promise again; nothing is reused (results are still remembered). */
  readonly full?: boolean;
  /** Bindings seams (default: src/bindings). */
  readonly readBindings?: (store: CheckOptions['store']) => Promise<Binding[]>;
  readonly changedLines?: (repo: GitRepo, base: string, head: string) => Promise<LineChange[]>;
  readonly touchedBindings?: (bindings: readonly Binding[], changes: readonly LineChange[]) => Array<{ binding: Binding; reason: string }>;
  readonly reanchor?: ReanchorFn;
  /** The rules to run instead of the store's (the pre-push hook passes the rules committed at the push base). */
  readonly rules?: readonly Rule[];
}

const AI_READ_CHAR_CAP = 40_000;
const MAX_CITATIONS = 10;
const MAX_CITATION_LINES = 30;
const CONCURRENCY = 4;

/** Which verdicts each level may produce (the level decides the words). */
export const VERDICTS_BY_LEVEL: Readonly<Record<Level, readonly Verdict[]>> = {
  quick: ['not-checked'],
  'ai-read': ['looks-kept', 'looks-broken', 'cant-tell'],
  rule: ['holds', 'broken'],
};

/* ------------------------------ helpers shared with verify ------------------------------ */

/** The lines of a file as git stores them ('\n' split; a final newline does not add an empty line). */
export function linesOf(text: string): string[] {
  const lines = text.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}
/** Lines start..end (1-based, inclusive) joined with '\n', or null when they do not exist. */
export function quoteLines(text: string, startLine: number, endLine: number): string | null {
  const lines = linesOf(text);
  if (!Number.isInteger(startLine) || !Number.isInteger(endLine)) return null;
  if (startLine < 1 || endLine < startLine || endLine > lines.length) return null;
  return lines.slice(startLine - 1, endLine).join('\n');
}
/** sha256(stableJson(run without digest)). */
export function digestOf(run: Omit<CheckRun, 'digest'> | CheckRun): string {
  const { digest: _ignored, ...rest } = run as CheckRun;
  void _ignored;
  return sha256(stableJson(rest));
}
export function scopeOf(promise: PromiseRecord, config: Config): readonly string[] {
  return promise.scope.length > 0 ? promise.scope : config.codeScope;
}
/** A promise is selected by a diff when a changed file matches its scope or one of its rules' globs. */
export function isSelected(
  promise: PromiseRecord,
  promiseRules: readonly Rule[],
  config: Config,
  changed: readonly string[] | null,
): boolean {
  if (changed === null) return true;
  const globs = [...scopeOf(promise, config), ...promiseRules.flatMap((r) => r.globs)];
  return changed.some((file) => matchesAny(file, globs));
}
function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next;
      next += 1;
      out[i] = await fn(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/* ------------------------------ the check ------------------------------ */

interface Ctx {
  readonly repo: GitRepo;
  readonly config: Config;
  readonly head: string;
  /** The diff base (resolved), or null for a whole-repo check. */
  readonly base: string | null;
  readonly changed: readonly string[] | null;
  readonly model: ModelClient | null;
  readonly aiRead: boolean;
  readonly runRule: RunRuleFn;
  readonly charCap: number;
  /** Bindings of accepted promises: value bindings are checked with no AI. */
  readonly bindings: readonly Binding[];
  read(path: string): Promise<string>;
  spent: number;
}
interface Outcome {
  readonly result: CheckResult;
  /** A model call or a rule could not run: the run is 'incomplete'. */
  readonly failed: boolean;
}

function base(promise: PromiseRecord): Pick<CheckResult, 'promiseId' | 'wording' | 'policyQuote'> {
  return { promiseId: promise.id, wording: promise.wording, policyQuote: promise.quote };
}

/** Re-copies a rule hit's quote from the file text read from git (so every quote has one exact format). */
async function recopy(ctx: Ctx, hit: Citation): Promise<Citation | null> {
  let text: string;
  try {
    text = await ctx.read(hit.path);
  } catch {
    return null;
  }
  const quote = quoteLines(text, hit.startLine, hit.endLine);
  return quote === null ? null : { path: hit.path, commit: ctx.head, startLine: hit.startLine, endLine: hit.endLine, quote };
}

function commonPrefix(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n += 1;
  return n;
}

/**
 * A must-match rule that fails in a diff has no line of its own to cite. Run it at the base: the line that satisfied it
 * there is cited at the base commit, and the new line in the same file that replaced it (an added line sharing the
 * longest start with it) at the head. Both quotes are copied from git; nothing is cited when no such line exists.
 */
async function lostMatch(ctx: Ctx, rule: Rule): Promise<Citation[]> {
  if (!ctx.base) return [];
  try {
    const paths = await ctx.repo.listFiles(ctx.base, rule.globs);
    const files: SourceFile[] = [];
    for (const path of paths) files.push({ path, text: await ctx.repo.readFile(ctx.base, path) });
    const before = ctx.runRule(rule, files, ctx.base);
    const hit = before.outcome === 'pass' ? before.hits[0] : undefined;
    const baseText = hit ? files.find((f) => f.path === hit.path)?.text : undefined;
    if (!hit || baseText === undefined) return [];
    const was = quoteLines(baseText, hit.startLine, hit.startLine);
    if (was === null) return [];
    const out: Citation[] = [];
    let headText: string | null = null;
    try {
      headText = await ctx.read(hit.path);
    } catch {
      headText = null; // the file is gone at the head
    }
    if (headText !== null) {
      const baseLines = new Set(linesOf(baseText));
      const target = was.trim();
      let best: { n: number; line: number } | null = null;
      linesOf(headText).forEach((line, i) => {
        if (baseLines.has(line)) return;
        const n = commonPrefix(line.trim(), target);
        if (n >= Math.min(8, target.length) && (!best || n > best.n)) best = { n, line: i + 1 };
      });
      const found = best as { n: number; line: number } | null;
      const quote = found ? quoteLines(headText, found.line, found.line) : null;
      if (found && quote !== null) out.push({ path: hit.path, commit: ctx.head, startLine: found.line, endLine: found.line, quote });
    }
    out.push({ path: hit.path, commit: ctx.base, startLine: hit.startLine, endLine: hit.startLine, quote: was });
    return out;
  } catch {
    return [];
  }
}

/** The deciding messages; a binding's finding that a rule message already says is not repeated. */
function explain(deciding: readonly RuleRunResult[]): string {
  const texts: string[] = [];
  for (const r of deciding) {
    const core = r.ruleId.startsWith('B-') ? r.message.replace(/^[^:]+:\d+: /u, '').replace(/ \(binding [^)]+\)$/u, '') : null;
    if (core && texts.some((t) => t.includes(core))) continue;
    texts.push(r.message);
  }
  return texts.join(' ');
}

/** A rule error that is an honest "nothing to check here", not a tool failure. */
const nothingToCheck = (r: RuleRunResult): boolean => r.message.startsWith(NOTHING_TO_CHECK);

async function checkByRules(ctx: Ctx, promise: PromiseRecord, rules: readonly Rule[], bound: readonly RuleRunResult[] = []): Promise<Outcome> {
  const ruleResults: RuleRunResult[] = [];
  const constraint = constraintOf(promise);
  for (const rule of rules) {
    try {
      const paths = await ctx.repo.listFiles(ctx.head, rule.globs);
      const files: SourceFile[] = [];
      for (const path of paths) files.push({ path, text: await ctx.read(path) });
      ruleResults.push(ctx.runRule(rule, files, ctx.head, { constraint }));
    } catch (error) {
      ruleResults.push({
        ruleId: rule.id,
        promiseId: promise.id,
        outcome: 'error',
        hits: [],
        message: `Rule ${rule.id} could not run: ${message(error)}`,
      });
    }
  }
  // A value binding whose literal breaks the number is BROKEN with no AI; one that keeps it adds evidence.
  ruleResults.push(...bound);
  const fails = ruleResults.filter((r) => r.outcome === 'fail');
  const errors = ruleResults.filter((r) => r.outcome === 'error');
  if (fails.length === 0 && errors.length > 0) {
    // Never HOLDS when a rule could not check: fall back to an AI read (or not checked), and say why.
    const reason = errors.map((r) => r.message).join(' ');
    const realFailure = errors.some((r) => !nothingToCheck(r));
    if (ctx.aiRead && ctx.model) {
      const ai = await checkByAiRead(ctx, promise, ctx.model);
      const why = [reason, ai.result.reason].filter((x): x is string => typeof x === 'string' && x !== '').join(' ');
      return { result: { ...ai.result, reason: why, ruleResults }, failed: ai.failed || realFailure };
    }
    return {
      result: { ...base(promise), verdict: 'not-checked', level: 'quick', reason, citations: [], ruleResults },
      failed: realFailure,
    };
  }
  const deciding = fails.length > 0 ? fails : ruleResults;
  const citations: Citation[] = [];
  const cited = new Set<string>();
  for (const hit of deciding.flatMap((r) => r.hits)) {
    if (citations.length >= MAX_CITATIONS) break;
    const key = `${hit.path}:${hit.startLine}-${hit.endLine}`;
    if (cited.has(key)) continue;
    const copied = await recopy(ctx, hit);
    if (copied) {
      citations.push(copied);
      cited.add(key);
    }
  }
  if (fails.length > 0) {
    for (const r of fails) {
      const rule = rules.find((x) => x.id === r.ruleId);
      if (!rule) continue;
      const noHits = r.hits.length === 0;
      // A must-match rule's near-miss lines (e.g. `CHAT_TTL_DAYS = 90`) may already be cited at the head: then add
      // only the line it matched at the base, so the reader sees what it was.
      if (noHits ? citations.length > 0 : rule.mode !== 'must-match') continue;
      const lost = await lostMatch(ctx, rule);
      const add = noHits ? lost : lost.filter((c) => c.commit !== ctx.head);
      citations.push(...add);
      if (add.length > 0) break;
    }
  }
  return {
    result: {
      ...base(promise),
      verdict: fails.length > 0 ? 'broken' : 'holds',
      level: 'rule',
      citations,
      ruleResults,
      explanation: explain(deciding),
    },
    failed: errors.length > 0,
  };
}

/** Keeps only citations to files that were sent and lines that exist; the quote is copied from the sent git text. */
export function copyCitations(
  raw: AiReadAnswer['citations'],
  sent: ReadonlyMap<string, string>,
  commit: string,
): { citations: Citation[]; dropped: number } {
  const citations: Citation[] = [];
  const seen = new Set<string>();
  let dropped = 0;
  for (const c of raw) {
    const text = sent.get(c.path);
    const count = text === undefined ? 0 : linesOf(text).length;
    if (text === undefined || !Number.isInteger(c.startLine) || c.startLine < 1 || c.startLine > count) {
      dropped += 1;
      continue;
    }
    const end = Math.min(Math.max(c.endLine, c.startLine), count, c.startLine + MAX_CITATION_LINES - 1);
    const key = `${c.path}:${c.startLine}-${end}`;
    const quote = quoteLines(text, c.startLine, end);
    if (quote === null || seen.has(key)) {
      dropped += quote === null ? 1 : 0;
      continue;
    }
    seen.add(key);
    if (citations.length < MAX_CITATIONS) citations.push({ path: c.path, commit, startLine: c.startLine, endLine: end, quote });
  }
  return { citations, dropped };
}

/**
 * The files an AI read sends, changed files first, up to the character cap. Secret files (`.env*`, `*.pem`, `*.key`)
 * are never sent; secrets in the rest are masked in place (same lines), and `originals` keeps the git text so every
 * cited quote is copied from git, not from what the model saw.
 */
async function aiReadFiles(
  ctx: Ctx,
  promise: PromiseRecord,
): Promise<{ files: AiReadFile[]; omitted: number; originals: Map<string, string> }> {
  const inScope = [...(await ctx.repo.listFiles(ctx.head, scopeOf(promise, ctx.config)))].sort();
  const changed = new Set(ctx.changed ?? []);
  // R5-A: changed files first; then repos take turns (never one repo by sort order), files naming the promise first.
  const ordered = fairOrder(inScope, (p) => p, { scope: [], first: (p) => changed.has(p), words: promiseWords(promise) });
  const files: AiReadFile[] = [];
  const originals = new Map<string, string>();
  let used = 0;
  let omitted = 0;
  for (const path of ordered) {
    const original = await ctx.read(path);
    const masked = maskFileForModel(path, original);
    if (masked === null) continue; // a secret file is not code to read
    const text = masked.text;
    if (used + text.length > ctx.charCap && files.length > 0) {
      omitted += 1;
      continue;
    }
    if (text.length > ctx.charCap) {
      omitted += 1;
      continue;
    }
    files.push({ path, text });
    originals.set(path, original);
    used += text.length;
  }
  return { files, omitted, originals };
}

/** One-line string literals (a template with `${...}` is code, so it stays). */
const STRING_LITERAL = /'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\$\n]|\\.|\$(?!\{))*`/gu;

/** A line (comments already blanked) that does something: not only strings, braces or punctuation. */
export function isCodeLine(line: string): boolean {
  return /[A-Za-z0-9_$=:]/u.test(line.replace(STRING_LITERAL, ''));
}

/**
 * Does a citation point at code, not only at comments or strings? Uses the rules' comment blanking (FX-1). Files with
 * no comment syntax we know (JSON, Markdown) count as code: their strings are the data.
 */
export function citesCode(citation: Pick<Citation, 'path' | 'startLine' | 'endLine'>, text: string): boolean {
  if (syntaxOf(citation.path) === 'none') return true;
  const { live } = codeView(citation.path, text);
  for (let i = citation.startLine - 1; i < citation.endLine; i += 1) if (isCodeLine(live[i] ?? '')) return true;
  return false;
}

interface Judged {
  readonly verdict: Verdict;
  readonly citations: Citation[];
  readonly reason?: string;
}

/**
 * Turns one AI answer into a verdict the program stands behind: citations are copied from git, a kept or broken
 * answer with no line that exists is not evidence, and a kept answer that cites only comments or strings is not
 * evidence either (a planted comment cannot prove a looks-kept).
 */
export function judgeAnswer(answer: AiReadAnswer, sent: ReadonlyMap<string, string>, commit: string): Judged {
  const { citations, dropped } = copyCitations(answer.citations, sent, commit);
  const verdict: Verdict = answer.verdict === 'kept' ? 'looks-kept' : answer.verdict === 'broken' ? 'looks-broken' : 'cant-tell';
  if ((verdict === 'looks-broken' || verdict === 'looks-kept') && citations.length === 0) {
    return { verdict: 'cant-tell', citations, reason: `the AI said ${answer.verdict} but cited no lines that exist, so this is not evidence` };
  }
  if (verdict === 'looks-kept' && !citations.some((c) => citesCode(c, sent.get(c.path) ?? ''))) {
    return { verdict: 'cant-tell', citations, reason: 'the AI said kept but cited only comments or strings, so this is not evidence' };
  }
  if (dropped > 0) {
    return {
      verdict,
      citations,
      reason: `${dropped} citation${dropped === 1 ? '' : 's'} from the AI did not match the code and ${dropped === 1 ? 'was' : 'were'} dropped`,
    };
  }
  return { verdict, citations };
}

/** Extra answers asked for before a looks-broken stands (2 of 3 must agree). */
export const BROKEN_CONFIRMATIONS = 2;

/** The task key of the n-th answer for a promise (n = 1 is the first; scripted files `ai-read__<id>__<n>.json`). */
export function aiReadTask(promiseId: string, n = 1): string {
  return n === 1 ? `ai-read:${promiseId}` : `ai-read:${promiseId}:${n}`;
}

function scriptedAnswerMissing(error: unknown): boolean {
  return (error as { code?: unknown }).code === 'SCRIPTED_ANSWER_MISSING' || /^No scripted answer/u.test(message(error));
}

interface Vote {
  readonly broken: number;
  readonly asked: number;
  readonly usage: ModelUsage | null;
  readonly failures: string[];
  readonly budgetReached: boolean;
}

/**
 * Asks the same question again (in parallel) and counts how many answers are a looks-broken with evidence. Every call
 * counts toward the budget and the cost. In scripted mode a missing `__2`/`__3` answer is the first answer again
 * (scripted answers are the same every time).
 */
async function confirmBroken(
  ctx: Ctx,
  promise: PromiseRecord,
  model: ModelClient,
  request: { input: string; sent: ReadonlyMap<string, string> },
  first: AiReadAnswer,
): Promise<Vote> {
  if (ctx.spent >= ctx.config.budgetUsdPerRun) return { broken: 1, asked: 1, usage: null, failures: [], budgetReached: true };
  const ns = Array.from({ length: BROKEN_CONFIRMATIONS }, (_, i) => i + 2);
  const answers = await Promise.all(
    ns.map(async (n): Promise<{ answer?: AiReadAnswer; usage?: ModelUsage; failure?: string }> => {
      try {
        const out = await model.json({
          task: aiReadTask(promise.id, n),
          instructions: AI_READ_INSTRUCTIONS,
          input: request.input,
          schemaName: 'ai_read',
          schema: aiReadSchema,
          maxOutputTokens: 6000,
        });
        ctx.spent += out.usage.usd;
        return { answer: out.value, usage: out.usage };
      } catch (error) {
        if (model.mode === 'scripted' && scriptedAnswerMissing(error)) return { answer: first };
        const spent = (error as { usage?: ModelUsage }).usage;
        if (spent) ctx.spent += spent.usd;
        return { failure: message(error), ...(spent ? { usage: spent } : {}) };
      }
    }),
  );
  let usage: ModelUsage | null = null;
  let broken = 1;
  const failures: string[] = [];
  for (const a of answers) {
    if (a.usage) usage = usage ? addUsage(usage, a.usage) : a.usage;
    if (a.failure !== undefined) failures.push(a.failure);
    else if (a.answer && judgeAnswer(a.answer, request.sent, ctx.head).verdict === 'looks-broken') broken += 1;
  }
  return { broken, asked: 1 + answers.length, usage, failures, budgetReached: false };
}

async function checkByAiRead(ctx: Ctx, promise: PromiseRecord, model: ModelClient): Promise<Outcome> {
  if (ctx.spent >= ctx.config.budgetUsdPerRun) {
    return {
      result: {
        ...base(promise),
        verdict: 'not-checked',
        level: 'quick',
        reason: `run budget of $${ctx.config.budgetUsdPerRun.toFixed(2)} reached; not read by AI`,
        citations: [],
      },
      failed: false,
    };
  }
  const { files, omitted, originals } = await aiReadFiles(ctx, promise);
  if (files.length === 0) {
    return {
      result: { ...base(promise), verdict: 'not-checked', level: 'quick', reason: 'no code files in its scope', citations: [] },
      failed: false,
    };
  }
  const input = aiReadInput(promise, files, omitted);
  let answer: AiReadAnswer;
  let usage: ModelUsage;
  try {
    const out = await model.json({
      task: aiReadTask(promise.id),
      instructions: AI_READ_INSTRUCTIONS,
      input,
      schemaName: 'ai_read',
      schema: aiReadSchema,
      // Reasoning tokens count toward this cap (see WP-I live run).
      maxOutputTokens: 6000,
    });
    answer = out.value;
    usage = out.usage;
  } catch (error) {
    // A cut-off answer still cost tokens: count it toward the budget and the run cost.
    const spent = (error as { usage?: ModelUsage }).usage;
    if (spent) ctx.spent += spent.usd;
    return {
      result: {
        ...base(promise),
        verdict: 'cant-tell',
        level: 'ai-read',
        reason: `AI read failed: ${message(error)}`,
        citations: [],
        ...(spent ? { model: spent } : {}),
      },
      failed: true,
    };
  }
  ctx.spent += usage.usd;
  // Line numbers are the same in the masked and the git text; quotes are copied from git.
  const judged = judgeAnswer(answer, originals, ctx.head);
  let verdict = judged.verdict;
  const reasons: string[] = judged.reason === undefined ? [] : [judged.reason];
  let failed = false;
  if (verdict === 'looks-broken') {
    // One "broken" is noisy (Self-Consistency, Wang et al. 2023): it stands only if 2 of 3 answers agree.
    const vote = await confirmBroken(ctx, promise, model, { input, sent: originals }, answer);
    if (vote.usage) usage = addUsage(usage, vote.usage);
    if (vote.budgetReached) {
      verdict = 'cant-tell';
      reasons.unshift(
        `the AI said broken once, but the run budget of $${ctx.config.budgetUsdPerRun.toFixed(2)} was reached before a second answer could confirm it`,
      );
    } else if (vote.broken >= 2) {
      reasons.unshift(`${vote.broken} of ${vote.asked} AI answers said broken`);
    } else {
      verdict = 'cant-tell';
      if (vote.failures.length > 0) {
        failed = true;
        reasons.unshift(`the AI said broken once, but the answers asked to confirm it failed: ${vote.failures[0]}`);
      } else {
        reasons.unshift(`answers disagreed: ${vote.broken} of ${vote.asked} AI answers said broken`);
      }
    }
  }
  const result: CheckResult = {
    ...base(promise),
    verdict,
    level: 'ai-read',
    citations: judged.citations,
    explanation: answer.explanation.trim().slice(0, 600),
    model: usage,
  };
  return { result: reasons.length === 0 ? result : { ...result, reason: reasons.join('; ') }, failed };
}

async function checkOne(ctx: Ctx, promise: PromiseRecord, rules: readonly Rule[]): Promise<Outcome> {
  const bound = await quietly(() => checkBindings(promise.id, ctx.bindings, (p) => ctx.read(p), ctx.head), [] as RuleRunResult[]);
  if (rules.length > 0) return checkByRules(ctx, promise, rules, bound);
  // No rule yet, but a bound constant holds a literal that breaks the number: that is BROKEN with no AI.
  if (bound.some((r) => r.outcome === 'fail')) return checkByRules(ctx, promise, [], bound.filter((r) => r.outcome === 'fail'));
  if (ctx.aiRead && ctx.model) return checkByAiRead(ctx, promise, ctx.model);
  return {
    result: {
      ...base(promise),
      verdict: 'not-checked',
      level: 'quick',
      reason: ctx.aiRead ? 'touched, not checked' : 'no rule yet; AI off',
      citations: [],
    },
    failed: false,
  };
}

function runId(createdAt: string, head: string): string {
  return `${createdAt.replace(/[-:]/gu, '').replace(/\.\d+Z$/u, 'Z')}-${head.slice(0, 7)}`;
}

/* ------------------------------ reuse (WP-C) ------------------------------ */

type Reader = Pick<ModelClient, 'id' | 'mode'> | null;

/** May this earlier result stand for the promise now? Only when this run would have answered at the same level. */
export function usable(result: CheckResult, ruleCount: number, reader: Reader): boolean {
  if (result.level === 'rule') return ruleCount > 0;
  if (ruleCount > 0) return false;
  if (result.level === 'ai-read') return reader !== null && (!result.model || result.model.mode === reader.mode);
  // quick: only when this run would not read it either (no reader), or nothing could be read (no files).
  return reader === null || result.reason === 'no code files in its scope';
}

/** Worth remembering: a finished verdict whose evidence is all at the head (a "Was" line at a base is not). */
function cacheable(outcome: Outcome, head: string): boolean {
  if (outcome.failed || outcome.result.level === 'quick') return false;
  return outcome.result.citations.every((c) => c.commit === head);
}

/**
 * A cache hit, re-pointed at this head. Principle 3: each cited line is re-copied from git at the head and must be
 * the same text, else the hit is not used (the promise is checked again).
 */
async function reuseHit(
  ctx: Ctx,
  promise: PromiseRecord,
  hit: { result: CheckResult; runId: string; commit: string },
  key: string,
): Promise<CheckResult | null> {
  const citations: Citation[] = [];
  for (const c of hit.result.citations) {
    let text: string;
    try {
      text = await ctx.read(c.path);
    } catch {
      return null;
    }
    if (quoteLines(text, c.startLine, c.endLine) !== c.quote) return null;
    citations.push({ ...c, commit: ctx.head });
  }
  const { trigger: _t, ...rest } = hit.result;
  void _t;
  return {
    ...rest,
    ...base(promise),
    citations,
    cacheKey: key,
    reused: hit.result.reused ?? { fromRun: hit.runId, fromCommit: hit.commit },
  };
}

async function readRunFile(storeDir: string, id: string): Promise<CheckRun | null> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(id)) return null;
  try {
    const parsed = checkRunSchema.safeParse(JSON.parse(await readFile(join(storeDir, 'local', 'runs', id, 'run.json'), 'utf8')));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

async function quietly<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch {
    return fallback;
  }
}

export async function runCheck(options: CheckOptions, deps: CheckDeps = {}): Promise<CheckRun> {
  const { repo, store, target } = options;
  const config = await store.readConfig();
  const snapshot = await repo.snapshot();
  const head = await repo.resolve(target.head);
  // R4-WS: in a multi-repo workspace the base applies per repo (resolveBase); a single repo resolves it as before.
  const baseSha = target.kind === 'diff' ? await resolveBase(repo, target.base) : null;
  const changed = baseSha !== null ? [...(await repo.changedFiles(baseSha, head))].sort() : null;

  const accepted = (await store.readPromises()).filter((p) => p.status === 'accepted').sort((a, b) => a.id.localeCompare(b.id));
  const rules = (deps.rules ?? (await store.readRules())).filter((r) => r.status === 'accepted');
  const rulesFor = (id: string): Rule[] => rules.filter((r) => r.promiseId === id).sort((a, b) => a.id.localeCompare(b.id));
  const effective = new Map(withEffectiveScope(accepted, config.codeScope).map((p) => [p.id, p] as const));
  const policyState = policyStateOf([...effective.values()], rules);
  const full = deps.full === true;
  const reader: Reader = options.aiRead && options.model ? options.model : null;

  // Bindings: where each promise lives in the code. In a diff, a touched bound line selects its promise.
  const acceptedIds = new Set(accepted.map((p) => p.id));
  const bindings = (await quietly(() => (deps.readBindings ?? realReadBindings)(store), [] as Binding[])).filter((b) =>
    acceptedIds.has(b.promiseId),
  );
  const triggers = new Map<string, string[]>();
  if (baseSha && bindings.length > 0) {
    const changes = await quietly(() => (deps.changedLines ?? realChangedLines)(repo, baseSha, head), [] as LineChange[]);
    // Bindings were recorded at some earlier commit: follow them to the diff base before matching old-side lines.
    const atBase = await quietly(async () => (await realAnchorAll(bindings, repo, baseSha)).map((a) => a.binding), [...bindings]);
    for (const { binding, reason } of (deps.touchedBindings ?? realTouchedBindings)(atBase, changes)) {
      const list = triggers.get(binding.promiseId) ?? [];
      if (!list.includes(reason)) list.push(reason);
      triggers.set(binding.promiseId, list);
    }
  }
  const triggerOf = (id: string): string | undefined => triggers.get(id)?.join('; ');

  const cache = new Map<string, Promise<string>>();
  const ctx: Ctx = {
    repo,
    config,
    head,
    base: baseSha,
    changed,
    model: options.model,
    aiRead: options.aiRead,
    runRule: deps.runRule ?? realRunRule,
    charCap: deps.aiReadCharCap ?? AI_READ_CHAR_CAP,
    bindings,
    read(path) {
      let text = cache.get(path);
      if (!text) {
        text = repo.readFile(head, path);
        cache.set(path, text);
      }
      return text;
    },
    spent: 0,
  };

  const checklist: CheckRun['checklist'] = [];
  const toCheck: PromiseRecord[] = [];
  for (const promise of accepted) {
    if (promise.checkable === 'runtime') continue; // enforced at runtime (e.g. Praesidia), not in code
    if (!isSelected(promise, rulesFor(promise.id), config, changed) && !triggers.has(promise.id)) continue;
    if (promise.checkable === 'process') checklist.push({ promiseId: promise.id, text: `Before merge: ${promise.wording}` });
    else toCheck.push(promise);
  }
  const withTrigger = (r: CheckResult): CheckResult => {
    const { trigger: _old, ...rest } = r;
    void _old;
    const t = triggerOf(r.promiseId);
    return t === undefined ? rest : { ...rest, trigger: t };
  };

  // Fast path: the same (code commit, policy state) pair as the last verified run -> copy its answers, zero work.
  let skipped: { results: CheckResult[] } | null = null;
  const prev = full ? null : await quietly(() => lastVerified(store), null);
  const cleanHere = !(snapshot.dirty && snapshot.commit === head);
  if (prev && cleanHere && prev.commit === head && prev.policyState === policyState) {
    const prevRun = await readRunFile(store.dir, prev.runId);
    if (prevRun && prevRun.status === 'completed') {
      const byId = new Map(prevRun.results.map((r) => [r.promiseId, r] as const));
      const copied: CheckResult[] = [];
      for (const p of toCheck) {
        const r = byId.get(p.id);
        if (!r || !usable(r, rulesFor(p.id).length, reader)) break;
        copied.push(withTrigger({ ...r, ...base(p), reused: r.reused ?? { fromRun: prevRun.id, fromCommit: prev.commit } }));
      }
      if (copied.length === toCheck.length) skipped = { results: copied };
    }
  }

  let outcomes: Array<Outcome & { reused: boolean; key?: string }>;
  if (skipped) {
    outcomes = skipped.results.map((result) => ({ result, failed: false, reused: true }));
  } else {
    let allFiles: Promise<string[]> | null = null;
    const filesFor = async (globs: readonly string[]): Promise<string[]> => {
      allFiles ??= repo.listFiles(head, ['**']);
      return (await allFiles).filter((f) => matchesAny(f, globs));
    };
    outcomes = await mapLimit(toCheck, CONCURRENCY, async (p) => {
      const pr = rulesFor(p.id);
      const eff = effective.get(p.id) ?? p;
      const key = await quietly(
        async () =>
          // A rule reads only its globs; an AI read reads the promise's scope. Those files are the dependency.
          cacheKeyFor(
            eff,
            pr,
            bindings,
            repo,
            head,
            // Value bindings are read too (their literal can make the promise BROKEN), so their files count.
            await filesFor(
              pr.length > 0
                ? [...pr.flatMap((r) => r.globs), ...valueBindings(p.id, bindings).map((b) => b.path)]
                : scopeOf(p, config),
            ),
            deps.reanchor,
          ),
        undefined as string | undefined,
      );
      if (key && !full) {
        const hit = await lookup(store, key);
        if (hit && usable(hit.result, pr.length, reader)) {
          const result = await reuseHit(ctx, p, hit, key);
          if (result) return { result: withTrigger(result), failed: false, reused: true, key };
        }
      }
      const outcome = await checkOne(ctx, p, pr);
      const result = withTrigger(key ? { ...outcome.result, cacheKey: key } : outcome.result);
      return key ? { result, failed: outcome.failed, reused: false, key } : { result, failed: outcome.failed, reused: false };
    });
  }
  const results = outcomes.map((o) => o.result);
  const count = (v: Verdict): number => results.filter((r) => r.verdict === v).length;
  const codePromises = accepted.filter((p) => p.checkable === 'code');
  // A reused answer was paid for by the run that made it.
  const costUsd = Math.round(results.reduce((sum, r) => sum + (r.reused ? 0 : (r.model?.usd ?? 0)), 0) * 1e6) / 1e6;
  const createdAt = options.now().toISOString();
  const id = runId(createdAt, head);
  const reusedCount = outcomes.filter((o) => o.reused).length;
  const status: CheckRun['status'] = outcomes.some((o) => o.failed) ? 'incomplete' : 'completed';

  const run: Omit<CheckRun, 'digest'> = {
    schemaVersion: 1,
    id,
    toolVersion: BRAND.version,
    createdAt,
    snapshot,
    target:
      target.kind === 'diff'
        ? { kind: 'diff', base: target.base, head, changedFiles: changed ?? [] }
        : { kind: 'repo', head },
    failMode: config.failMode,
    status,
    results,
    checklist,
    summary: {
      promises: accepted.length,
      checked: results.filter((r) => r.verdict !== 'not-checked').length,
      holds: count('holds'),
      broken: count('broken'),
      looksKept: count('looks-kept'),
      looksBroken: count('looks-broken'),
      cantTell: count('cant-tell'),
      notChecked: count('not-checked'),
      coveredByRules: codePromises.filter((p) => rules.some((r) => r.promiseId === p.id)).length,
      codePromises: codePromises.length,
    },
    costUsd,
    policyState,
    incremental: { rechecked: results.length - reusedCount, reused: reusedCount, skippedUnchanged: skipped !== null },
  };
  // R4-WS: every composite commit the run cites -> each repo's commit, so verify can re-read citations anywhere.
  const repoCommits = await quietly(
    () => repoCommitsFor(repo, [snapshot.commit, head, ...(baseSha ? [baseSha] : []), ...results.flatMap((r) => r.citations.map((c) => c.commit))]),
    undefined,
  );
  if (repoCommits && Object.keys(repoCommits).length > 0) (run as { repoCommits?: typeof repoCommits }).repoCommits = repoCommits;

  // Remember fresh answers by content key, then the verified pair. The cache never fails a check.
  for (const o of outcomes) {
    if (o.reused || !o.key || !cacheable(o, head)) continue;
    const { trigger: _t, ...result } = o.result;
    void _t;
    await quietly(() => remember(store, o.key as string, { result, runId: id, commit: head }), undefined);
  }
  if (status === 'completed' && !skipped) {
    await quietly(() => recordVerified(store, { commit: head, policyState, runId: id, at: createdAt }), undefined);
  }
  return { ...run, digest: digestOf(run) };
}

/* ------------------------------ verify + exit code ------------------------------ */

export interface VerifyReport {
  readonly ok: boolean;
  readonly problems: string[];
  readonly checkedQuotes: number;
  /** Things not checked (e.g. "quotes not re-checked" without a repo); not problems. */
  readonly notes: string[];
}

export interface VerifyDeps {
  /** The workspace here: its rules, promises and bindings are used for ids git does not have at the record's commit. */
  readonly store?: Store | null;
  readonly runRule?: RunRuleFn;
}

/**
 * No AI: recomputes the digest, re-reads every citation from git at its commit, and re-runs every rule (and value
 * binding) the record names at the record's commit: a verdict or rule outcome that does not come out the same is a
 * problem, so editing a record and recomputing its digest does not pass.
 */
export async function verifyRun(run: CheckRun, repo: GitRepo | null, deps: VerifyDeps = {}): Promise<VerifyReport> {
  const problems: string[] = [];
  const notes: string[] = [];
  const parsed = checkRunSchema.safeParse(run);
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
    problems.push(`The record is not a valid check run: ${issues.join('; ')}`);
  }
  if (typeof run !== 'object' || run === null) return { ok: false, problems, checkedQuotes: 0, notes };
  if (digestOf(run) !== run.digest) problems.push('Digest does not match: the record was changed after it was written.');
  const results = Array.isArray(run.results) ? run.results : [];
  for (const r of results) {
    const allowed = VERDICTS_BY_LEVEL[r.level] as readonly string[] | undefined;
    if (!allowed?.includes(r.verdict)) problems.push(`${r.promiseId}: "${r.verdict}" is not allowed at level "${r.level}".`);
    if (r.level === 'rule' && (r.ruleResults ?? []).length === 0) problems.push(`${r.promiseId}: a rule verdict with no rule results.`);
  }
  let checkedQuotes = 0;
  if (repo) await quietly(() => rememberRepoCommits(repo, run.repoCommits), undefined); // R4-WS: composite commits
  if (!repo) {
    notes.push(`Quotes not re-checked: no git repo here. Run ${BRAND.command} verify inside the repo to re-read them.`);
    notes.push('Rules not re-run: no git repo here.');
    return { ok: problems.length === 0, problems, checkedQuotes, notes };
  }
  const files = new Map<string, Promise<string>>();
  const read = (commit: string, path: string): Promise<string> => {
    const key = `${commit}:${path}`;
    let text = files.get(key);
    if (!text) {
      text = repo.readFile(commit, path);
      files.set(key, text);
    }
    return text;
  };
  for (const r of results) {
    for (const c of Array.isArray(r.citations) ? r.citations : []) {
      const where = `${c.path}:${c.startLine}`;
      let text: string;
      try {
        text = await read(c.commit, c.path);
      } catch {
        problems.push(`${r.promiseId}: ${c.path} could not be read at commit ${String(c.commit).slice(0, 7)}.`);
        continue;
      }
      checkedQuotes += 1;
      const actual = quoteLines(text, c.startLine, c.endLine);
      if (actual === null) problems.push(`${r.promiseId}: lines ${c.startLine}-${c.endLine} do not exist in ${c.path}.`);
      else if (actual !== c.quote) problems.push(`${r.promiseId}: the quote at ${where} differs from git at ${c.commit.slice(0, 7)}.`);
    }
  }
  const rerun = await rerunRules(run, results, repo, read, deps, problems);
  if (rerun > 0) notes.push(`Re-ran ${rerun} rule${rerun === 1 ? '' : 's'} at ${String(run.target?.head).slice(0, 7)} with no AI.`);
  return { ok: problems.length === 0, problems, checkedQuotes, notes };
}

/** Re-runs each recorded rule result at the record's head; adds a problem for each outcome or verdict that differs. */
async function rerunRules(
  run: CheckRun,
  results: readonly CheckResult[],
  repo: GitRepo,
  read: (commit: string, path: string) => Promise<string>,
  deps: VerifyDeps,
  problems: string[],
): Promise<number> {
  const head = run.target?.head;
  if (typeof head !== 'string' || !results.some((r) => (r.ruleResults ?? []).length > 0)) return 0;
  const short = head.slice(0, 7);
  const at = await workspaceAt(repo, head);
  const store = deps.store ?? null;
  const here = {
    rules: store ? await quietly(() => store.readRules(), [] as Rule[]) : [],
    promises: store ? await quietly(() => store.readPromises(), [] as PromiseRecord[]) : [],
    bindings: store ? await quietly(() => realReadBindings(store), [] as Binding[]) : [],
  };
  // Git at the record's commit first (what was committed), then this workspace for ids git does not have there.
  const rules = new Map(mergeById(at.rules ?? [], here.rules).map((x) => [x.id, x] as const));
  const promises = new Map(mergeById(at.promises ?? [], here.promises).map((x) => [x.id, x] as const));
  const bindings = mergeById(at.bindings ?? [], here.bindings);
  const runRule = deps.runRule ?? realRunRule;
  const said = (o: string): string => (o === 'pass' ? 'passes' : o === 'fail' ? 'fails' : 'cannot run');
  let count = 0;
  for (const r of results) {
    const recorded = r.ruleResults ?? [];
    if (recorded.length === 0) continue;
    const outcomes: string[] = [];
    for (const rr of recorded) {
      let again: RuleRunResult | undefined;
      if (rr.ruleId.startsWith('B-')) {
        const own = bindings.filter((b) => b.id === rr.ruleId);
        again = (await quietly(() => checkBindings(r.promiseId, own, (path) => read(head, path), head), [] as RuleRunResult[]))[0];
        if (!again) {
          problems.push(`${r.promiseId}: binding ${rr.ruleId} could not be checked again at ${short}, so its outcome cannot be confirmed.`);
          continue;
        }
      } else {
        const rule = rules.get(rr.ruleId);
        if (!rule) {
          problems.push(`${r.promiseId}: rule ${rr.ruleId} is not in ${BRAND.folder}/rules.json at ${short} or here, so its outcome cannot be re-run.`);
          continue;
        }
        try {
          const sources: SourceFile[] = [];
          for (const path of await repo.listFiles(head, rule.globs)) sources.push({ path, text: await read(head, path) });
          again = runRule(rule, sources, head, { constraint: constraintOf(promises.get(r.promiseId)) });
        } catch (error) {
          again = { ruleId: rule.id, promiseId: r.promiseId, outcome: 'error', hits: [], message: message(error) };
        }
      }
      count += 1;
      outcomes.push(again.outcome);
      if (again.outcome !== rr.outcome) {
        problems.push(`${r.promiseId}: ${rr.ruleId} ${said(again.outcome)} when re-run at ${short}, but the record says ${rr.outcome}.`);
      }
    }
    if (r.level === 'rule' && outcomes.length === recorded.length) {
      const expected = outcomes.includes('fail') ? 'broken' : outcomes.every((o) => o === 'pass') ? 'holds' : null;
      if (expected === null) problems.push(`${r.promiseId}: the record says ${r.verdict}, but a rule cannot run at ${short}.`);
      else if (expected !== r.verdict) problems.push(`${r.promiseId}: the record says ${r.verdict}, but its rules say ${expected} at ${short}.`);
    }
  }
  return count;
}

/** 1 when a promise is BROKEN (by a rule) and the fail mode is block; an AI read alone never fails the check. */
export function exitCodeFor(run: CheckRun): number {
  if (run.status === 'failed') return 2;
  return run.failMode === 'block' && run.results.some((r) => r.verdict === 'broken') ? 1 : 0;
}
