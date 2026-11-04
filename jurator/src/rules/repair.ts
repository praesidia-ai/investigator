// Owner: FU-1. The red-team loop: Spark attacks a rule, the judge confirms the edits it missed, the rule writer
// (Wonder) repairs the rule from those evasions, and the program re-proves the repair: it must pass on the good
// commit, fail on the old breaks AND on every evasion, and keep passing the harmless variants. Up to 2 repair rounds;
// the best proven rule is kept. The models only propose; the program decides (principle 3).
import type { ModelClient, ModelUsage, PromiseRecord, Rule, SourceFile } from '../contracts.js';
import { removeGuard, splitLines } from './engine.js';
import { displayPattern } from './regex.js';
import { numericConstraint, valueMutant } from './values.js';
import { RULE_PROPOSE_SCHEMA_NAME, RULE_REPAIR_INSTRUCTIONS, ruleAnswerSchema } from './prompts.js';
import {
  buildRulePrompt,
  checkRuleAnswer,
  runOnEdit,
  type LabelledEdit,
  type ProposeOptions,
  type RuleExamples,
} from './propose.js';
import { matchesAny } from '../util/glob.js';
import { describeRule, redteamRule, showEdit, type CodeEdit, type JudgeFn, type RedteamReport } from './redteam.js';

export const MAX_REPAIR_ROUNDS = 2;

/** Round 1 is `rule-repair:<promiseId>`; later rounds add the round number (scripted answers are keyed by task). */
export function repairTaskKey(promiseId: string, round: number): string {
  return round <= 1 ? `rule-repair:${promiseId}` : `rule-repair:${promiseId}:${round}`;
}

/** An edit that broke the promise while a rule passed, as the judge confirmed it. */
export interface Evasion {
  readonly edit: CodeEdit;
  readonly why: string;
  readonly judgeNote: string;
  /** 0 = found by the first attack; n = found by the attack on the rule repaired in round n. */
  readonly round: number;
}

export interface RepairRound {
  readonly round: number;
  /** proven: the program kept the repaired rule · rejected: it did not (reason) · gave-up: the writer said it cannot · failed: the call failed · skipped: budget. */
  readonly outcome: 'proven' | 'rejected' | 'gave-up' | 'failed' | 'skipped';
  readonly reason?: string;
  readonly rule?: Rule;
  /** The attack on the repaired rule (only after a proven repair). */
  readonly redteam?: RedteamReport;
}

export interface HardenReport {
  readonly ruleId: string;
  readonly promiseId: string;
  /** The first attack, on the rule as written. */
  readonly redteam: RedteamReport;
  readonly rounds: readonly RepairRound[];
  /** The best rule: the last proven repair, else the rule as written. */
  readonly rule: Rule;
  readonly repaired: boolean;
  /** Confirmed evasions the kept rule fails on (stored as extra mutants for `rule test`). */
  readonly closed: readonly Evasion[];
  /** Confirmed evasions the kept rule still passes. */
  readonly open: readonly Evasion[];
  /**
   * closed: every confirmed evasion now makes the rule fail · still-evadable: at least one does not · held / unsure /
   * failed: the first attack's verdict (no confirmed evasion, so nothing to repair).
   */
  readonly verdict: 'closed' | 'still-evadable' | 'held' | 'unsure' | 'failed';
  readonly message: string;
  readonly usage: readonly ModelUsage[];
}

export interface HardenOptions {
  readonly attacker: ModelClient;
  readonly judge: ModelClient | JudgeFn | null;
  /** The rule writer (the proposer's model). */
  readonly writer: ModelClient;
  /** The files the attacker sees for a rule (its globs plus the promise's scope). */
  readonly attackFiles: (rule: Rule) => Promise<SourceFile[]>;
  /** The files shown to the writer (as for `rule-propose`). */
  readonly promptFiles: readonly SourceFile[];
  readonly commit: string;
  readonly now: Date;
  readonly propose?: ProposeOptions;
  /** The examples the rule as written was proven against. */
  readonly examples?: RuleExamples;
  readonly maxRounds?: number;
  /** Called before each repair or re-attack; false stops the loop (e.g. a spend cap). */
  readonly mayContinue?: () => boolean;
  /** Called with each model call's usage as it happens (for a running spend total). */
  readonly onUsage?: (usage: ModelUsage) => void;
}

type OldBreak = { readonly label: string; readonly files: readonly SourceFile[] };

/** The simulated breaks a proven rule was shown to fail on (guard removed; number changed), as changed files only. */
async function breaksOf(rule: Rule, promise: PromiseRecord, load: (globs: readonly string[]) => Promise<SourceFile[]>): Promise<OldBreak[]> {
  if (rule.mode === 'must-not-match') return [];
  const files = await load(rule.globs);
  const changedOnly = (after: readonly SourceFile[]): SourceFile[] => after.filter((f) => files.find((o) => o.path === f.path)?.text !== f.text);
  const out: OldBreak[] = [];
  try {
    const removed = removeGuard(rule, files);
    if (removed.changedAt.length > 0) {
      out.push({ label: `${rule.id}'s break (removed ${displayPattern(rule.pattern)} at ${removed.changedAt.slice(0, 2).join(', ')})`, files: changedOnly(removed.files) });
    }
    const c = numericConstraint(promise);
    const value = c ? valueMutant(rule, files, c) : null;
    if (value) out.push({ label: `${rule.id}'s value break (${value.changes.slice(0, 2).join(', ')})`, files: changedOnly(value.files) });
  } catch {
    // A pattern that cannot run gives no simulated break (its proof already failed).
  }
  return out;
}

const sameEdit = (a: CodeEdit, b: CodeEdit): boolean => a.path === b.path && a.find === b.find && a.replace === b.replace;

function evasionsOf(report: RedteamReport, round: number): { breaks: Evasion[]; harmless: CodeEdit[]; caught: CodeEdit[] } {
  const breaks: Evasion[] = [];
  const harmless: CodeEdit[] = [];
  const caught: CodeEdit[] = [];
  for (const a of report.attempts) {
    if (a.rule === 'missed' && a.judge === 'breaks') breaks.push({ edit: a.edit, why: a.why, judgeNote: a.judgeNote ?? '', round });
    else if (a.rule === 'missed' && a.judge === 'keeps') harmless.push(a.edit);
    else if (a.rule === 'caught') caught.push(a.edit);
  }
  return { breaks, harmless, caught };
}

/** The edit as a small diff: the lines it removes and adds. */
export function editDiff(edit: CodeEdit): string {
  const minus = edit.find === '' ? [] : splitLines(edit.find).map((l) => `- ${l}`);
  const plus = splitLines(edit.replace).map((l) => `+ ${l}`);
  return [edit.find === '' ? `(added at the end of ${edit.path})` : `in ${edit.path}:`, ...minus, ...plus].join('\n');
}

/** What the writer sees for a repair: the usual rule prompt, the current rule, the evasions and what must still hold. */
export function repairInput(
  promise: PromiseRecord,
  rule: Rule,
  files: readonly SourceFile[],
  commit: string,
  evasions: readonly Evasion[],
  caught: readonly CodeEdit[],
  harmless: readonly CodeEdit[],
  examples: RuleExamples | undefined,
  feedback: string | null,
  maxChars?: number,
): string {
  const parts = [buildRulePrompt(promise, files, commit, maxChars), '', 'Current rule (it passes on every evasion below):', describeRule(rule)];
  if (examples && examples.violation.length > 0) parts.push(`Its violation examples: ${examples.violation.map((x) => `\`${x}\``).join(' · ')}`);
  if (examples && examples.kept.length > 0) parts.push(`Its kept examples: ${examples.kept.map((x) => `\`${x}\``).join(' · ')}`);
  parts.push('', `Evasions (${evasions.length}): your rule must FAIL on each one.`);
  evasions.forEach((e, i) => {
    parts.push('', `Evasion ${i + 1} ${editDiff(e.edit)}`, `Why it breaks the promise: ${e.why}`);
    if (e.judgeNote) parts.push(`Judge: ${e.judgeNote}`);
  });
  if (caught.length > 0) {
    parts.push('', `Breaks the current rule catches (${caught.length}): your rule must still fail on each one.`);
    caught.forEach((edit, i) => parts.push('', `Break ${i + 1} ${editDiff(edit)}`));
  }
  if (harmless.length > 0) {
    parts.push('', `Harmless changes (${harmless.length}): the judge said the promise still holds; your rule must PASS on each one.`);
    harmless.forEach((edit, i) => parts.push('', `Harmless ${i + 1} ${editDiff(edit)}`));
  }
  if (feedback) parts.push('', `Your previous repair was rejected by the program: ${feedback}. Fix it (or answer feasible=false with "Cannot close:").`);
  return parts.join('\n');
}

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Attacks `rule`; when the judge confirms an evasion, asks the writer for a repair (up to `maxRounds`), re-proves each
 * repair (old breaks, every evasion, harmless variants) and attacks each proven repair again. Returns the best rule.
 */
export async function hardenRule(rule: Rule, promise: PromiseRecord, options: HardenOptions): Promise<HardenReport> {
  const usage: ModelUsage[] = [];
  const spend = (items: readonly ModelUsage[]): void => {
    for (const u of items) {
      usage.push(u);
      options.onUsage?.(u);
    }
  };
  const may = (): boolean => options.mayContinue?.() ?? true;
  const base = { ruleId: rule.id, promiseId: promise.id };
  if (!may()) {
    const message = `${rule.id} was not attacked: the spend cap was reached`;
    const first: RedteamReport = { ...base, verdict: 'failed', attempts: [], usage: [], message };
    return { ...base, redteam: first, rounds: [], rule, repaired: false, closed: [], open: [], verdict: 'failed', message, usage };
  }
  const first = await redteamRule(rule, promise, await options.attackFiles(rule), options.attacker, { judge: options.judge });
  spend(first.usage);
  const found = evasionsOf(first, 0);
  const confirmed: Evasion[] = [...found.breaks];
  const harmless: CodeEdit[] = [...found.harmless];
  const caught: CodeEdit[] = [...found.caught];
  if (confirmed.length === 0) {
    const verdict = first.verdict === 'weak' ? 'unsure' : first.verdict;
    return { ...base, redteam: first, rounds: [], rule, repaired: false, closed: [], open: [], verdict, message: first.message, usage };
  }

  const loadFiles = options.propose?.loadFiles;
  const load = async (globs: readonly string[]): Promise<SourceFile[]> =>
    loadFiles ? loadFiles(globs) : options.promptFiles.filter((f) => matchesAny(f.path, globs));
  // FU-1: "old mutants": a repair must also fail on every simulated break an earlier version was proven on.
  const oldBreaks: OldBreak[] = await breaksOf(rule, promise, load);
  const catches = async (r: Rule, e: Evasion): Promise<boolean> => {
    const res = await runOnEdit(r, promise, options.promptFiles, options.commit, e.edit, loadFiles);
    return res.applied && res.outcome === 'fail';
  };
  const label = (prefix: string, edit: CodeEdit): string => `${prefix} (${showEdit(edit, 120)})`;

  let best = rule;
  let examples = options.examples;
  let feedback: string | null = null;
  const rounds: RepairRound[] = [];
  const maxRounds = options.maxRounds ?? MAX_REPAIR_ROUNDS;
  for (let round = 1; round <= maxRounds; round += 1) {
    const open: Evasion[] = [];
    for (const e of confirmed) if (!(await catches(best, e))) open.push(e);
    if (open.length === 0) break;
    if (!may()) {
      rounds.push({ round, outcome: 'skipped', reason: 'the spend cap was reached' });
      break;
    }
    let value: unknown;
    let callUsage: ModelUsage;
    try {
      const out = await options.writer.json({
        task: repairTaskKey(promise.id, round),
        instructions: RULE_REPAIR_INSTRUCTIONS,
        input: repairInput(promise, best, options.promptFiles, options.commit, confirmed, caught, harmless, examples, feedback, options.propose?.maxCodeChars),
        schemaName: RULE_PROPOSE_SCHEMA_NAME,
        schema: ruleAnswerSchema,
        maxOutputTokens: 8000,
      });
      value = out.value;
      callUsage = out.usage;
    } catch (error) {
      const spent = (error as { usage?: ModelUsage }).usage;
      if (spent) spend([spent]);
      rounds.push({ round, outcome: 'failed', reason: `the repair call failed: ${errorText(error)}` });
      break;
    }
    spend([callUsage]);
    const mustFail: LabelledEdit[] = [
      ...confirmed.map((e, i) => ({ label: label(`evasion ${i + 1}`, e.edit), edit: e.edit })),
      ...caught.map((edit, i) => ({ label: label(`old break ${i + 1}`, edit), edit })),
    ];
    const mustPass: LabelledEdit[] = harmless.map((edit, i) => ({ label: label(`harmless change ${i + 1}`, edit), edit }));
    const checked = await checkRuleAnswer(value, callUsage, promise, options.promptFiles, options.commit, options.now, options.propose ?? {}, {
      id: rule.id,
      ...(examples ? { examples } : {}),
      mustFail,
      mustPass,
      mustFailFiles: oldBreaks,
    });
    if (!checked.ok) {
      const gaveUp = checked.infeasible === true || /^cannot close:/iu.test(checked.reason.trim());
      rounds.push({ round, outcome: gaveUp ? 'gave-up' : 'rejected', reason: checked.reason });
      if (gaveUp) break;
      feedback = checked.reason;
      continue;
    }
    best = { ...checked.rule, status: rule.status };
    oldBreaks.push(...(await breaksOf(best, promise, load)));
    examples = checked.examples ?? examples;
    feedback = null;
    if (!may()) {
      rounds.push({ round, outcome: 'proven', rule: best });
      break;
    }
    // Attack the repaired rule: a new confirmed evasion is repaired in the next round, or reported as still open.
    const again = await redteamRule(best, promise, await options.attackFiles(best), options.attacker, { judge: options.judge });
    spend(again.usage);
    rounds.push({ round, outcome: 'proven', rule: best, redteam: again });
    const next = evasionsOf(again, round);
    for (const e of next.breaks) if (!confirmed.some((c) => sameEdit(c.edit, e.edit))) confirmed.push(e);
    for (const h of next.harmless) if (!harmless.some((c) => sameEdit(c, h))) harmless.push(h);
    for (const c of next.caught) if (!caught.some((x) => sameEdit(x, c)) && !confirmed.some((x) => sameEdit(x.edit, c))) caught.push(c);
  }

  const closed: Evasion[] = [];
  const open: Evasion[] = [];
  for (const e of confirmed) ((await catches(best, e)) ? closed : open).push(e);
  const repaired = best !== rule;
  const n = (k: number, one: string): string => `${k} ${one}${k === 1 ? '' : 's'}`;
  const worst = open[0];
  const message = worst
    ? `still evadable: ${showEdit(worst.edit)} (${worst.why})${closed.length > 0 ? `; ${n(closed.length, 'evasion')} closed` : ''}`
    : `evasion closed: ${best.id} now fails on ${n(closed.length, 'evasion')} it passed before`;
  return { ...base, redteam: first, rounds, rule: best, repaired, closed, open, verdict: worst ? 'still-evadable' : 'closed', message, usage };
}
