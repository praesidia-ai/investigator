// Owner: HZ-1. Plain words for what the program already knows (backlog 14-15): what a rule checks, why no rule was
// written, and what to change. No AI here: these are also the fallback when the AI summary is off or unavailable.
import { BRAND } from '../brand.js';
import type { Rule } from '../contracts.js';

const MODE_PREFIX = /^\s*(?:must-match|must-not-match|each-near)\s*:\s*/iu;
const sentence = (s: string): string => {
  const t = s.replace(/\s+/gu, ' ').trim();
  if (!t) return t;
  const first = t[0] as string;
  return `${first.toUpperCase()}${t.slice(1)}`;
};
const dot = (s: string): string => (/[.!?]$/u.test(s) ? s : `${s}.`);

/** One plain line of what a rule checks: the rule's own description, without the mode jargon. */
export function ruleLine(rule: Pick<Rule, 'description' | 'mode'>): string {
  const text = sentence(rule.description.replace(MODE_PREFIX, ''));
  if (text) return dot(text);
  return rule.mode === 'must-not-match'
    ? 'Flags any line that does what the promise forbids.'
    : rule.mode === 'each-near'
      ? 'Checks that every risky line has its guard close by.'
      : 'Checks that the code that keeps the promise is still there.';
}

/** The mode in plain words, for details (`explain`, --verbose). */
export function modeWords(mode: Rule['mode']): string {
  return mode === 'must-not-match'
    ? 'fails when any line matches the pattern'
    : mode === 'each-near'
      ? 'fails when a line matching the anchor has no line matching the pattern close after it'
      : 'fails when no line matches the pattern';
}

export interface PlainReason {
  /** One plain sentence. */
  readonly text: string;
  /** The command that tries again, when trying again can help. */
  readonly retry?: string;
}

/**
 * Why no rule was written, in plain words (backlog 14: "the model's answer was cut off; retry with jurator rule
 * propose doc.16"). `id` is the id to type (the short one on screens).
 */
export function plainReason(reason: string, o: { readonly id: string; readonly infeasible?: boolean; readonly budgetStopped?: boolean }): PlainReason {
  const retry = `${BRAND.command} rule propose ${o.id}`;
  const r = reason.replace(/\s+/gu, ' ').trim().replace(/ \(after one retry\)$/u, '');
  if (o.budgetStopped || /run budget (?:was )?reached/iu.test(r)) return { text: 'Not asked: the run budget ran out first.', retry: `${retry} --budget <usd>` };
  if (/cut off/iu.test(r)) return { text: "The model's answer was cut off before it finished.", retry };
  if (/refused/iu.test(r)) return { text: 'The model refused to answer.', retry };
  if (/^the model call failed/iu.test(r)) {
    const why = /timed? ?out|timeout/iu.test(r) ? 'it timed out' : /rate/iu.test(r) ? 'the service was busy' : 'the call did not go through';
    return { text: `The model call failed (${why}).`, retry };
  }
  if (/unusable after 2 tries|did not have the expected fields/iu.test(r)) return { text: "The model's answer was not in the expected shape.", retry };
  if (o.infeasible) {
    const why = r.replace(/^(?:infeasible|not feasible)\s*[:-]\s*/iu, '');
    return { text: why ? `No rule can check this in code: ${dot(why.charAt(0).toLowerCase() + why.slice(1))}` : 'No rule can check this in code.' };
  }
  // The program rejected the model's rule (it could not be proven, or it would raise false alarms).
  const head = r.split(/;|, so /u)[0] ?? r;
  return { text: `The rule the model wrote did not pass the program's checks (${head.length > 120 ? `${head.slice(0, 119)}…` : head}).`, retry };
}

/** A must-not-match finding's "actual" carries nothing a reader needs (backlog 15). */
export function genericActual(actual: string | undefined): boolean {
  return !actual || /^a line the promise forbids$/iu.test(actual.trim());
}

/**
 * What to change, from the fix the program made in memory (backlog 15: "To fix" in human terms, not the proof's
 * mutation "3 forbidden lines removed").
 */
export function plainFix(fix: string): string {
  const f = fix.replace(/\s+/gu, ' ').trim();
  let m = /^(\d+) forbidden lines? removed/u.exec(f);
  if (m) {
    const n = Number(m[1]);
    return n === 1
      ? 'Change or remove the line found above so it no longer does what the promise forbids.'
      : `Change or remove the ${n} lines found above so they no longer do what the promise forbids.`;
  }
  m = /^`(.+)` added (?:on|after) (\d+) unguarded lines?/u.exec(f);
  if (m) return `Add the missing check (like \`${m[1]}\`) next to ${Number(m[2]) === 1 ? 'the line' : `each of the ${m[2]} lines`} found above.`;
  m = /^the line `(.+)` added to (.+)$/u.exec(f);
  if (m) return `Add the code that keeps the promise to ${m[2]}, for example \`${m[1]}\`.`;
  m = /^(.+?:\d+) replaced by `(.+)`$/u.exec(f);
  if (m) return `Change ${m[1]} to keep the promise, for example \`${m[2]}\`.`;
  m = /^the value set to the limit \((.+)\) at (.+)$/u.exec(f);
  if (m) return `Set the value at ${m[2]} to ${m[1]}.`;
  m = /^the value set to (.+), as in the kept example at (.+)$/u.exec(f);
  if (m) return `Set the value at ${m[2]} to ${m[1]} (or anything the promise allows).`;
  return f ? `Change the code so the rule passes (the program's fix: ${f}).` : 'Change the code so the rule passes.';
}
