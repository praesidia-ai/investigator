// Owner: X-FRONTEND. One self-contained HTML page (inline CSS + a few lines of JS; Google Fonts with system fallbacks).
// Every piece of policy or code text goes through esc(): policies and code are untrusted input.
import { BRAND } from '../brand.js';
import type { Citation, Contradiction, PromiseRecord } from '../contracts.js';
import { anchor, esc } from './escape.js';
import { buildGraph, renderGraphSvg } from './graph.js';
import {
  headline,
  humanTime,
  promiseViews,
  ruleViews,
  shortSha,
  sortByVerdict,
  type PromiseView,
  type ReportInput,
  type RuleView,
  type Tone,
  type VerdictView,
} from './model.js';

const MAX_CODE_LINES = 10;
const MAX_CITATIONS = 3;

function cmd(text: string): string {
  return `<code class="cmd">${esc(text)}</code>`;
}
function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}
function repoName(input: ReportInput): string {
  const raw = input.run?.snapshot.repo ?? input.repoName ?? 'this repo';
  return raw.split(/[\\/]/u).filter(Boolean).pop() ?? raw;
}

function badge(v: VerdictView): string {
  return `<span class="verdict v-${v.tone}">${esc(v.word)}</span><span class="by">${esc(v.by)}</span>`;
}

/* ------------------------------ headline ------------------------------ */

function heroHtml(input: ReportInput): string {
  const h = headline(input);
  const run = input.run;
  const cells = Array.from({ length: h.codePromises }, (_, i) =>
    `<span class="cell${i < h.covered ? ' on' : ''}"></span>`,
  ).join('');
  const title =
    h.codePromises === 0
      ? 'No code promises yet'
      : `${h.covered} of ${h.codePromises} code promises are covered by rules`;
  const tally = run
    ? h.counts.length > 0
      ? `<ul class="tally">${h.counts
          .map((c) => `<li class="tally-row"><span class="tally-n">${c.count}</span>${badge(c.view)}</li>`)
          .join('')}</ul>`
      : `<p class="tally-empty">${run.target.kind === 'diff' ? 'This change touches no promise.' : 'No accepted promise was checked.'}</p>`
    : `<p class="tally-empty">No check yet. Run ${cmd(`${BRAND.command} check`)}, then ${cmd(`${BRAND.command} report`)} again.</p>`;

  const facts: Array<[string, string]> = [];
  if (run) {
    const s = run.snapshot;
    facts.push(['Commit', `<code>${esc(shortSha(run.target.head))}</code>${s.branch ? ` on <code>${esc(s.branch)}</code>` : ''}`]);
    if (run.target.kind === 'diff') {
      facts.push(['Compared with', `<code>${esc(run.target.base ? shortSha(run.target.base) : '?')}</code>`]);
    }
    facts.push(['Checked', esc(humanTime(run.createdAt))]);
    facts.push(['Mode', esc(run.failMode === 'block' ? 'block: a broken promise stops the push' : run.failMode)]);
    facts.push(['Cost', esc(run.costUsd > 0 && run.costUsd < 0.01 ? `$${run.costUsd.toFixed(4)}` : `$${run.costUsd.toFixed(2)}`)]);
  } else {
    facts.push(['Written', esc(humanTime(input.generatedAt.toISOString()))]);
  }
  const factsHtml = facts.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${v}</dd></div>`).join('');

  const notes: string[] = [];
  if (run?.snapshot.dirty) notes.push('The working tree had uncommitted changes; this run read the commit only.');
  if (run && run.status !== 'completed') notes.push(`This run is ${run.status}: some checks could not run.`);
  const changed = run?.target.kind === 'diff' && run.target.changedFiles?.length
    ? `<p class="changed">Changed in this diff: ${run.target.changedFiles.map((f) => `<code>${esc(f)}</code>`).join(' ')}</p>`
    : '';

  return `<section class="hero wrap">
  <div class="hero-main">
    <h1>${esc(title)}</h1>
    ${h.codePromises > 0 ? `<div class="cells" aria-label="${esc(`${h.covered} of ${h.codePromises} covered`)}">${cells}</div>` : ''}
    <dl class="facts">${factsHtml}</dl>
    ${changed}
    ${notes.map((n) => `<p class="note">${esc(n)}</p>`).join('')}
  </div>
  <div class="hero-side">${tally}</div>
</section>`;
}

/* ------------------------------ promises ------------------------------ */

function policyQuoteHtml(p: PromiseRecord, where: string): string {
  const q = p.quote;
  const lineNo = q.line ? String(q.line) : '';
  const text = q.jsonPointer ? `${q.jsonPointer}: ${q.text}` : q.text;
  return `<figure class="quote">
    <div class="q-line"><span class="q-no">${esc(lineNo)}</span><blockquote>${esc(text)}</blockquote></div>
    <figcaption><code>${esc(where)}</code></figcaption>
  </figure>`;
}

function codeHtml(c: Citation, hot: boolean): string {
  const lines = c.quote.split('\n');
  const shown = lines.slice(0, MAX_CODE_LINES);
  const rows = shown
    .map((l, i) => `<span class="c-row${hot ? ' hot' : ''}"><span class="c-no">${c.startLine + i}</span><span class="c-src">${esc(l) || ' '}</span></span>`)
    .join('');
  const more = lines.length > shown.length ? `<span class="c-more">${plural(lines.length - shown.length, 'more line')}</span>` : '';
  const range = c.endLine > c.startLine ? `${c.startLine}-${c.endLine}` : `${c.startLine}`;
  return `<figure class="code">
    <figcaption><code>${esc(c.path)}:${esc(range)}</code><span class="at">at ${esc(shortSha(c.commit))}</span></figcaption>
    <pre>${rows}${more}</pre>
  </figure>`;
}

function evidenceHtml(v: PromiseView): string {
  const tone = v.verdict.tone;
  const hot = tone === 'broken' || tone === 'looks-broken';
  const cites = v.citations.slice(0, MAX_CITATIONS).map((c) => codeHtml(c, hot)).join('');
  const extra = v.citations.length > MAX_CITATIONS ? `<p class="muted">${plural(v.citations.length - MAX_CITATIONS, 'more place')} in the run record.</p>` : '';
  const note = v.note ? `<p class="why${hot ? ' why-hot' : ''}">${esc(v.note)}</p>` : '';
  if (cites) return `${cites}${extra}${note}`;
  if (v.result) return `<div class="no-code">${note || '<p class="why">No code lines to show.</p>'}</div>`;
  let hint: string;
  if (v.onChecklist) hint = 'A person confirms this before merge (it is on the PR checklist).';
  else if (v.promise.checkable === 'process') hint = 'A process promise: it is not checked in code.';
  else if (v.promise.checkable === 'runtime') hint = 'Enforced while the system runs, not in the code.';
  else if (v.rules.length > 0) hint = `Has ${plural(v.rules.length, 'rule')}; not part of this run.`;
  else hint = `No rule yet. ${BRAND.command} rule propose ${v.promise.id}`;
  return `<div class="no-code"><p class="why">${esc(hint)}</p></div>`;
}

function promiseHtml(v: PromiseView): string {
  const p = v.promise;
  const rules = v.rules.length
    ? `<p class="p-rules">${v.rules.map((r) => `<a href="#rule-${esc(anchor(r.id))}"><code>${esc(r.id)}</code></a>`).join(' ')}</p>`
    : '';
  return `<article class="promise t-${v.verdict.tone}" id="promise-${esc(anchor(p.id))}">
  <div class="p-gutter">
    <code class="p-id">${esc(p.id)}</code>
    <div class="p-verdict">${badge(v.verdict)}</div>
    ${rules}
  </div>
  <div class="p-policy">
    <h3>${esc(p.wording)}</h3>
    ${policyQuoteHtml(p, v.policyWhere)}
  </div>
  <div class="p-code">${evidenceHtml(v)}</div>
</article>`;
}

function promisesHtml(views: readonly PromiseView[]): string {
  const body = views.length
    ? sortByVerdict(views).map(promiseHtml).join('\n')
    : `<p class="empty">No promises yet. Run ${cmd(`${BRAND.command} compile`)} to turn your policies into promises, each with its exact quote.</p>`;
  const problems = views.filter((v) => v.verdict.rank <= 2).length;
  const sub = views.length ? `${plural(views.length, 'promise')}${problems ? `, ${plural(problems, 'needs', 'need')} a look` : ''}. Problems first.` : '';
  return `<section class="block wrap" id="promises">
  <div class="block-head"><h2>Promises</h2><p>${esc(sub)}</p></div>
  <div class="cols-head" aria-hidden="true"><span></span><span>What the policy says</span><span>What the code says</span></div>
  ${body}
</section>`;
}

/* ------------------------------ rules ------------------------------ */

function outcomeHtml(r: RuleView): string {
  const tone: Tone = r.outcome === 'fail' ? 'broken' : r.outcome === 'pass' ? 'kept' : r.outcome === 'error' ? 'unsure' : 'none';
  const word = r.outcome === 'fail' ? 'fails' : r.outcome === 'pass' ? 'passes' : r.outcome === 'error' ? 'error' : 'not run';
  const msg = r.result ? `<p class="why">${esc(r.result.message)}</p>` : '';
  return `<span class="verdict v-${tone}">${esc(word)}</span>${msg}`;
}

function ruleHtml(r: RuleView): string {
  const rule = r.rule;
  const how =
    rule.mode === 'each-near'
      ? `every line matching <code>${esc(rule.anchor ?? '?')}</code> has <code>${esc(rule.pattern)}</code> within ${esc(rule.within ?? 0)} lines`
      : rule.mode === 'must-match'
        ? `some line matches <code>${esc(rule.pattern)}</code>`
        : `no line matches <code>${esc(rule.pattern)}</code>`;
  const proof = rule.provenBy
    ? `<p class="proof${rule.provenBy.failedAsExpected ? ' ok' : ''}"><span class="mark" aria-hidden="true">${rule.provenBy.failedAsExpected ? '✓' : '✗'}</span>${esc(rule.provenBy.mutation)}${rule.provenBy.failedAsExpected ? '' : ' (it did not fail: do not trust this rule)'}</p>`
    : '<p class="proof">Not proven yet: nobody showed this rule can fail.</p>';
  const status = rule.status === 'accepted' ? '' : ` <span class="tag">${esc(rule.status)}</span>`;
  return `<article class="rule" id="rule-${esc(anchor(rule.id))}">
  <div class="r-id"><code>${esc(rule.id)}</code>${status}<a href="#promise-${esc(anchor(rule.promiseId))}"><code>${esc(rule.promiseId)}</code></a></div>
  <div class="r-what"><p>${esc(rule.description)}</p><p class="r-how">In <code>${esc(rule.globs.join(', '))}</code>, ${how}</p></div>
  <div class="r-proof">${proof}</div>
  <div class="r-out">${outcomeHtml(r)}</div>
</article>`;
}

function rulesHtml(views: readonly RuleView[]): string {
  const body = views.length
    ? `<div class="rules-head" aria-hidden="true"><span>Rule</span><span>What it checks</span><span>Proof it can fail</span><span>This run</span></div>${views.map(ruleHtml).join('\n')}`
    : `<p class="empty">No rules yet. Run ${cmd(`${BRAND.command} rule propose --all`)}: the model writes each rule, the program proves it can fail before saving it.</p>`;
  return `<section class="block wrap" id="rules">
  <div class="block-head"><h2>Rules</h2><p>${esc(views.length ? 'No AI: the same answer on every run.' : '')}</p></div>
  ${body}
</section>`;
}

/* ------------------------------ contradictions ------------------------------ */

function contradictionHtml(c: Contradiction, byId: ReadonlyMap<string, PromiseView>): string {
  const sides = c.promiseIds
    .map((id) => {
      const v = byId.get(id);
      if (!v) return `<div class="c-side"><code>${esc(id)}</code></div>`;
      return `<div class="c-side"><a href="#promise-${esc(anchor(id))}"><code>${esc(id)}</code></a><p class="c-wording">${esc(v.promise.wording)}</p>${policyQuoteHtml(v.promise, v.policyWhere)}</div>`;
    })
    .join('<div class="c-vs" aria-hidden="true">vs</div>');
  const status =
    c.status === 'open' ? 'Open: a person should decide which policy wins.' : c.status === 'real' ? 'Confirmed as a real conflict.' : 'Ruled not a conflict.';
  const ruling = c.ruling ? ` ${c.ruling.by}: ${c.ruling.why}` : '';
  return `<article class="conflict s-${esc(c.status)}">
  <div class="c-sides">${sides}</div>
  <p class="c-example"><strong>${esc(c.id)}</strong> ${esc(c.example)}</p>
  <p class="muted">${esc(status + ruling)}</p>
</article>`;
}

function contradictionsHtml(items: readonly Contradiction[], views: readonly PromiseView[]): string {
  const byId = new Map(views.map((v) => [v.promise.id, v]));
  const body = items.length
    ? items.map((c) => contradictionHtml(c, byId)).join('\n')
    : '<p class="empty">No contradictions found between your policies.</p>';
  return `<section class="block wrap" id="contradictions">
  <div class="block-head"><h2>Contradictions</h2><p>${esc(items.length ? 'Two promises that cannot both be kept.' : '')}</p></div>
  ${body}
</section>`;
}

/* ------------------------------ graph ------------------------------ */

function graphHtml(input: ReportInput, views: readonly PromiseView[], rules: readonly RuleView[]): string {
  if (views.length === 0) {
    return `<section class="block wrap" id="graph"><div class="block-head"><h2>Promise graph</h2></div><p class="empty">The graph appears once there are promises.</p></section>`;
  }
  const svg = renderGraphSvg(buildGraph(views, rules, input.contradictions, input.sources));
  return `<section class="block wrap" id="graph">
  <div class="block-head"><h2>Promise graph</h2><p>Policies to promises to code to rules. Every box is a file or a record in <code>${esc(BRAND.folder)}/</code>.</p></div>
  <div class="graph-scroll" tabindex="0">${svg}</div>
  <ul class="legend">
    <li><svg width="34" height="10" aria-hidden="true"><path class="g-edge e-broken" d="M2 5 H32"/></svg>broken, proved by a rule</li>
    <li><svg width="34" height="10" aria-hidden="true"><path class="g-edge e-looks-broken" d="M2 5 H32"/></svg>looks broken, read by AI</li>
    <li><svg width="34" height="10" aria-hidden="true"><path class="g-conflict" d="M2 5 H32"/></svg>contradiction</li>
    <li><svg width="34" height="14" aria-hidden="true"><rect class="legend-glob" x="2" y="2" width="30" height="10" rx="3"/></svg>files under a rule's pattern (no line to cite)</li>
  </ul>
</section>`;
}

/* ------------------------------ page ------------------------------ */

function footerHtml(input: ReportInput): string {
  const run = input.run;
  const verify = run
    ? `<p>Re-check this record with no AI: ${cmd(`${BRAND.command} verify ${input.runPath ?? '<run.json>'}`)}</p>
       <p class="muted">Run <code>${esc(run.id)}</code>, digest <code>${esc(run.digest.slice(0, 16))}</code>, ${esc(BRAND.name)} ${esc(run.toolVersion)}.</p>`
    : '';
  return `<footer class="foot wrap">
  ${verify}
  <p class="muted">Policy quotes are located in the policy text by the program; code lines are copied from git at the commit. Model text is never evidence. Written ${esc(humanTime(input.generatedAt.toISOString()))}.</p>
</footer>`;
}

const SCRIPT = `(function(){var k='kw-report-scale',r=document.documentElement;function set(v){v=Math.round(Math.min(1.6,Math.max(0.8,v))*10)/10;r.style.setProperty('--scale',String(v));try{localStorage.setItem(k,String(v))}catch(e){}}try{var s=parseFloat(localStorage.getItem(k)||'');if(s)set(s)}catch(e){}var b=document.querySelectorAll('[data-size]');for(var i=0;i<b.length;i++){b[i].addEventListener('click',function(ev){var t=ev.currentTarget.getAttribute('data-size');var c=parseFloat(getComputedStyle(r).getPropertyValue('--scale'))||1;set(t==='up'?c+0.1:t==='down'?c-0.1:1)})}})();`;

export function renderReport(input: ReportInput): string {
  const views = promiseViews(input);
  const rules = ruleViews(input);
  const name = repoName(input);
  const title = `${BRAND.name} report: ${name}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>${esc(title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Fira+Code:wght@400;500&display=swap">
<style>${CSS}</style>
</head>
<body>
<header class="bar wrap">
  <p class="bar-name"><strong>${esc(BRAND.name)}</strong> report for <code>${esc(name)}</code></p>
  <nav class="bar-nav" aria-label="Sections"><a href="#graph">Graph</a><a href="#promises">Promises</a><a href="#rules">Rules</a><a href="#contradictions">Contradictions</a></nav>
  <div class="size" role="group" aria-label="Text size"><button type="button" data-size="down" aria-label="Smaller text">A−</button><button type="button" data-size="reset" aria-label="Default text size">A</button><button type="button" data-size="up" aria-label="Larger text">A+</button></div>
</header>
<main>
${heroHtml(input)}
${graphHtml(input, views, rules)}
${promisesHtml(views)}
${rulesHtml(rules)}
${contradictionsHtml(input.contradictions, views)}
</main>
${footerHtml(input)}
<script>${SCRIPT}</script>
</body>
</html>
`;
}

const CSS = `
:root{
  --scale:1;
  --paper:#f8fafc;--sheet:#ffffff;--gutter:#f1f5f9;--line:#e2e8f0;--line-2:#cbd5e1;
  --ink:#0f172a;--ink-2:#1e293b;--muted:#64748b;
  --amber:#f59e0b;--amber-ink:#b45309;--amber-wash:#fef3c7;
  --red:#dc2626;--red-ink:#b91c1c;--red-wash:#fef2f2;
  --green:#16a34a;--green-ink:#15803d;--green-wash:#f0fdf4;
  --sans:'Inter',system-ui,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;
  --mono:'Fira Code',ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  color-scheme:light;
}
*{box-sizing:border-box}
html{font-size:calc(106.25% * var(--scale));-webkit-text-size-adjust:100%}
body{margin:0;background:var(--paper);color:var(--ink);font-family:var(--sans);line-height:1.55;font-feature-settings:'cv11','ss01'}
code,pre,.cmd{font-family:var(--mono);font-size:.86em;font-variant-ligatures:none;font-feature-settings:'calt' 0,'liga' 0}
a{color:inherit;text-decoration-color:var(--line-2);text-underline-offset:3px}
a:hover{text-decoration-color:var(--amber)}
:focus-visible{outline:3px solid var(--amber);outline-offset:2px;border-radius:4px}
h1,h2,h3,p,figure,blockquote,dl,dd{margin:0}
.wrap{max-width:1560px;margin-left:auto;margin-right:auto;padding-left:clamp(16px,3.2vw,56px);padding-right:clamp(16px,3.2vw,56px)}
.muted{color:var(--muted);font-size:.9rem}
.cmd{background:var(--ink);color:#f8fafc;padding:.12em .45em;border-radius:5px;white-space:nowrap}

/* top bar */
.bar{display:flex;align-items:center;gap:24px;flex-wrap:wrap;padding-top:18px;padding-bottom:18px;border-bottom:1px solid var(--line)}
.bar-name{font-size:1rem;margin-right:auto}
.bar-nav{display:flex;gap:18px;flex-wrap:wrap}
.bar-nav a{text-decoration:none;color:var(--ink-2);font-weight:500}
.bar-nav a:hover{color:var(--amber-ink)}
.size{display:flex;border:1px solid var(--line-2);border-radius:8px;overflow:hidden;background:var(--sheet)}
.size button{font:600 .9rem var(--sans);color:var(--ink);background:none;border:0;padding:6px 12px;cursor:pointer;min-width:42px;min-height:36px}
.size button+button{border-left:1px solid var(--line)}
.size button:hover{background:var(--amber-wash)}

/* headline */
.hero{display:grid;grid-template-columns:minmax(0,1.6fr) minmax(280px,1fr);gap:clamp(24px,4vw,72px);padding-top:clamp(28px,4vw,56px);padding-bottom:clamp(28px,4vw,48px);align-items:start}
.hero h1{font-size:clamp(1.9rem,3.6vw,3.1rem);line-height:1.12;letter-spacing:-.025em;font-weight:700;max-width:22ch}
.cells{display:flex;flex-wrap:wrap;gap:6px;margin-top:22px}
.cell{width:30px;height:30px;border-radius:6px;border:2px solid var(--line-2);background:var(--sheet)}
.cell.on{background:var(--amber);border-color:var(--amber)}
.facts{display:flex;flex-wrap:wrap;gap:14px 36px;margin-top:26px}
.facts dt{color:var(--muted);font-size:.85rem}
.facts dd{font-weight:500}
.changed{margin-top:16px;color:var(--ink-2)}
.changed code{background:var(--gutter);padding:.1em .4em;border-radius:4px;margin-right:4px}
.note{margin-top:12px;padding:8px 12px;border-left:3px solid var(--amber);background:var(--amber-wash);color:var(--ink-2);max-width:70ch}
.tally{list-style:none;margin:0;padding:0;display:grid;gap:10px}
.tally-row{display:flex;align-items:center;gap:14px;padding:12px 16px;background:var(--sheet);border:1px solid var(--line);border-radius:10px}
.tally-n{font-size:1.9rem;font-weight:700;letter-spacing:-.02em;min-width:1.6ch;text-align:right;line-height:1}
.tally-empty{padding:16px;background:var(--sheet);border:1px dashed var(--line-2);border-radius:10px;color:var(--ink-2)}

/* verdict badges: solid = a rule decided, dashed = an AI read, plain = nothing judged */
.verdict{display:inline-block;font-weight:700;font-size:.8rem;letter-spacing:.03em;padding:.22em .6em;border-radius:5px;border:1.5px solid transparent;white-space:nowrap}
.by{display:inline-block;margin-left:8px;color:var(--muted);font-size:.85rem}
.v-broken{background:var(--red);color:#fff}
.v-kept{background:var(--green);color:#fff}
.v-looks-broken{color:var(--red-ink);background:var(--red-wash);border:1.5px dashed var(--red)}
.v-looks-kept{color:var(--green-ink);background:var(--green-wash);border:1.5px dashed var(--green)}
.v-unsure{color:var(--ink-2);background:var(--sheet);border:1.5px dashed var(--muted)}
.v-none{color:var(--muted);background:var(--gutter);font-weight:600;letter-spacing:0}

/* sections */
.block{padding-top:clamp(28px,4vw,48px);padding-bottom:8px}
.block-head{display:flex;align-items:baseline;gap:18px;flex-wrap:wrap;margin-bottom:18px}
.block-head h2{font-size:1.6rem;letter-spacing:-.015em}
.block-head p{color:var(--muted)}
.empty{padding:22px;border:1px dashed var(--line-2);border-radius:10px;background:var(--sheet);color:var(--ink-2)}

/* graph */
.graph-scroll{overflow-x:auto;background:var(--sheet);border:1px solid var(--line);border-radius:12px;padding:12px 8px}
.graph{display:block;width:100%;height:auto;min-width:880px;font-family:var(--sans)}
.g-head{font-size:15px;font-weight:700;fill:var(--ink)}
.g-count{font-weight:500;fill:var(--muted)}
.g-node rect{fill:var(--sheet);stroke:var(--line-2);stroke-width:1.5}
.g-node text{font-size:13px;fill:var(--ink-2)}
.g-node .g-id{font-variant-ligatures:none;font-family:var(--mono);font-size:12.5px;font-weight:500;fill:var(--ink)}
.g-node .g-path{font-variant-ligatures:none;font-family:var(--mono);font-size:12.5px;fill:var(--ink)}
.g-node .g-sub{font-size:11.5px;fill:var(--muted)}
.k-source rect{fill:var(--amber-wash);stroke:var(--amber)}
.k-file rect{fill:var(--gutter)}
.is-glob rect{stroke-dasharray:4 3;fill:var(--sheet)}
.g-node.t-broken rect{fill:var(--red-wash);stroke:var(--red);stroke-width:2.5}
.g-node.t-kept rect{stroke:var(--green);stroke-width:2}
.g-node.t-looks-broken rect{fill:var(--red-wash);stroke:var(--red);stroke-dasharray:5 3}
.g-node.t-looks-kept rect{stroke:var(--green);stroke-dasharray:5 3}
.g-node.t-unsure rect{stroke:var(--muted);stroke-dasharray:5 3}
a.g-node:hover rect,a.g-node:focus rect{stroke:var(--amber);stroke-width:3}
.g-edge{fill:none;stroke:var(--line-2);stroke-width:1.6}
.e-broken{stroke:var(--red);stroke-width:3}
.e-looks-broken{stroke:var(--red);stroke-width:2;stroke-dasharray:6 4}
.g-conflict{fill:none;stroke:var(--amber);stroke-width:2.5;stroke-dasharray:3 4}
.legend{list-style:none;padding:0;margin:12px 0 0;display:flex;flex-wrap:wrap;gap:8px 28px;color:var(--ink-2);font-size:.9rem}
.legend li{display:flex;align-items:center;gap:8px}
.legend-glob{fill:var(--sheet);stroke:var(--line-2);stroke-width:1.5;stroke-dasharray:4 3}

/* promises: one row per promise, policy on the left, code on the right, like a code review */
.cols-head{display:grid;grid-template-columns:11rem minmax(0,1fr) minmax(0,1.15fr);gap:0 28px;color:var(--muted);font-size:.9rem;padding:0 0 8px}
.promise{display:grid;grid-template-columns:11rem minmax(0,1fr) minmax(0,1.15fr);gap:0 28px;background:var(--sheet);border:1px solid var(--line);border-left:5px solid var(--line-2);border-radius:10px;margin-bottom:12px;overflow:hidden}
.promise.t-broken{border-left-color:var(--red)}
.promise.t-kept{border-left-color:var(--green)}
.promise.t-looks-broken{border-left:5px dashed var(--red)}
.promise.t-looks-kept{border-left:5px dashed var(--green)}
.promise.t-unsure{border-left:5px dashed var(--muted)}
.p-gutter{background:var(--gutter);padding:18px 16px;display:flex;flex-direction:column;gap:10px;align-items:flex-start}
.p-id{font-size:1rem;font-weight:500;color:var(--ink)}
.p-verdict .by{display:block;margin:6px 0 0}
.p-rules{display:flex;flex-wrap:wrap;gap:6px}
.p-rules code{font-size:.78rem;color:var(--ink-2)}
.p-policy{padding:18px 0;min-width:0}
.p-policy h3{font-size:1.18rem;line-height:1.35;font-weight:600;letter-spacing:-.01em;margin-bottom:12px;max-width:52ch}
.p-code{padding:18px 18px 18px 0;min-width:0;display:flex;flex-direction:column;gap:10px}
.quote{border-radius:6px;overflow:hidden;border:1px solid #fde68a}
.q-line{display:grid;grid-template-columns:3rem minmax(0,1fr);background:var(--amber-wash)}
.q-no{font-family:var(--mono);font-size:.8rem;color:var(--amber-ink);text-align:right;padding:9px 10px 9px 0;border-right:3px solid var(--amber)}
.quote blockquote{padding:8px 12px;font-size:.98rem;color:var(--ink);overflow-wrap:anywhere}
.quote figcaption{padding:5px 12px;background:var(--sheet);color:var(--amber-ink);font-size:.85rem;border-top:1px solid #fde68a;overflow-wrap:anywhere}
.code{border:1px solid var(--line);border-radius:6px;overflow:hidden}
.code figcaption{display:flex;gap:12px;flex-wrap:wrap;align-items:baseline;padding:6px 12px;background:var(--gutter);border-bottom:1px solid var(--line);font-size:.9rem}
.code figcaption code{color:var(--ink);font-weight:500;overflow-wrap:anywhere}
.code .at{color:var(--muted);font-size:.8rem}
.code pre{margin:0;padding:6px 0;overflow-x:auto;font-size:.84rem;line-height:1.6;background:var(--sheet)}
.c-row{display:grid;grid-template-columns:3rem max-content;min-width:100%}
.c-row.hot{background:var(--red-wash)}
.c-row.hot .c-no{color:var(--red-ink);border-right-color:var(--red)}
.c-no{color:var(--muted);text-align:right;padding-right:10px;border-right:2px solid var(--line);user-select:none}
.c-src{padding:0 14px;white-space:pre}
.c-more{display:block;padding:2px 14px 0 calc(3rem + 14px);color:var(--muted);font-family:var(--sans);font-size:.8rem}
.why{color:var(--ink-2);font-size:.93rem;max-width:72ch;overflow-wrap:anywhere}
.why-hot{color:var(--red-ink)}
.no-code{padding:14px 16px;border:1px dashed var(--line-2);border-radius:6px;background:var(--paper)}
.t-broken .no-code{border:1.5px solid var(--red);background:var(--red-wash)}

/* rules */
.rules-head,.rule{display:grid;grid-template-columns:minmax(11rem,.7fr) minmax(0,1.6fr) minmax(0,1.3fr) minmax(10rem,.9fr);gap:0 24px}
.rules-head{color:var(--muted);font-size:.9rem;padding:0 18px 8px}
.rule{background:var(--sheet);border:1px solid var(--line);border-radius:10px;padding:16px 18px;margin-bottom:10px;align-items:start}
.r-id{display:flex;flex-direction:column;gap:6px;align-items:flex-start}
.r-id code{font-weight:500}
.r-id a code{color:var(--muted);font-weight:400}
.r-how{margin-top:6px;color:var(--ink-2);font-size:.9rem;overflow-wrap:anywhere}
.r-how code{background:var(--gutter);padding:.05em .35em;border-radius:4px}
.proof{font-size:.9rem;color:var(--ink-2);display:flex;gap:8px;overflow-wrap:anywhere;min-width:0}
.proof .mark{font-weight:700;color:var(--red)}
.proof.ok .mark{color:var(--green)}
.r-out .why{margin-top:6px;font-size:.85rem}
.tag{font-size:.75rem;color:var(--amber-ink);background:var(--amber-wash);padding:.1em .45em;border-radius:4px}

/* contradictions */
.conflict{background:var(--sheet);border:1px solid var(--line);border-left:5px solid var(--amber);border-radius:10px;padding:18px;margin-bottom:12px}
.c-sides{display:grid;grid-template-columns:minmax(0,1fr) auto minmax(0,1fr);gap:18px;align-items:start}
.c-vs{align-self:center;font-weight:700;color:var(--amber-ink)}
.c-side>a code{font-weight:500}
.c-wording{font-weight:600;margin:6px 0 10px}
.c-example{margin-top:14px;font-size:1.02rem;max-width:90ch}
.c-example strong{font-family:var(--mono);font-size:.86em;margin-right:6px;color:var(--amber-ink)}
.conflict .muted{margin-top:6px}

.foot{padding-top:40px;padding-bottom:56px;display:grid;gap:8px;color:var(--ink-2)}

@media (max-width:1100px){
  .rules-head{display:none}
  .rule{grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:12px 20px}
}
@media (max-width:900px){
  .hero{grid-template-columns:minmax(0,1fr)}
  .cols-head{display:none}
  .promise{grid-template-columns:minmax(0,1fr);gap:0}
  .p-gutter{flex-direction:row;flex-wrap:wrap;align-items:center;gap:8px 14px;padding:12px 16px}
  .p-verdict .by{display:inline-block;margin:0 0 0 8px}
  .p-policy{padding:14px 16px 0}
  .p-code{padding:12px 16px 16px}
  .c-sides{grid-template-columns:minmax(0,1fr)}
  .c-vs{justify-self:start}
}
@media (max-width:600px){
  .rule{grid-template-columns:minmax(0,1fr)}
  .bar-nav{order:3;width:100%}
  .cell{width:24px;height:24px}
  .tally-n{font-size:1.5rem}
}
@media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}
@media print{.size,.bar-nav{display:none}.promise,.rule,.conflict{break-inside:avoid}}
`;
