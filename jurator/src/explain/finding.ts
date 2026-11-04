// Owner: HZ-1. Findings from what each command already has: a BROKEN NOW from rule propose, a result from a check, a
// promise with no rule. Every code line comes from the program (git), never from a model.
import type { CheckResult, CheckRun, PromiseRecord, Rule, RuleRunResult } from '../contracts.js';
import type { BrokenNow } from '../rules/index.js';
import type { Finding, FindingEvidence } from './summary.js';

const firstLine = (quote: string): string => (quote.split('\n').find((l) => l.trim() !== '') ?? '').trim();
const cap = (s: string): string => (s.length > 160 ? `${s.slice(0, 159)}…` : s);

export function fromBrokenNow(p: PromiseRecord, rule: Pick<Rule, 'description'>, b: BrokenNow): Finding {
  return {
    promiseId: p.id,
    kind: 'broken-now',
    wording: p.wording,
    policy: p.quote.text,
    evidence: b.evidence.map((e) => ({ path: e.path, line: e.line, code: e.quote, actual: e.actual, allowed: e.allowed })),
    rule: rule.description,
    ruleMessage: b.message,
    programFix: b.fix,
  };
}

export function fromNoRule(p: PromiseRecord, reason: string, infeasible: boolean): Finding {
  return { promiseId: p.id, kind: 'no-rule', wording: p.wording, policy: p.quote.text, evidence: [], reason, infeasible };
}

/** Evidence from a check result: the lines at the checked commit first. */
export function citationEvidence(run: Pick<CheckRun, 'target'> | null, r: Pick<CheckResult, 'citations'>): FindingEvidence[] {
  const head = run?.target.head;
  const at = head ? r.citations.filter((c) => c.commit === head) : r.citations;
  const list = at.length > 0 ? at : r.citations;
  return list.map((c) => ({ path: c.path, line: c.startLine, code: cap(firstLine(c.quote)) }));
}

/** A finding for a check result that needs one (BROKEN, LOOKS BROKEN, CAN'T TELL); null for the others. */
export function fromCheckResult(run: Pick<CheckRun, 'target'> | null, r: CheckResult, rules: readonly Rule[] = []): Finding | null {
  const kind = r.verdict === 'broken' ? 'broken' : r.verdict === 'looks-broken' ? 'looks-broken' : r.verdict === 'cant-tell' ? 'cant-tell' : null;
  if (!kind) return null;
  const failed = r.ruleResults?.find((x) => x.outcome === 'fail');
  const rule = failed ? rules.find((x) => x.id === failed.ruleId) : undefined;
  const ai = r.level === 'ai-read';
  return {
    promiseId: r.promiseId,
    kind,
    wording: r.wording,
    policy: r.policyQuote.text,
    evidence: citationEvidence(run, r),
    ...(rule ? { rule: rule.description } : {}),
    ...(!ai && (failed?.message ?? r.explanation) ? { ruleMessage: failed?.message ?? r.explanation } : {}),
    ...(ai && r.explanation ? { aiRead: r.explanation } : {}),
    ...(r.reason && kind === 'cant-tell' ? { reason: r.reason } : {}),
    ...(r.trigger ? { trigger: r.trigger } : {}),
  };
}

/** A finding for a rule that fails when run now (explain). */
export function fromRuleRun(p: PromiseRecord, rule: Rule, res: RuleRunResult): Finding {
  return {
    promiseId: p.id,
    kind: 'broken',
    wording: p.wording,
    policy: p.quote.text,
    evidence: res.hits.map((h) => ({ path: h.path, line: h.startLine, code: cap(firstLine(h.quote)) })),
    rule: rule.description,
    ruleMessage: res.message,
  };
}
