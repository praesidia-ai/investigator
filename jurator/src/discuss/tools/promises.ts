// Owner: DS-A. Tools over the .jurator/ record: promises, rules, the last check, policy text, contradictions.
// Read-only: none of them can accept, waive, edit, bind, compile or check anything.
import { z } from 'zod';
import { BRAND } from '../../brand.js';
import type { Citation, PromiseRecord } from '../../contracts.js';
import { compareAll } from '../../policy/compare.js';
import { bySeverity, LABELS } from '../../render/index.js';
import { DISCUSS_LIMITS, type PolicyExcerpt } from '../contract.js';
import { findingRow, findPromise, lastResult, promiseDetail, promiseRow, quoteExcerpt, ruleRow } from '../core/records.js';
import { type DiscussTool, oneLine, plural, refused, type ToolOutcome } from './types.js';

const L = DISCUSS_LIMITS;
const short = (sha: string): string => sha.slice(0, 7);
const cmd = BRAND.command;

function noPromise(id: string): ToolOutcome {
  return refused(`no promise ${id}`, `There is no promise "${id}". Call list_promises for the ids.`);
}

/** No filter: absent, empty, or a placeholder word a model sent instead of leaving the field out. */
const noFilter = (v: string | undefined): boolean => !v || /^(null|none|all|any|\*)$/iu.test(v.trim());

const listPromisesArgs = z.object({
  source: z.string().min(1).max(64).optional().describe('Only promises of this source alias, e.g. "privacy".'),
  status: z.enum(['accepted', 'draft', 'all']).optional().describe('Default "accepted".'),
});

export const listPromises: DiscussTool<z.infer<typeof listPromisesArgs>> = {
  name: 'list_promises',
  description:
    `Lists the promises: id, kind (must/must-not/may), what checks it (code/process/runtime), wording, accepted rules, ` +
    `bindings, and the verdict of the last check. At most ${L.maxPromiseRows}.`,
  args: listPromisesArgs,
  label: (a) => `list_promises${noFilter(a.source) ? '' : ` ${a.source}`}${a.status && a.status !== 'accepted' ? ` (${a.status})` : ''}`,
  async run(a, { ws }) {
    const status = a.status ?? 'accepted';
    // Models sometimes send the word "null" (or "all") for "no filter"; an unknown alias names the real ones.
    const source = noFilter(a.source) ? undefined : a.source;
    const aliases = [...new Set(ws.data.promises.map((p) => p.quote.alias))].sort();
    if (source && !aliases.includes(source)) {
      return { ok: false, summary: `no source ${source}`, text: `There is no source "${source}". Sources: ${aliases.join(', ') || 'none yet'}. Call list_promises without source for all.` };
    }
    const all = ws.data.promises.filter(
      (p) => (status === 'all' ? p.status !== 'retired' : p.status === status) && (!source || p.quote.alias === source),
    );
    if (all.length === 0) {
      const none = status === 'accepted' ? ` A person compiles and accepts them (\`${cmd} compile\`, \`${cmd} accept\`).` : '';
      return { ok: true, summary: 'no promises', text: `No ${status === 'all' ? '' : `${status} `}promises${source ? ` from ${source}` : ''}.${none}` };
    }
    const shown = all.slice(0, L.maxPromiseRows);
    const lines = [`${plural(all.length, 'promise')} (${status}):`];
    for (const p of shown) {
      const row = promiseRow(ws, p);
      const verdict = row.verdict ? LABELS[row.verdict] : 'not in the last check';
      lines.push(
        `${p.id} [${p.status}, ${p.kind}, ${p.checkable}, ${plural(row.rules, 'accepted rule')}, ${plural(row.bindings, 'binding')}, last: ${verdict}] ${oneLine(p.wording, 200)}`,
      );
    }
    const truncated = all.length > shown.length;
    if (truncated) lines.push(`[${all.length - shown.length} more not shown: pass source]`);
    return { ok: true, summary: plural(all.length, 'promise'), text: lines.join('\n'), truncated };
  },
};

const idArgs = z.object({ id: z.string().min(1).max(80).describe('Promise id, e.g. "privacy.01".') });

export const explainPromise: DiscussTool<z.infer<typeof idArgs>> = {
  name: 'explain_promise',
  description:
    'One promise: wording, the exact policy quote and where it is, typed facets, its rules, its bindings (the code lines ' +
    'where it lives, re-copied from git at the snapshot) and its last finding.',
  args: idArgs,
  label: (a) => `explain_promise ${a.id}`,
  async run(a, { ws, code }) {
    const p = findPromise(ws, a.id);
    if (!p) return noPromise(a.id);
    const d = await promiseDetail(ws, code, p);
    const lines = [
      `${p.id} (${p.status}, ${p.kind}, ${p.checkable}): ${p.wording}`,
      `Policy quote (${d.policy.where}:${d.policy.startLine}${d.policy.endLine > d.policy.startLine ? `-${d.policy.endLine}` : ''}): "${oneLine(p.quote.text, 600)}"`,
    ];
    if (p.facets) {
      const c = p.facets.constraint;
      lines.push(`Facets: subject "${p.facets.subject}", action "${p.facets.action}"${c ? `, ${c.name} ${c.op} ${c.value ?? ''}${c.unit ? ` ${c.unit}` : ''}` : ''}`);
    }
    if (p.scope.length) lines.push(`Scope: ${p.scope.join(', ')}`);
    if (d.rules.length === 0) lines.push(`Rules: none. Next for the user: ${cmd} rule propose ${p.id}`);
    for (const r of d.rules) lines.push(`Rule ${r.id} (${r.status}, ${r.mode}, ${r.provenToFail ? 'proven to fail' : 'not proven to fail'}): ${r.description} [${r.globs.join(', ')}]`);
    const evidence: Citation[] = [];
    for (const b of d.bindings) {
      if (b.citation) {
        evidence.push(b.citation);
        lines.push(`Binding ${b.id}${b.symbol ? ` (${b.symbol})` : ''}${b.moved ? ' (moved or changed since it was bound)' : ''}: ${b.citation.path}:${b.citation.startLine}-${b.citation.endLine}`);
        for (const [i, l] of b.citation.quote.split('\n').slice(0, 8).entries()) lines.push(`  ${b.citation.startLine + i}  ${l}`);
      } else lines.push(`Binding ${b.id}${b.symbol ? ` (${b.symbol})` : ''}: no longer found at the snapshot`);
    }
    if (d.finding) {
      lines.push(`Last check: ${d.finding.label}${d.finding.explanation ? `: ${oneLine(d.finding.explanation, 400)}` : ''}`);
      for (const c of d.finding.citations) lines.push(`  cited ${c.path}:${c.startLine}-${c.endLine}`);
    } else lines.push(`Last check: not in a saved check run. Next for the user: ${cmd} check`);
    return {
      ok: true,
      summary: `${d.rules.length ? plural(d.rules.length, 'rule') : 'no rule'}, ${plural(d.bindings.length, 'binding')}${d.finding ? `, ${d.finding.label}` : ''}`,
      text: lines.join('\n'),
      evidence,
      policy: [d.policy],
    };
  },
};

export const lastCheck: DiscussTool<Record<string, never>> = {
  name: 'last_check',
  description: 'The newest saved check run: its commit, whether it is stale (not the session snapshot), the summary, and the verdict label per promise.',
  args: z.object({}) as unknown as z.ZodType<Record<string, never>>,
  label: () => 'last_check',
  async run(_a, { ws }) {
    const run = ws.data.lastRun;
    if (!run) return { ok: true, summary: 'no check yet', text: `No saved check run yet. Next for the user: ${cmd} check` };
    const s = run.summary;
    const stale = ws.isStale(run);
    const lines = [
      `Run ${run.id} at ${run.createdAt}, code ${short(run.snapshot.commit)}${stale ? ` (STALE: the session snapshot is ${short(ws.snapshot.commit)}; findings may be out of date, the user can run \`${cmd} check\`)` : ' (the session snapshot)'}, status ${run.status}.`,
      `Summary: ${s.broken} broken, ${s.looksBroken} looks broken, ${s.cantTell} can't tell, ${s.holds} holds, ${s.looksKept} looks kept, ${s.notChecked} not checked; ${s.coveredByRules} of ${s.codePromises} code promises have a rule.`,
    ];
    const results = bySeverity(run.results).slice(0, L.maxPromiseRows);
    for (const r of results) lines.push(`${r.promiseId}: ${LABELS[r.verdict]}  ${oneLine(r.wording, 120)}`);
    const parts = [s.broken ? `${s.broken} broken` : '', s.looksBroken ? `${s.looksBroken} looks broken` : ''].filter(Boolean);
    return {
      ok: true,
      summary: `${parts.length ? parts.join(', ') : 'nothing broken'}${stale ? ' (stale)' : ''}`,
      text: lines.join('\n'),
      truncated: run.results.length > results.length,
    };
  },
};

const findingArgs = z.object({ promiseId: z.string().min(1).max(80).describe('Promise id, e.g. "privacy.01".') });

export const showFinding: DiscussTool<z.infer<typeof findingArgs>> = {
  name: 'show_finding',
  description:
    `What the last check found for one promise: the verdict label and level, the explanation, and up to ${L.maxFindingCitations} cited code ` +
    "lines re-copied from git at the run's commit.",
  args: findingArgs,
  label: (a) => `show_finding ${a.promiseId}`,
  async run(a, { ws, code }) {
    const run = ws.data.lastRun;
    if (!run) return { ok: true, summary: 'no check yet', text: `No saved check run yet. Next for the user: ${cmd} check` };
    const result = lastResult(run, a.promiseId);
    if (!result) {
      if (!findPromise(ws, a.promiseId)) return noPromise(a.promiseId);
      return { ok: true, summary: 'not in the last check', text: `${a.promiseId} is not in run ${run.id}. Next for the user: ${cmd} check` };
    }
    const f = await findingRow(code, result);
    const lines = [
      `${f.promiseId}: ${f.label} (level ${f.level}) in run ${run.id} at ${short(run.snapshot.commit)}${ws.isStale(run) ? ' (stale: not the session snapshot)' : ''}.`,
      `Promise: ${oneLine(f.wording, 300)}`,
    ];
    if (f.explanation) lines.push(`Explanation: ${oneLine(f.explanation, 800)}`);
    for (const r of result.ruleResults ?? []) lines.push(`Rule ${r.ruleId}: ${r.outcome}: ${oneLine(r.message, 300)}`);
    for (const c of f.citations) {
      lines.push(`${c.path}:${c.startLine}-${c.endLine} @ ${short(c.commit)}`);
      for (const [i, l] of c.quote.split('\n').slice(0, 30).entries()) lines.push(`  ${c.startLine + i}  ${l}`);
    }
    return { ok: true, summary: `${f.label} · ${plural(f.citations.length, 'citation')}`, text: lines.join('\n'), evidence: f.citations };
  },
};

const rulesArgs = z.object({ promiseId: z.string().min(1).max(80).optional().describe('Only the rules of this promise.') });

export const listRules: DiscussTool<z.infer<typeof rulesArgs>> = {
  name: 'list_rules',
  description: `The rules (no AI) that decide HOLDS or BROKEN: mode, pattern, globs, status, and whether the program proved each can fail. At most ${L.maxRuleRows}.`,
  args: rulesArgs,
  label: (a) => `list_rules${a.promiseId ? ` ${a.promiseId}` : ''}`,
  async run(a, { ws }) {
    const rules = ws.data.rules.filter((r) => !a.promiseId || r.promiseId === a.promiseId);
    if (rules.length === 0) {
      if (a.promiseId && !findPromise(ws, a.promiseId)) return noPromise(a.promiseId);
      return {
        ok: true,
        summary: 'no rules',
        text: `No rules${a.promiseId ? ` for ${a.promiseId}` : ''}. Next for the user: ${cmd} rule propose ${a.promiseId ?? '<promise id>'}`,
      };
    }
    const shown = rules.slice(0, L.maxRuleRows);
    const lines = [`${plural(rules.length, 'rule')}:`];
    for (const r of shown) {
      const row = ruleRow(r);
      const anchor = r.mode === 'each-near' && r.anchor ? ` anchor /${r.anchor}/ within ${r.within ?? 0}` : '';
      lines.push(
        `${r.id} for ${r.promiseId} (${r.status}, ${r.mode}${anchor}, pattern /${oneLine(r.pattern, 200)}/${r.flags ?? ''}, ${row.provenToFail ? 'proven to fail' : 'not proven to fail'}) [${r.globs.join(', ')}]: ${oneLine(r.description, 200)}`,
      );
    }
    const truncated = rules.length > shown.length;
    return { ok: true, summary: plural(rules.length, 'rule'), text: lines.join('\n'), truncated };
  },
};

const policyArgs = z.object({
  source: z.string().min(1).max(200).describe('Source alias (e.g. "privacy") or its path (e.g. "docs/privacy.md").'),
  start: z.number().int().min(1).optional().describe('First line, default 1.'),
  end: z.number().int().min(1).optional().describe(`Last line; at most ${L.maxPolicyLines} lines per call.`),
});

export const policyText: DiscussTool<z.infer<typeof policyArgs>> = {
  name: 'policy_text',
  description: `Lines of a policy as it was last pulled (the locked copy in ${BRAND.folder}/sources/), numbered. Cite as [[<path>:start-end]].`,
  args: policyArgs,
  label: (a) => `policy_text ${a.source}${a.start ? `:${a.start}${a.end ? `-${a.end}` : ''}` : ''}`,
  async run(a, { ws }) {
    const alias = ws.sourceAlias(a.source);
    const known = Object.keys(ws.data.sources);
    if (!alias) return refused(`no source ${a.source}`, `There is no policy source "${a.source}". Sources: ${known.join(', ') || 'none'}.`);
    const locked = await ws.policyText(alias);
    if (!locked) return refused('not pulled yet', `${alias} has no locked text yet. Next for the user: ${cmd} pull`);
    const all = locked.text.split('\n');
    if (all.length > 1 && all[all.length - 1] === '') all.pop();
    const start = a.start ?? 1;
    if (start > all.length) return refused(`out of range (${plural(all.length, 'line')})`, `${alias} has ${plural(all.length, 'line')}.`);
    let end = Math.min(a.end ?? all.length, all.length);
    if (end < start) end = start;
    let truncated = false;
    if (end - start + 1 > L.maxPolicyLines) {
      end = start + L.maxPolicyLines - 1;
      truncated = true;
    }
    const where = ws.data.sources[alias] ?? alias;
    const lines = all.slice(start - 1, end);
    const width = String(end).length;
    const text = [
      `${where}:${start}-${end} (source ${alias}, ${plural(all.length, 'line')}, sha256 ${locked.entry.sha256.slice(0, 12)}):`,
      ...lines.map((l, i) => `${String(start + i).padStart(width)}  ${l}`),
      ...(truncated ? [`[cut at ${L.maxPolicyLines} lines: read on from line ${end + 1}]`] : []),
    ].join('\n');
    const excerpt: PolicyExcerpt = { alias, where, startLine: start, endLine: end, text: lines.join('\n'), sha256: locked.entry.sha256 };
    return { ok: true, summary: `${plural(lines.length, 'line')} of ${where}`, text, policy: [excerpt], truncated };
  },
};

const compareArgs = z.object({
  ids: z.array(z.string().min(1).max(80)).max(50).optional().describe('Only pairs among these promise ids (default: every accepted promise).'),
});

export const comparePolicies: DiscussTool<z.infer<typeof compareArgs>> = {
  name: 'compare_policies',
  description:
    'Compares promises by their typed facets with no AI (same subject and action, constraints that cannot both hold) and lists the ' +
    `contradictions already recorded. At most ${L.maxComparePairs} pairs.`,
  args: compareArgs,
  label: (a) => `compare_policies${a.ids?.length ? ` ${a.ids.join(' ')}` : ''}`,
  async run(a, { ws }) {
    const want = a.ids?.length ? new Set(a.ids) : null;
    const pool: PromiseRecord[] = ws.accepted().filter((p) => !want || want.has(p.id));
    const result = compareAll(pool);
    const recorded = ws.data.contradictions.filter((c) => !want || c.promiseIds.some((id) => want.has(id)));
    const lines = [
      `${plural(result.pairs, 'pair')} compared, ${result.decided} decided with no AI, ${plural(result.conflicts.length, 'structured conflict')}, ${result.undecided.length} undecided.`,
    ];
    const conflicts = result.conflicts.slice(0, L.maxComparePairs);
    for (const c of conflicts) lines.push(`Conflict ${c.promiseIds.join(' vs ')} (${c.basis}): ${oneLine(c.example, 300)}`);
    for (const c of recorded.slice(0, L.maxComparePairs)) {
      lines.push(`Recorded ${c.id} (${c.status}${c.ruling ? `, ruled by ${c.ruling.by}` : ''}) ${c.promiseIds.join(' vs ')}: ${oneLine(c.example, 300)}`);
    }
    if (result.undecided.length) {
      lines.push(`Undecided (no typed facets or limits the program cannot weigh): ${result.undecided.slice(0, L.maxComparePairs).map((p) => p.join('/')).join(', ')}`);
    }
    const involved = [...new Set([...conflicts.flatMap((c) => c.promiseIds), ...recorded.flatMap((c) => c.promiseIds)])].slice(0, 6);
    const policy: PolicyExcerpt[] = [];
    for (const id of involved) {
      const p = findPromise(ws, id);
      if (p) policy.push(await quoteExcerpt(ws, p));
    }
    for (const x of policy) lines.push(`Quote ${x.where}:${x.startLine}: "${oneLine(x.text, 300)}"`);
    const n = result.conflicts.length + recorded.filter((c) => c.status !== 'not-a-conflict').length;
    return {
      ok: true,
      summary: n ? plural(n, 'contradiction') : 'no contradictions',
      text: lines.join('\n'),
      policy,
      truncated: result.conflicts.length > conflicts.length,
    };
  },
};
