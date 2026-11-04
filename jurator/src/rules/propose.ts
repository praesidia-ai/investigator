// Owner: WP-R. The rule maintainer: the model writes a rule, the program decides whether it is kept (principle 3).
import type { Citation, ModelClient, ModelUsage, ProposeRuleResult, PromiseRecord, Rule, SourceFile } from '../contracts.js';
import { ruleSchema } from '../contracts.js';
import { matchesAny } from '../util/glob.js';
import { DEFAULT_WITHIN, isWholeFile, proveRuleCanFail, requiredName, runRule, splitLines } from './engine.js';
import { RULE_PROPOSE_INSTRUCTIONS, RULE_PROPOSE_SCHEMA_NAME, ruleAnswerSchema } from './prompts.js';
import { compileSafe, normalizeFlags, unsafeReason } from './regex.js';
import { exampleCallProblem } from './repo-aware.js';
import { constraintPromptLines, numericConstraint, proveValueChecked } from './values.js';
import { addUsage } from '../model/cost.js';
import { filesForModel } from '../model/secrets.js';
import { applyEdit, type CodeEdit } from './redteam.js';
import { deriveFix, type BrokenNow } from './fix.js';
import { fairOrder, globNamesTests, isTestPath, narrowGlob, promiseAboutTests, promiseWords } from './select.js';
import { fileBlock, sinkSection } from './sinks.js';

/**
 * What proposeRule returns: the contract result, plus `infeasible: true` when the model itself judged that no rule can
 * check the promise (not a program rejection or a failed call), so callers can stop suggesting a new proposal.
 */
export type ProposeResult = ProposeRuleResult & {
  readonly infeasible?: boolean;
  readonly examples?: RuleExamples;
  /** R4-FIX: the rule fails on today's code and passes on a copy the program fixed in memory: the promise is broken now. */
  readonly brokenNow?: BrokenNow;
  /** R4-FIX: the run budget was reached before the model was asked (no call made, nothing spent). */
  readonly budgetStopped?: boolean;
};

/** The break and keep examples the program proved a rule against (FU-1: a repair must still pass them). */
export interface RuleExamples {
  readonly violation: readonly string[];
  readonly kept: readonly string[];
}

/** A code change the program applies in memory (FU-1: red-team evasions, harmless variants), labelled for messages. */
export interface LabelledEdit {
  readonly label: string;
  readonly edit: CodeEdit;
}

/**
 * Extra proof a rule must pass (FU-1, the red-team repair): keep an id, also prove against an older rule's examples,
 * fail on every edit in `mustFail` (evasions and old breaks) and pass on every edit in `mustPass` (harmless variants).
 */
export interface ExtraProof {
  readonly id?: string;
  readonly examples?: RuleExamples;
  readonly mustFail?: readonly LabelledEdit[];
  readonly mustPass?: readonly LabelledEdit[];
  /** Older rules' simulated breaks (the changed files only): the rule must fail on each (FU-1: "old mutants"). */
  readonly mustFailFiles?: ReadonlyArray<{ readonly label: string; readonly files: readonly SourceFile[] }>;
}

/**
 * One model answer checked by the program; `retryable` marks a program rejection worth one more try; `claimsBreaksNow`
 * marks an answer that said "Breaks now:" but wrote no rule (the retry asks for the rule anyway); `context` is
 * program-copied code the retry shows (SC-3 fix 1: the failing lines the answer did not name).
 */
export type Attempt = ProposeResult & { readonly retryable?: boolean; readonly claimsBreaksNow?: boolean; readonly context?: string };

/** The retry message when the model said the code breaks the promise today but wrote no rule (R4-FIX). */
export const BREAKS_NOW_FEEDBACK =
  'You said the code shown already breaks the promise. Write the rule anyway, as it would pass on code that keeps the ' +
  'promise (feasible=true), keep "reason" starting with "Breaks now:", and put the fixed line first in keptExamples. ' +
  'The program fixes the code in memory, proves the rule there and reports the promise as broken today.';

export const MAX_PROMPT_CODE_CHARS = 30_000;

export interface ProposeOptions {
  /** Rules already saved, so the new id does not collide (`R-<promiseId>-<n>`). */
  readonly existing?: readonly Rule[];
  /** Loads the files a rule's globs cover at the commit. Default: filter `files`. */
  readonly loadFiles?: (globs: readonly string[]) => Promise<SourceFile[]>;
  readonly maxCodeChars?: number;
  /** R5-A: the configured code scope; a rule for an unscoped promise must stay inside it. */
  readonly codeScope?: readonly string[];
}

/** R5-A: a BROKEN NOW finding needs a small, believable fix: at most this many changed lines. */
export const MAX_FIX_LINES = 5;
/** SC-3 fix 5: a must-match names one guard, setting or call: it may match at most this many lines, in this many files. */
export const MAX_MUST_MATCH_LINES = 5;
export const MAX_MUST_MATCH_FILES = 2;
/** SC-3 fix 1: unnamed failing lines shown again to the model on the retry, with this many lines around each. */
export const MAX_UNNAMED_HITS = 8;
const CONTEXT_LINES = 5;

/** File references in a model's reason: `path:12`, `name.py:12-20`, `name.py:12, 15` (a range or list counts). */
const LINE_REF = /([\w@.\-/]+):(\d+(?:\s*[-–]\s*\d+)?(?:\s*,\s*\d+(?:\s*[-–]\s*\d+)?)*)/gu;

/**
 * SC-3 fix 1: does `reason` name a line of `path` from `start` to `end`? The full path or any tail of it (the file
 * name) counts, with the line itself, a range that holds it, or a list that has it.
 */
export function namesLine(reason: string, path: string, start: number, end = start): boolean {
  for (const m of reason.matchAll(LINE_REF)) {
    const name = (m[1] as string).replace(/^\.?\/+/u, '');
    if (name === '' || !(path === name || path.endsWith(`/${name}`))) continue;
    for (const part of (m[2] as string).split(',')) {
      const [a, b] = part.split(/[-–]/u).map((x) => Number(x.trim()));
      const lo = a ?? 0;
      const hi = b ?? lo;
      if (lo <= end && hi >= start) return true;
    }
  }
  return false;
}

/**
 * SC-3 fix 6: does a value pattern name the constant or setting it reads? The engine's required name (4+ characters),
 * or a short literal name such as `ttl` outside escapes and character classes. A bare number pattern names nothing.
 */
export function namesSetting(pattern: string): boolean {
  if (requiredName(pattern) !== null) return true;
  const literal = pattern.replace(/\\./gu, ' ').replace(/\[[^\]]*\]/gu, ' ').replace(/\(\?(?:[:=!]|<[=!]|<\w+>)/gu, ' ');
  return /[A-Za-z_]{3,}/u.test(literal);
}

/** The failing lines a reason does not name. */
export function unnamedHits(reason: string, hits: readonly Citation[]): Citation[] {
  return hits.filter((h) => !namesLine(reason, h.path, h.startLine, h.endLine));
}

/** Program-copied lines around each hit (±5, numbered as in the prompt), for the retry. */
export function hitContext(hits: readonly Citation[], files: readonly SourceFile[]): string {
  const blocks: string[] = [];
  for (const h of hits.slice(0, MAX_UNNAMED_HITS)) {
    const f = files.find((x) => x.path === h.path);
    if (!f) continue;
    const lines = splitLines(f.text);
    const from = Math.max(1, h.startLine - CONTEXT_LINES);
    const to = Math.min(lines.length, h.endLine + CONTEXT_LINES);
    const body = lines.slice(from - 1, to).map((line, i) => `${from + i}| ${line.length > 300 ? `${line.slice(0, 300)}…` : line}`);
    blocks.push([`=== ${h.path} (lines ${from}-${to}; the rule fails on line ${h.startLine})`, ...body].join('\n'));
  }
  return blocks.join('\n');
}

export const ruleTaskKey = (promiseId: string): string => `rule-propose:${promiseId}`;

/**
 * Promise, policy quote and code with line numbers, capped at ~30k characters. Files in the promise's scope come first;
 * repos take turns (R5-A: never one repo by sort order) and files that name the promise's words lead within a repo.
 * SC-3 fix 2: before the files, the program lists where the promise's code writes, logs, sends, deletes and sets a
 * lifetime (whole scope), and a long file is shown as a 6k-character window around its first such line.
 */
export function buildRulePrompt(
  promise: PromiseRecord,
  files: readonly SourceFile[],
  commit: string,
  maxChars = MAX_PROMPT_CODE_CHARS,
): string {
  const inScope = (f: SourceFile): boolean => promise.scope.length > 0 && matchesAny(f.path, promise.scope);
  const words = promiseWords(promise);
  const ordered = fairOrder(filesForModel(files), (f) => f.path, { scope: promise.scope, words, textOf: (f) => f.text });
  const sinks = sinkSection(promise, promise.scope.length > 0 ? ordered.filter(inScope) : ordered);
  const head = [
    `Promise ${promise.id} (${promise.kind}): ${promise.wording}`,
    `Policy quote (${promise.quote.alias}): "${promise.quote.text}"`,
    `Promise scope: ${promise.scope.length > 0 ? promise.scope.join(', ') : '(whole code scope)'}`,
    ...constraintPromptLines(promise),
    ...(sinks.lines.length > 0 ? ['', ...sinks.lines] : []),
    '',
    `Code at commit ${commit.slice(0, 12)}. Each line starts with its number and "| ", which is not part of the file.`,
  ];
  const firstWordLine = (text: string): number | undefined => {
    if (words.length === 0) return undefined;
    const i = splitLines(text).findIndex((line) => words.some((w) => line.toLowerCase().includes(w)));
    return i >= 0 ? i + 1 : undefined;
  };
  const parts: string[] = [];
  const skipped: string[] = [];
  let used = 0;
  for (const file of ordered) {
    const block = fileBlock(file, sinks.firstHit.get(file.path) ?? firstWordLine(file.text));
    if (used + block.length <= maxChars) {
      parts.push(block);
      used += block.length;
    } else if (used < maxChars / 2 && inScope(file)) {
      parts.push(`${block.slice(0, maxChars - used)}\n... (file cut here)`);
      used = maxChars;
    } else skipped.push(file.path);
  }
  if (skipped.length > 0) parts.push(`Other files not shown: ${skipped.slice(0, 40).join(', ')}${skipped.length > 40 ? ', ...' : ''}`);
  return [...head, ...parts].join('\n');
}

function nextRuleNumber(promiseId: string, existing: readonly Rule[]): number {
  let max = 0;
  for (const r of existing) {
    const m = /-(\d+)$/u.exec(r.id);
    if (r.promiseId === promiseId && m) max = Math.max(max, Number(m[1]));
  }
  return max + 1;
}

/**
 * Asks the model for a rule, then keeps it only if it is safe, passes on this code and is shown able to fail.
 * A live answer the program rejects gets one more try with the reason (scripted answers never change, so no retry).
 */
export async function proposeRule(
  promise: PromiseRecord,
  files: readonly SourceFile[],
  commit: string,
  model: ModelClient,
  now: Date,
  options: ProposeOptions = {},
): Promise<ProposeResult> {
  const strip = ({ retryable: _r, claimsBreaksNow: _c, context: _x, ...res }: Attempt): ProposeResult => res as ProposeResult;
  const first = await proposeOnce(promise, files, commit, model, now, options, null);
  if (first.ok || !first.retryable || model.mode === 'scripted') return strip(first);
  const feedback = first.claimsBreaksNow
    ? BREAKS_NOW_FEEDBACK
    : `Your previous answer was rejected by the program: ${first.reason}. Fix the rule (or answer feasible=false).` +
      (first.context ? `\n${first.context}` : '');
  const second = strip(await proposeOnce(promise, files, commit, model, now, options, feedback));
  const usage = first.usage && second.usage ? addUsage(first.usage, second.usage) : (second.usage ?? first.usage);
  if (second.ok) return { ...second, usage: usage! };
  return {
    ok: false,
    reason: `${second.reason} (after one retry)`,
    ...(usage ? { usage } : {}),
    ...(!second.ok && second.infeasible ? { infeasible: true } : {}),
  };
}

async function proposeOnce(
  promise: PromiseRecord,
  files: readonly SourceFile[],
  commit: string,
  model: ModelClient,
  now: Date,
  options: ProposeOptions = {},
  feedback: string | null = null,
): Promise<Attempt> {
  if (promise.checkable !== 'code') {
    return { ok: false, reason: `${promise.id} is a ${promise.checkable} promise; rules only check code promises` };
  }
  let value: unknown;
  let usage: ModelUsage;
  try {
    const result = await model.json({
      task: ruleTaskKey(promise.id),
      instructions: RULE_PROPOSE_INSTRUCTIONS,
      input: buildRulePrompt(promise, files, commit, options.maxCodeChars) + (feedback ? `\n\n${feedback}` : ''),
      schemaName: RULE_PROPOSE_SCHEMA_NAME,
      schema: ruleAnswerSchema,
      // Reasoning tokens count toward this cap; 1500 cut off 4 of 10 live answers (WP-I live run).
      maxOutputTokens: 6000,
    });
    value = result.value;
    usage = result.usage;
  } catch (error) {
    // R4-FIX: the run budget stops the call before it is made; the command says how much more is needed.
    if ((error as { code?: string }).code === 'MODEL_BUDGET_EXCEEDED') {
      return { ok: false, reason: 'not asked: the run budget was reached', budgetStopped: true };
    }
    // A cut-off answer (ModelIncompleteError) still cost tokens; carry its usage so the command's cost line is honest.
    const spent = (error as { usage?: ModelUsage }).usage;
    return { ok: false, reason: `the model call failed: ${(error as Error).message}`, ...(spent ? { usage: spent } : {}) };
  }
  return checkRuleAnswer(value, usage, promise, files, commit, now, options);
}

/**
 * The program's half of a proposal: parse the model's answer, build the rule, and keep it only if it is safe, passes on
 * this code and is proven able to fail (plus any `extra` proof). Shared by `rule-propose` and `rule-repair` (FU-1).
 */
export async function checkRuleAnswer(
  value: unknown,
  usage: ModelUsage,
  promise: PromiseRecord,
  files: readonly SourceFile[],
  commit: string,
  now: Date,
  options: ProposeOptions = {},
  extra: ExtraProof = {},
): Promise<Attempt> {
  const reject = (reason: string, context?: string): Attempt => ({ ok: false, reason, usage, retryable: true, ...(context ? { context } : {}) });
  // Answers recorded before violationExamples[] (scripted fixtures) carry one violationExample string.
  if (value && typeof value === 'object' && !('violationExamples' in value)) {
    const v = (value as { violationExample?: unknown }).violationExample;
    value = { ...(value as object), violationExamples: typeof v === 'string' ? [v] : [], keptExamples: [] };
  }
  const parsed = ruleAnswerSchema.safeParse(value);
  if (!parsed.success) return reject('the model answer did not have the expected fields');
  const a = parsed.data;
  if (!a.feasible) {
    // "Breaks now:" means the code shown already breaks the promise: not cached as "no rule possible". R4-FIX: a live
    // answer gets one more try asking for the rule anyway, so the program can prove the break (model text is no evidence).
    const breaksNow = /^breaks now:/iu.test(a.reason.trim());
    if (breaksNow) return { ok: false, reason: a.reason.trim(), usage, retryable: true, claimsBreaksNow: true };
    return { ok: false, reason: a.reason.trim() || 'the model found no pattern in code that checks this promise', usage, infeasible: true };
  }
  if (!a.mode || !a.pattern) return reject('the model said a rule is possible but gave no mode or pattern');

  let flags: string;
  try {
    flags = normalizeFlags(a.flags);
  } catch (error) {
    return reject((error as Error).message);
  }
  let globs = [...new Set(a.globs.map((g) => g.trim().replace(/^\.\//u, '')).filter((g) => g.length > 0))];
  if (globs.length === 0) globs = [...promise.scope];
  if (globs.length === 0) return reject('the rule names no files to check');
  const badGlob = globs.find((g) => g.startsWith('/') || g.split('/').includes('..'));
  if (badGlob) return reject(`the glob ${badGlob} points outside the repo`);
  // R5-A: a rule reads only the promise's code: no tests or fixtures (unless the promise is about tests), and every
  // glob inside the promise's scope (else the code scope). A glob that reaches further is narrowed, or dropped.
  const codeScope = promise.scope.length > 0 ? promise.scope : (options.codeScope ?? []);
  let globNote = '';
  if (!promiseAboutTests(promise)) {
    const tests = globs.filter(globNamesTests);
    if (tests.length === globs.length) return reject(`the globs ${globs.join(', ')} read only tests or fixtures; a rule reads the product's code, not its tests`);
    globs = globs.filter((g) => !globNamesTests(g));
  }
  if (codeScope.length > 0) {
    const listed = options.loadFiles ? await options.loadFiles([...new Set([...globs, ...codeScope])]) : files;
    const paths = listed.map((f) => f.path).filter((x) => !isTestPath(x));
    const fitted = [...new Set(globs.flatMap((g) => narrowGlob(g, codeScope, paths)))];
    if (fitted.length === 0) {
      return reject(`the globs ${globs.join(', ')} cover no file inside the promise's code (${codeScope.join(', ')}); keep every glob inside it`);
    }
    if (fitted.join('\n') !== globs.join('\n')) globNote = `globs kept inside the promise's code (${fitted.join(', ')})`;
    globs = fitted;
  }

  for (const [what, p] of [['pattern', a.pattern], ['anchor', a.anchor]] as const) {
    if (p === null) continue;
    const why = unsafeReason(p);
    if (why) return reject(`the ${what} /${p}/ is not safe to run: ${why}`);
    try {
      new RegExp(p, flags);
    } catch (error) {
      return reject(`the ${what} /${p}/ is not a valid pattern: ${(error as Error).message}`);
    }
  }

  const draft: Record<string, unknown> = {
    id: extra.id ?? `R-${promise.id}-${nextRuleNumber(promise.id, options.existing ?? [])}`,
    promiseId: promise.id,
    description: a.description?.trim() || `${a.mode} ${a.pattern}`,
    mode: a.mode,
    pattern: a.pattern,
    globs,
    provenBy: null,
    status: 'proposed',
    author: 'model',
    createdAt: now.toISOString(),
  };
  if (flags) draft.flags = flags;
  if (a.mode === 'each-near') {
    if (!a.anchor) return reject('an each-near rule needs an anchor (the lines that must be guarded)');
    const within = a.within === null ? DEFAULT_WITHIN : Math.round(a.within);
    if (within < 0 || within > 50) return reject(`within must be 0 to 50 lines, not ${a.within}`);
    draft.anchor = a.anchor;
    draft.within = within;
  }
  const checked = ruleSchema.safeParse(draft);
  if (!checked.success) return reject(`the rule is not valid: ${checked.error.issues.map((i) => i.message).join('; ')}`);
  const rule: Rule = checked.data;

  const loaded = options.loadFiles ? await options.loadFiles(globs) : files.filter((f) => matchesAny(f.path, globs));
  const clean = (xs: readonly string[]): string[] => [...new Set(xs.map((x) => x.trim()).filter((x) => x.length > 0))];
  const constraint = numericConstraint(promise);
  // SC-3 fix 6: a promise that sets a number needs a must-match on a named setting, so the value reader runs (.20: an
  // hours-only number pattern with no name was "proven" by an unused new constant).
  if (constraint && rule.mode === 'must-match' && !isWholeFile(rule) && !namesSetting(rule.pattern)) {
    return reject(
      `the pattern /${rule.pattern}/ names no constant or setting, so the program cannot read the value the code sets; ` +
        'match the named constant or setting that holds the number (e.g. CACHE_TTL_SECONDS\\s*=\\s*<number>), in the unit the code counts in',
    );
  }
  // The rule runs as check will run it (reading the promise's number), so a BROKEN NOW here is a BROKEN in check.
  const run = runRule(rule, loaded, commit, { constraint });
  if (run.outcome === 'error') return reject(run.message);
  // R4-FIX: a rule that fails today is evidence that the code breaks the promise, if it passes once the program fixes
  // the code in memory (smallest fix it can derive). Only a rule that passes on no fixed copy is dropped.
  let ruleFiles = loaded;
  let brokenNow: BrokenNow | undefined;
  // SC-3 fix 5: a must-match names the one guard, setting or call; one that matches many lines proves nothing (.18 was
  // "proven" by deleting 15 unrelated initialisers).
  if (run.outcome === 'pass' && rule.mode === 'must-match') {
    const hitFiles = [...new Set(run.hits.map((h) => h.path))];
    if (run.hits.length > MAX_MUST_MATCH_LINES || hitFiles.length > MAX_MUST_MATCH_FILES) {
      const first = run.hits[0]!;
      return reject(
        `the must-match pattern matches ${run.hits.length >= 50 ? '50 or more' : run.hits.length} lines in ${hitFiles.length} file${hitFiles.length === 1 ? '' : 's'} ` +
          `(e.g. \`${first.path}:${first.startLine}\`), so deleting any one of them proves nothing; name the one guard, setting or call ` +
          `that keeps the promise (at most ${MAX_MUST_MATCH_LINES} lines in ${MAX_MUST_MATCH_FILES} files)`,
      );
    }
  }
  if (run.outcome === 'fail') {
    // SC-3 fix 1: a finding counts only lines the model named after "Breaks now:"; any other failing line is a stray
    // match (a read, a name, a message), so the answer goes back with those lines copied from the code.
    const said = a.reason.trim();
    if (!/^breaks now:/iu.test(said)) {
      const shown = run.hits.slice(0, 3).map((h) => `${h.path}:${h.startLine}`).join(', ');
      return reject(
        `the rule fails on the current code (${run.message}), but "reason" does not start with "Breaks now:"; if these lines ` +
          `break the promise, start "reason" with "Breaks now:" and name each path:line${shown ? ` (${shown})` : ''}, else narrow the pattern or the globs so they do not match them`,
        hitContext(run.hits, loaded),
      );
    }
    // A must-match cites where the required line is missing (lines that only mention its name), not lines that break
    // the promise, so "Breaks now:" is enough there; must-not-match and each-near hits must each be named.
    const unnamed = rule.mode === 'must-match' ? [] : unnamedHits(said, run.hits);
    if (unnamed.length > 0) {
      const shown = unnamed.slice(0, 3).map((h) => `${h.path}:${h.startLine}`).join(', ');
      return reject(
        `the rule fails on ${unnamed.length} line${unnamed.length === 1 ? '' : 's'} your "Breaks now:" does not name (${shown}${unnamed.length > 3 ? ', ...' : ''}); ` +
          'name each line that breaks the promise, or narrow the pattern or the globs so it does not match the others (copied below)',
        hitContext(unnamed, loaded),
      );
    }
    const fixed = deriveFix(rule, loaded, commit, run, { constraint, keptExamples: clean([...a.keptExamples, ...(extra.examples?.kept ?? [])]) });
    if (!fixed) {
      return reject(
        `the rule fails on the current code (${run.message}), and no small fix to the code (a value within the limit, the ` +
          'missing line added, the forbidden line removed) makes it pass, so it cannot tell a broken promise from a wrong rule',
      );
    }
    // R5-A: a finding needs a small, believable fix (a value, a guard, a removed line) in the promise's own code.
    if (fixed.changedLines > MAX_FIX_LINES) {
      return reject(
        `the rule fails on the current code (${run.message}), but the smallest fix the program found changes ` +
          `${fixed.changedLines} lines (${fixed.fix}); a finding needs a fix of at most ${MAX_FIX_LINES} lines, so the rule ` +
          'flags too much code to be believable. Narrow the pattern or the globs to the code the promise is about',
      );
    }
    const outside = codeScope.length > 0 ? fixed.paths.find((x) => !matchesAny(x, codeScope)) : undefined;
    if (outside) {
      return reject(`the rule fails on the current code, but the fix is in ${outside}, outside the promise's code (${codeScope.join(', ')})`);
    }
    ruleFiles = fixed.files;
    brokenNow = { message: run.message, evidence: fixed.evidence, fix: fixed.fix };
  }
  // FU-1: a repaired rule is also proven against the older rule's breaks and harmless variants.
  const examples = clean([...a.violationExamples, ...(extra.examples?.violation ?? [])]);
  const keptExamples = clean([...a.keptExamples, ...(extra.examples?.kept ?? [])]);
  // Harmless variants: a must-match pattern must match each kept example, a must-not-match pattern none of them.
  if (rule.mode !== 'each-near') {
    const re = compileSafe(rule.pattern, isWholeFile(rule) ? flags : flags.replace(/[sm]/gu, ''));
    for (const k of keptExamples) {
      re.lastIndex = 0;
      const hit = re.test(k);
      if (rule.mode === 'must-match' && !hit) {
        return reject(`the pattern does not match the kept example \`${k}\`, so a harmless edit would break the rule (allow \\s* and ['"])`);
      }
      if (rule.mode === 'must-not-match' && hit) {
        return reject(`the pattern matches the kept example \`${k}\`, which keeps the promise, so it would raise a false alarm`);
      }
    }
  }
  if (rule.mode === 'must-not-match' && examples.length === 0) {
    return reject('a must-not-match rule needs an example of a new line that breaks the promise (violationExamples) to prove it can fail');
  }
  if (rule.mode === 'must-not-match') {
    // Repo-aware: the first bad line must call something this repo uses (acme logs with log(, not console.log().
    const why = exampleCallProblem(examples[0] ?? null, [...ruleFiles, ...files]);
    if (why) return reject(why);
  }
  // Every planted break must make the rule fail (must-match: deleting the matched lines is the break).
  const breaks: ReadonlyArray<string | null> = rule.mode === 'must-match' || examples.length === 0 ? [null] : examples;
  const mutations: string[] = [];
  for (const example of breaks) {
    const proof = proveRuleCanFail(rule, ruleFiles, commit, { violationExample: example });
    if (!proof.ok) return reject(`the rule could not be shown to fail: ${proof.mutation}`);
    mutations.push(proof.mutation);
  }
  let mutation =
    mutations.length > 1 ? `${mutations[0]}; also failed on ${mutations.length - 1} more new line${mutations.length === 2 ? '' : 's'} (${mutations.length}/${mutations.length} breaks caught)` : mutations[0]!;
  if (constraint) {
    // Typed facets: a rule on a promise that sets a number must notice the number changing (30 -> 31).
    const value = proveValueChecked(rule, ruleFiles, commit, constraint);
    if (!value.ok) return reject(`the rule could not be shown to fail when the value breaks the promise: ${value.mutation}`);
    if (value.applies) mutation = `${mutation}; ${value.mutation}`;
  }
  if ((extra.mustFail?.length ?? 0) > 0 || (extra.mustPass?.length ?? 0) > 0 || (extra.mustFailFiles?.length ?? 0) > 0) {
    if (brokenNow) return reject(`the rule fails on the current code (${brokenNow.message}), so red-team edits cannot be applied to it`);
    const edits = await proveOnEdits(rule, promise, files, commit, globs, options, extra);
    if (!edits.ok) return reject(edits.reason);
    mutation = `${mutation}; ${edits.note}`;
  }
  if (brokenNow) mutation = `fails on today's code; passes on a copy fixed in memory (${brokenNow.fix}); on that copy: ${mutation}`;
  if (globNote) mutation = `${mutation}; ${globNote}`;
  return {
    ok: true,
    rule: { ...rule, provenBy: { mutation, failedAsExpected: true, at: now.toISOString() } },
    usage,
    examples: { violation: examples, kept: keptExamples },
    ...(brokenNow ? { brokenNow } : {}),
  };
}

/** Runs `rule` on the code after one edit (applied in memory), reading the promise's number as check does. */
export async function runOnEdit(
  rule: Rule,
  promise: PromiseRecord,
  files: readonly SourceFile[],
  commit: string,
  edit: CodeEdit,
  loadFiles?: (globs: readonly string[]) => Promise<SourceFile[]>,
): Promise<{ applied: false; reason: string } | { applied: true; outcome: 'pass' | 'fail' | 'error'; message: string }> {
  const globs = [...new Set([...rule.globs, edit.path])];
  const base = loadFiles ? await loadFiles(globs) : files.filter((f) => f.path === edit.path || matchesAny(f.path, rule.globs));
  const after = applyEdit(base, edit);
  if (!after.ok) return { applied: false, reason: after.reason };
  const run = runRule(rule, after.files, commit, { constraint: numericConstraint(promise) });
  return { applied: true, outcome: run.outcome, message: run.message };
}

/** FU-1: the rule must fail on each evasion and old break, and pass on each harmless variant. */
async function proveOnEdits(
  rule: Rule,
  promise: PromiseRecord,
  files: readonly SourceFile[],
  commit: string,
  globs: readonly string[],
  options: ProposeOptions,
  extra: ExtraProof,
): Promise<{ ok: true; note: string } | { ok: false; reason: string }> {
  const base = options.loadFiles ? await options.loadFiles(globs) : files.filter((f) => matchesAny(f.path, globs));
  const now = runRule(rule, base, commit, { constraint: numericConstraint(promise) });
  if (now.outcome !== 'pass') return { ok: false, reason: `the rule does not pass on the current code when it reads the promise's number (${now.message})` };
  let oldBreaks = 0;
  for (const { label, files: changed } of extra.mustFailFiles ?? []) {
    const paths = new Set(changed.map((f) => f.path));
    const loaded = options.loadFiles
      ? await options.loadFiles([...new Set([...rule.globs, ...paths])])
      : files.filter((f) => paths.has(f.path) || matchesAny(f.path, rule.globs));
    const byPath = new Map(changed.map((f) => [f.path, f]));
    const overlaid = [...loaded.map((f) => byPath.get(f.path) ?? f), ...changed.filter((c) => !loaded.some((f) => f.path === c.path))];
    const res = runRule(rule, overlaid, commit, { constraint: numericConstraint(promise) });
    if (res.outcome !== 'fail') {
      return { ok: false, reason: `the rule still ${res.outcome === 'pass' ? 'passes' : 'gives an error'} on ${label}, which the older rule was proven to catch` };
    }
    oldBreaks += 1;
  }
  let failed = 0;
  for (const { label, edit } of extra.mustFail ?? []) {
    const res = await runOnEdit(rule, promise, files, commit, edit, options.loadFiles);
    if (!res.applied) return { ok: false, reason: `${label} could not be applied to the code the rule reads (${res.reason}); cover ${edit.path} in globs` };
    if (res.outcome !== 'fail') return { ok: false, reason: `the rule still ${res.outcome === 'pass' ? 'passes' : `gives an error (${res.message})`} on ${label}, which breaks the promise` };
    failed += 1;
  }
  let passed = 0;
  for (const { label, edit } of extra.mustPass ?? []) {
    const res = await runOnEdit(rule, promise, files, commit, edit, options.loadFiles);
    if (!res.applied) continue;
    if (res.outcome !== 'pass') return { ok: false, reason: `the rule fails on ${label}, which keeps the promise (a false alarm: ${res.message})` };
    passed += 1;
  }
  const parts = [`failed on ${failed} red-team edit${failed === 1 ? '' : 's'} that break the promise`];
  if (oldBreaks > 0) parts.push(`on ${oldBreaks} older rule break${oldBreaks === 1 ? '' : 's'}`);
  if (passed > 0) parts.push(`passed ${passed} harmless edit${passed === 1 ? '' : 's'}`);
  return { ok: true, note: parts.join(', ') };
}
