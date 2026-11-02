import { entityKey } from '../context/project.js';
import { verifyEvidencePlanReport, type EvidencePlanReport } from '../evidence-plans/report.js';

function escape(value: unknown): string {
  return String(value).replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!,
  );
}
function badge(value: string): string {
  const status =
    value === 'supported' || value === 'PASS'
      ? 'good'
      : value === 'contradicted' || value === 'FAIL'
        ? 'bad'
        : 'pending';
  return `<span class="badge ${status}">${escape(value.replaceAll('_', ' '))}</span>`;
}

/** Inert, self-contained report. All client, source and model text is escaped. */
export function renderEvidencePlanHtml(report: EvidencePlanReport): string {
  report = verifyEvidencePlanReport(report);
  const context = report.context.context;
  const label = (ref: (typeof context.entities)[number]['ref']) =>
    context.entities.find((entity) => entityKey(entity.ref) === entityKey(ref))?.displayName ??
    ref.nativeId;
  const rows = [
    [
      'Safe implementation',
      report.assessments.safeBefore,
      report.assessments.safeAfter,
      report.validation.safeBehaviorPreserved,
    ],
    [
      'Unsafe implementation',
      report.assessments.unsafeBefore,
      report.assessments.unsafeAfter,
      report.validation.unsafeBehaviorPreserved,
    ],
  ] as const;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<title>Client understanding &amp; evidence plan · Investigator</title>
<style>
:root{color-scheme:light;--ink:#172b2a;--muted:#59706b;--line:#d8e3df;--green:#15664c;--paper:#f4f7f5}*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:15px/1.6 system-ui,-apple-system,sans-serif}header{background:#102e2a;color:#f5fbf7;padding:44px max(24px,calc((100vw - 1160px)/2)) 38px}.eyebrow{font-size:11px;font-weight:750;letter-spacing:2px;text-transform:uppercase;color:#9fe2c2}h1{font-size:clamp(28px,4vw,43px);line-height:1.15;letter-spacing:-1.2px;max-width:850px;margin:14px 0}header p{color:#c0d6ce;max-width:780px;margin:16px 0 22px}nav{display:flex;gap:20px;flex-wrap:wrap}a{color:var(--green)}nav a{color:#cef1df;text-decoration:none;font-size:13px}main{max-width:1208px;padding:30px 24px 60px;margin:auto}section{background:white;border:1px solid var(--line);border-radius:14px;padding:26px;margin-bottom:20px}h2{font-size:22px;margin:0 0 9px;letter-spacing:-.5px}h3{font-size:15px;margin:20px 0 7px}.muted{color:var(--muted)}.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-bottom:20px}.metric{background:white;border:1px solid var(--line);border-radius:12px;padding:18px}.metric strong{display:block;font-size:25px;letter-spacing:-.8px}.metric span{font-size:12px;color:var(--muted)}.badge{display:inline-block;padding:3px 9px;border-radius:6px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.4px;background:#e8f1ed}.good{color:#126244;background:#e4f6ec}.bad{color:#8d3034;background:#fcebed}.pending{color:#86601f;background:#fff3d7}.table{overflow:auto}table{border-collapse:collapse;width:100%;font-size:13px;text-align:left}th,td{padding:13px 12px;border-bottom:1px solid var(--line);vertical-align:top}th{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.5px}.flow{display:flex;flex-wrap:wrap;gap:9px;align-items:center;margin:16px 0}.node{border:1px solid var(--line);background:#f5f9f6;padding:8px 12px;border-radius:7px;font-size:13px}.callout{border-left:3px solid #bd943e;background:#fffaf0;padding:12px 16px;margin:16px 0;font-size:13px}.split{display:grid;grid-template-columns:1fr 1fr;gap:24px}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f1f6f3;border-radius:7px;padding:16px;font:12px/1.6 ui-monospace,monospace}code{font:12px ui-monospace,monospace;overflow-wrap:anywhere}details{border-top:1px solid var(--line);padding:13px 0}summary{cursor:pointer;font-weight:600;font-size:13px}ul{padding-left:20px}footer{color:var(--muted);font-size:12px;padding:8px 3px}@media(max-width:760px){.grid,.split{grid-template-columns:1fr}section{padding:18px}header{padding:30px 24px}th,td{padding:10px 7px}}
</style></head><body><header><div class="eyebrow">Praesidia Investigator · standalone</div><h1>Understand the workflow.<br>Make its control testable.</h1><p>Selected client context connects a policy, two agents and a custom service to a precise missing witness. A producer-only change is tested against safe and unsafe authorization.</p><nav><a href="#context">Client context</a><a href="#gap">Missing evidence</a><a href="#verification">Verification</a><a href="#sources">Sources &amp; limits</a></nav></header><main>
<div class="grid"><div class="metric"><strong>${context.entities.length} entities</strong><span>${context.sources.length} selected source · ${context.assertions.length} sourced assertions</span></div><div class="metric"><strong>${escape(report.planning.provider.mode === 'scripted' ? 'Offline demonstration' : 'Live model plan')}</strong><span>${escape(report.planning.provider.model)}</span></div><div class="metric"><strong>Evidence change</strong><span>Authorization unchanged · isolated authored workload</span></div></div>
<section id="context"><h2>The client's operating context</h2><p class="muted">${escape(context.scope.workflowRef)} · tenant ${escape(context.scope.tenantRef)}. Relationships below are supplied declarations/configuration; actual behavior is assessed separately.</p><div class="flow">${context.entities
    .filter((entity) => ['agent', 'tool', 'system', 'data-store'].includes(entity.ref.kind))
    .map(
      (entity) =>
        `<span class="node">${escape(entity.displayName)} <small>(${escape(entity.ref.kind)})</small></span>`,
    )
    .join(
      '',
    )}</div><div class="table"><table><thead><tr><th>Subject</th><th>Relationship</th><th>Object</th><th>Basis / assessment</th></tr></thead><tbody>${context.assertions.map((assertion) => `<tr><td>${escape(label(assertion.subject))}</td><td>${escape(assertion.relation)}</td><td>${escape(assertion.object.kind === 'entity' ? label(assertion.object.ref) : assertion.object.value)}</td><td>${escape(assertion.basis)} · ${escape(assertion.assessment)}<br>${assertion.citations.map((citation) => `<a href="#source-${escape(citation.evidenceId)}">${escape(citation.evidenceId)} · ${escape(citation.locator.kind === 'lines' ? `lines ${citation.locator.start}–${citation.locator.end}` : citation.locator.pointer)}</a>`).join(' · ')}</td></tr>`).join('')}</tbody></table></div><div class="callout"><strong>Discovery boundary</strong><br>${context.sources
    .flatMap((source) => source.frontier)
    .concat(context.scope.excludedResources)
    .map(escape)
    .join('<br>')}</div></section>
<section id="gap"><h2>Why the control was unassessable</h2>${report.assessments.safeBefore.gaps.map((gap) => `<p>${badge('insufficient_evidence')} ${escape(gap.reason)}</p><p class="muted">Missing: ${gap.missingFields.map(escape).join(', ')}</p>`).join('')}<div class="split"><div><h3>Proposed collection change</h3><p>${escape(report.planning.request.explanation)}</p><p><code>${escape(report.change.recipe)}</code></p><p class="muted">Only <code>instrumentation.mjs</code> changes. Business authorization source remains byte-for-byte identical.</p></div><div><h3>Declared collection boundary</h3><p>${report.change.collectedFields.map((field) => `<code>${escape(field)}</code>`).join(' · ')}</p><p class="muted">Excluded: ${report.change.excludedFields.map(escape).join(', ')}. Identifiers and commitments may still be sensitive.</p></div></div><details><summary>Inspect the exact producer patch</summary><pre>${escape(report.change.diff)}</pre></details></section>
<section id="verification"><h2>Evidence repair is separate from control repair</h2><p class="muted">The same instrumentation is tested with two operator-selected authorization configurations. Every run uses the same four declared attempts and a separate destination observer.</p><div class="table"><table><thead><tr><th>Configuration</th><th>Before capture change</th><th>After capture change</th><th>Business outcomes preserved</th></tr></thead><tbody>${rows.map(([name, before, after, preserved]) => `<tr><td>${escape(name)}</td><td>${badge(before.verdict)}</td><td>${badge(after.verdict)}</td><td>${preserved ? 'Yes' : 'No'}</td></tr>`).join('')}</tbody></table></div><h3>After-change observations</h3><div class="split">${rows.map(([name, , after]) => `<div><p><strong>${escape(name)}</strong></p>${after.checks.map((check) => `<p>${badge(check.status)} <strong>${escape(check.id)}</strong><br><span class="muted">${escape(check.reason)}</span></p>`).join('')}</div>`).join('')}</div><details><summary>${report.validation.witnessChecks.length} witness-removal checks</summary><p class="muted">Each check removes one declared witness field from the safe run. This tests the fixed schema and workload; it does not establish globally minimal telemetry.</p><table><thead><tr><th>Withheld field</th><th>Result</th></tr></thead><tbody>${report.validation.witnessChecks.map((check) => `<tr><td><code>${escape(check.field)}</code></td><td>${badge(check.verdictWithoutField)}</td></tr>`).join('')}</tbody></table></details><p>Raw synthetic content canary absent from saved evidence and emitted records: <strong>${report.validation.excludedCanaryAbsent ? 'Yes' : 'No'}</strong>.</p></section>
<section id="sources"><h2>Inspect the sources and remaining uncertainty</h2>${report.evidence.map((artifact) => `<details id="source-${escape(artifact.id)}"><summary>${escape(artifact.id)} · ${escape(artifact.source.reference)} · ${escape(artifact.coverage)} coverage</summary><p><code>SHA-256 ${escape(artifact.sha256)}</code></p><pre>${escape(artifact.content)}</pre></details>`).join('')}<h3>Remaining questions</h3><ul>${context.unresolvedQuestions.map((question) => `<li>${escape(question)}</li>`).join('')}</ul><h3>Scope</h3><ul>${report.limitations.map((limitation) => `<li>${escape(limitation)}</li>`).join('')}</ul></section><footer>Context commitment: <code>${escape(report.context.digest)}</code><br>Supplied report consistency is verifiable. Independent authorship and production completeness are not established.</footer></main></body></html>`;
}
