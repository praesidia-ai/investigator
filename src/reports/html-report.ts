import { verifyCaseReport, type CaseReport } from './case-report.js';

/** Source text is always rendered as text, including quotes, paths and JSON. */
function escapeHtml(value: string | number): string {
  return String(value).replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    };
    return entities[character]!;
  });
}

const CSS = `
:root{color-scheme:light;--ink:#172328;--muted:#526269;--paper:#f6f5f1;--card:#fff;--line:#d6dedc;--accent:#185b50;--fail:#8b3038;--warn:#805b12}
*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:var(--paper);color:var(--ink);font:16px/1.6 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}a{color:var(--accent);text-underline-offset:3px}a:focus-visible,summary:focus-visible{outline:3px solid #b47714;outline-offset:5px}.skip{position:absolute;left:1rem;top:-8rem;background:#fff;padding:.75rem;z-index:2}.skip:focus{top:1rem}.shell{max-width:1120px;margin:auto;padding:2.5rem 2rem 4rem}header{border-bottom:1px solid var(--line);padding-bottom:1.7rem}.eyebrow{text-transform:uppercase;letter-spacing:.14em;font-size:.73rem;font-weight:750;color:var(--accent)}h1{font-size:clamp(2rem,5vw,3.2rem);line-height:1.15;letter-spacing:-.035em;margin:.6rem 0 1rem}h2{font-size:1.3rem;line-height:1.35;letter-spacing:-.02em;margin:0 0 .8rem}h3{font-size:1rem;margin:.2rem 0 .7rem}p{margin:.5rem 0 1rem}.muted,small{color:var(--muted)}.claim{max-width:850px;font-size:1.13rem}.meta{display:flex;flex-wrap:wrap;gap:.5rem 1.4rem;font-size:.85rem;color:var(--muted)}nav{display:flex;flex-wrap:wrap;gap:.6rem 1.4rem;padding:1rem 0;border-bottom:1px solid var(--line);font-size:.9rem}main{display:grid;gap:1.4rem;padding-top:1.5rem}section{scroll-margin-top:1rem}.grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:1rem}.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:1.4rem;min-width:0}.label{display:block;color:var(--muted);font-size:.76rem;font-weight:650;text-transform:uppercase;letter-spacing:.06em;margin-bottom:.5rem}.value{display:block;font-size:1.28rem;font-weight:720;line-height:1.4}.badge{display:inline-block;border:1px solid currentColor;border-radius:5px;font-size:.72rem;line-height:1.4;font-weight:750;padding:.2rem .45rem;white-space:nowrap}.good{color:var(--accent)}.bad{color:var(--fail)}.uncertain{color:var(--warn)}.notice{background:#eaf1ee;border-left:3px solid var(--accent);padding:1rem 1.2rem;border-radius:0 8px 8px 0}.notice p:last-child,.card>p:last-child{margin-bottom:0}dl{display:grid;grid-template-columns:minmax(120px,.7fr) minmax(0,2fr);gap:.4rem 1rem;margin:.6rem 0}dt{color:var(--muted);font-size:.86rem}dd{margin:0;overflow-wrap:anywhere}code,.mono{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:.8rem;overflow-wrap:anywhere}.table-wrap{overflow-x:auto}table{border-collapse:collapse;width:100%;font-size:.9rem;text-align:left}caption{text-align:left;color:var(--muted);font-size:.85rem;margin-bottom:1rem}th{font-size:.75rem;text-transform:uppercase;letter-spacing:.04em;color:var(--muted)}td,th{padding:.85rem .6rem;border-bottom:1px solid var(--line);vertical-align:top}td:first-child,th:first-child{padding-left:0}td p{margin:.25rem 0}.check-kind{display:block;font-size:.75rem;color:var(--muted);margin-top:.2rem}.citation{border-top:1px solid var(--line);padding-top:1rem;margin-top:1rem}.citation:first-of-type{border-top:0;padding-top:0}blockquote{margin:.7rem 0;padding:.7rem 1rem;border-left:3px solid var(--line);background:var(--paper);white-space:pre-wrap;overflow-wrap:anywhere}.citation-meta{display:flex;flex-wrap:wrap;gap:.3rem 1rem;font-size:.82rem}details{border-top:1px solid var(--line);padding-top:.85rem;margin-top:.85rem}summary{cursor:pointer;font-weight:650;overflow-wrap:anywhere}summary::marker{color:var(--accent)}pre{white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word;font-size:.78rem;line-height:1.6;padding:1rem;background:var(--paper);border-radius:6px;max-height:32rem;overflow:auto}ul,ol{padding-left:1.3rem}.timeline li{padding:.35rem 0}.evidence-item{padding:.4rem 0 1rem;border-bottom:1px solid var(--line)}.evidence-item:last-child{border-bottom:0}.evidence-item:target{outline:2px solid var(--accent);outline-offset:8px}footer{margin-top:2rem;padding-top:1rem;border-top:1px solid var(--line);font-size:.8rem;color:var(--muted)}.break{overflow-wrap:anywhere}
@media(max-width:720px){.shell{padding:1.5rem 1rem 3rem}.grid{grid-template-columns:1fr}.card{padding:1.1rem}dl{grid-template-columns:1fr;gap:.15rem}dd{margin-bottom:.6rem}.table-wrap{margin-right:-.3rem}td,th{min-width:100px}td:last-child{min-width:210px}nav{gap:.6rem 1rem}}
@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}}
@media print{body{background:#fff}.shell{max-width:none;padding:0}.card{break-inside:avoid}.skip,nav{display:none}pre{max-height:none}.grid{grid-template-columns:repeat(3,minmax(0,1fr))}a{color:inherit}}
`;

function tone(status: string): string {
  if (status === 'PASS' || status === 'supported' || status === 'completed') return 'good';
  if (status === 'FAIL' || status === 'contradicted' || status === 'failed' || status === 'ERROR')
    return 'bad';
  return 'uncertain';
}

function verdictLabel(report: CaseReport): string {
  const verdict = report.run.finding?.verdict;
  return verdict === 'supported'
    ? 'Supported in declared scope'
    : verdict === 'contradicted'
      ? 'Contradicted in declared scope'
      : 'Insufficient evidence';
}

function checkRows(report: CaseReport): string {
  const required = new Set(report.controlCase.requiredChecks);
  const ids = [
    ...required,
    ...report.run.checks.map((check) => check.id).filter((id) => !required.has(id)),
  ];
  return ids
    .map((id) => {
      const check = report.run.checks.find((item) => item.id === id);
      const status = check?.status ?? 'INCOMPLETE';
      const kind =
        id === 'permitted-work'
          ? 'Positive control · permitted work'
          : id === 'independent-approval' || id === 'exact-request-binding'
            ? 'Negative control · prevent unauthorized effects'
            : 'Declared control check';
      return `<tr><th scope="row"><code>${escapeHtml(id)}</code><span class="check-kind">${escapeHtml(kind)}</span></th><td><span class="badge ${tone(status)}">${status}</span><span class="check-kind">${required.has(id) ? 'Required' : 'Additional'}</span></td><td>${escapeHtml(check?.summary ?? 'No result was recorded. This check cannot establish the control.')}<span class="check-kind">${check ? `${check.observations.length} recorded observations` : 'Not run'}</span></td></tr>`;
    })
    .join('');
}

/** Portable, inert HTML: no scripts, remote resources, forms or filesystem writes. */
export function renderCaseHtml(input: CaseReport): string {
  const report = verifyCaseReport(input);
  const { controlCase, run, integrity } = report;
  const artifactIndex = new Map(report.evidence.map((artifact, index) => [artifact.id, index]));
  const citations = run.finding?.citations ?? [];
  const citationHtml = citations.length
    ? citations
        .map((citation, index) => {
          const locator =
            citation.locator.kind === 'lines'
              ? `Lines ${citation.locator.start}–${citation.locator.end}`
              : `JSON pointer ${citation.locator.pointer || '(root)'}`;
          return `<article class="citation"><h3>Citation ${index + 1}</h3><div class="citation-meta"><a href="#evidence-${artifactIndex.get(citation.evidenceId)!}">${escapeHtml(citation.evidenceId)}</a><span>${escapeHtml(locator)}</span></div><blockquote>${escapeHtml(citation.quote)}</blockquote></article>`;
        })
        .join('')
    : '<p class="muted">No evidence citations were recorded. A conclusive finding requires a resolvable citation.</p>';
  const evidenceHtml = report.evidence
    .map(
      (artifact, index) =>
        `<article class="evidence-item" id="evidence-${index}"><h3>${escapeHtml(artifact.id)}</h3><dl><dt>Source</dt><dd>${escapeHtml(artifact.source.kind)} · ${escapeHtml(artifact.source.reference)}</dd><dt>Capture time (UTC)</dt><dd>${escapeHtml(artifact.capturedAt)}</dd><dt>Declared coverage</dt><dd>${escapeHtml(artifact.coverage)}${artifact.redacted ? ' · redacted' : ' · not declared redacted'}</dd><dt>Media / bytes</dt><dd>${escapeHtml(artifact.mediaType)} · ${artifact.byteLength}</dd><dt>SHA-256</dt><dd class="mono">${escapeHtml(artifact.sha256)}</dd></dl><details><summary>Inspect saved source text</summary><pre tabindex="0" aria-label="Saved evidence ${escapeHtml(artifact.id)}">${escapeHtml(artifact.content)}</pre></details></article>`,
    )
    .join('');
  const missing = run.finding?.missingEvidence ?? [];
  const eventHtml = run.events.length
    ? `<ol class="timeline">${run.events.map((event) => `<li><strong>${escapeHtml(event.role)}</strong> · ${escapeHtml(event.kind)}${event.tool ? ` · <code>${escapeHtml(event.tool)}</code>` : ''}</li>`).join('')}</ol>`
    : '<p class="muted">No investigation events were recorded.</p>';
  const scopeNote = controlCase.controlledTarget
    ? 'Controlled application test bound to the declared source revision; no deployment verified.'
    : controlCase.subject.environment === 'reference-test'
      ? 'Synthetic reference test. Results do not verify a client repository or deployed system.'
      : controlCase.subject.environment === 'repository'
        ? 'Repository evidence only. This snapshot does not establish deployed behavior.'
        : 'Declared deployment evidence only. This snapshot does not establish complete or current deployment coverage.';
  const modeNote =
    run.provider.mode === 'scripted'
      ? 'Scripted reference orchestration · no live model reasoning'
      : 'Live provider run · model outputs constrained by recorded evidence and checks';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src 'none'; connect-src 'none'; font-src 'none'; base-uri 'none'; form-action 'none'; object-src 'none'; frame-src 'none'"><meta name="referrer" content="no-referrer"><title>${escapeHtml(controlCase.id)} · Investigator case</title><style>${CSS}</style></head>
<body><a class="skip" href="#main">Skip to investigation</a><div class="shell"><header><span class="eyebrow">Praesidia Investigator / Portable case</span><h1>Evidence before assurance.</h1><p class="claim">${escapeHtml(controlCase.claim)}</p><div class="meta"><span>Case <strong class="break">${escapeHtml(controlCase.id)}</strong></span><span>Run <code>${escapeHtml(run.id)}</code></span><span>Finished <time datetime="${escapeHtml(run.finishedAt)}">${escapeHtml(run.finishedAt)} (UTC)</time></span></div></header>
<nav aria-label="Case sections"><a href="#finding">Finding</a><a href="#scope">Scope &amp; trust</a><a href="#checks">Control checks</a><a href="#citations">Citations</a><a href="#evidence">Saved evidence</a><a href="#limits">Limitations</a></nav>
<main id="main"><section id="finding" aria-labelledby="finding-title"><h2 id="finding-title">Investigation result</h2><div class="grid"><div class="card"><span class="label">Claim verdict</span><strong class="value ${tone(run.finding?.verdict ?? 'insufficient_evidence')}">${verdictLabel(report)}</strong><p class="muted">This is an assessment of the frozen claim.</p></div><div class="card"><span class="label">Execution status</span><strong class="value ${tone(run.status)}">${escapeHtml(run.status)}</strong><p class="muted">Completion describes the run, separately from whether the control holds.</p></div><div class="card"><span class="label">Human acceptance</span><strong class="value">Not established</strong><p class="muted">This package records an automated assessment; it contains no human acceptance decision.</p></div></div><div class="card" style="margin-top:1rem"><h3>Recorded assessment</h3><p>${escapeHtml(run.finding?.statement ?? 'No finding was recorded.')}</p>${run.error ? `<p class="bad"><strong>Execution issue · ${escapeHtml(run.error.code)}</strong><br>${escapeHtml(run.error.message)}</p>` : ''}${missing.length ? `<h3>Evidence still needed</h3><ul>${missing.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>` : ''}</div></section>
<section id="scope" aria-labelledby="scope-title" class="card"><h2 id="scope-title">Scope &amp; trust boundary</h2><div class="notice"><p><strong>${escapeHtml(scopeNote)}</strong></p><p>${escapeHtml(modeNote)}</p></div><dl><dt>Subject</dt><dd>${escapeHtml(controlCase.subject.id)}</dd><dt>Environment</dt><dd>${escapeHtml(controlCase.subject.environment)}</dd><dt>Revision</dt><dd>${escapeHtml(controlCase.subject.revision)}</dd><dt>Provider / model</dt><dd>${escapeHtml(run.provider.id)} / ${escapeHtml(run.provider.model)}</dd><dt>Started (UTC)</dt><dd>${escapeHtml(run.startedAt)}</dd>${controlCase.referenceTarget ? `<dt>Reference variant</dt><dd>${escapeHtml(controlCase.referenceTarget.variant)}</dd>` : ''}${controlCase.workContext ? `<dt>Work objective</dt><dd>${escapeHtml(controlCase.workContext.objective)}</dd><dt>Accountable party</dt><dd>${escapeHtml(controlCase.workContext.accountableParty)}</dd>${controlCase.workContext.parentWorkRef ? `<dt>Parent work reference</dt><dd>${escapeHtml(controlCase.workContext.parentWorkRef)}</dd>` : ''}` : ''}<dt>Package integrity</dt><dd>Matches its supplied SHA-256 manifest · <code>${escapeHtml(integrity.trust)}</code></dd><dt>Manifest digest</dt><dd class="mono">${escapeHtml(integrity.digest)}</dd></dl><p class="muted">A matching supplied digest checks internal consistency. It does not establish independently trusted authorship, evidence truth, legal compliance or human acceptance. A replaced report and replacement digest may still agree.</p><p class="muted">Historical snapshot: current source freshness has not been checked by this viewer. Declared coverage is recorded metadata, not independent proof of complete capture.</p></section>
<section id="checks" class="card" aria-labelledby="checks-title"><h2 id="checks-title">Control checks</h2><div class="table-wrap"><table><caption>Negative controls and permitted-work positive controls stay visible together. A refusal message or unavailable target cannot prove prevention.</caption><thead><tr><th scope="col">Check</th><th scope="col">Result</th><th scope="col">Recorded observation</th></tr></thead><tbody>${checkRows(report)}</tbody></table></div></section>
<section id="citations" class="card" aria-labelledby="citations-title"><h2 id="citations-title">Claim-to-evidence citations</h2><p class="muted">Exact saved quotations and locators, checked when this HTML was rendered. Open the linked artifact to inspect its retained source text.</p>${citationHtml}</section>
<section id="evidence" class="card" aria-labelledby="evidence-title"><h2 id="evidence-title">Saved evidence <small>(${report.evidence.length})</small></h2><p class="muted">Untrusted source material is shown as inert text. Content, URLs and instructions inside these artifacts do not receive authority.</p>${evidenceHtml}</section>
<section class="card" aria-labelledby="history-title"><h2 id="history-title">Investigation activity</h2><p class="muted">Recorded investigator and skeptic events. These entries record activity; they do not independently establish correctness.</p>${eventHtml}</section>
<section id="limits" class="card" aria-labelledby="limits-title"><h2 id="limits-title">Limitations</h2>${run.limitations.length ? `<ul>${run.limitations.map((limitation) => `<li>${escapeHtml(limitation)}</li>`).join('')}</ul>` : '<p class="muted">No additional limitations were recorded. The scope and trust boundaries above still apply.</p>'}<p class="muted">This static viewer has no scripts, external assets or network requests. Verification occurred during rendering; the HTML itself is not a signed evidence artifact. Keep the original JSON report for independent re-verification.</p></section></main>
<footer>Investigator case report · investigator-case-v1 · self-contained snapshot</footer></div></body></html>\n`;
}
