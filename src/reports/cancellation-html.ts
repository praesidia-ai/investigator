import { entityKey } from '../context/project.js';
import { assessCancellationExperiment } from '../cancellation/assessment.js';
import type { CancellationInvestigation } from '../cancellation/investigate.js';
import { verifyCancellationCase, type CancellationCase } from '../cancellation/report.js';
import type { CancellationCapture } from '../cancellation/schemas.js';
import type { Citation } from '../core/schemas.js';

type Tone = 'neutral' | 'observed' | 'review' | 'failure';
function escape(value: unknown): string {
  return String(value).replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!,
  );
}
function badge(value: string, tone: Tone = 'neutral'): string {
  return `<span class="badge ${tone}">${escape(value)}</span>`;
}
function verdict(value: string | null): string {
  const label =
    value === 'supported'
      ? 'Supported in captured workload'
      : value === 'contradicted'
        ? 'Contradicted by captured work'
        : value === 'insufficient_evidence'
          ? 'Insufficient captured evidence'
          : 'No after investigation';
  return badge(
    label,
    value === 'supported' ? 'observed' : value === 'contradicted' ? 'failure' : 'review',
  );
}
function list(values: readonly string[], empty: string): string {
  return values.length
    ? `<ul>${values.map((value) => `<li>${escape(value)}</li>`).join('')}</ul>`
    : `<p class="muted">${escape(empty)}</p>`;
}
function locator(citation: Citation): string {
  return citation.locator.kind === 'lines'
    ? `lines ${citation.locator.start}–${citation.locator.end}`
    : citation.locator.pointer || '(document)';
}
function sourceLink(citation: Citation, prefix: string): string {
  return `<a href="#${prefix}-evidence-${escape(citation.evidenceId)}">${escape(citation.evidenceId)} · ${escape(locator(citation))}</a>`;
}

function renderContext(report: CancellationCase): string {
  const context = report.before.context.context;
  const names = new Map(
    context.entities.map((entity) => [entityKey(entity.ref), entity.displayName]),
  );
  const rows = context.assertions
    .map(
      (assertion) => `<tr>
    <td>${escape(names.get(entityKey(assertion.subject)) ?? assertion.subject.nativeId)}</td>
    <td><code>${escape(assertion.relation)}</code></td>
    <td>${escape(assertion.object.kind === 'entity' ? (names.get(entityKey(assertion.object.ref)) ?? assertion.object.ref.nativeId) : assertion.object.value)}</td>
    <td>${escape(assertion.basis)} · ${escape(assertion.assessment)}<br>${assertion.citations.map((citation) => sourceLink(citation, 'before')).join('<br>')}</td>
  </tr>`,
    )
    .join('');
  return `<section id="context"><div class="section-title"><span class="step">01</span><div>
    <h2>The selected client workflow</h2><p class="muted">${escape(context.scope.workflowRef)} · tenant ${escape(context.scope.tenantRef)}. These relationships are supplied configuration with citations. Actual effects are observed separately.</p>
    </div></div><div class="components">${context.entities.map((entity) => `<span>${escape(entity.displayName)}<small>${escape(entity.ref.kind)}</small></span>`).join('')}</div>
    <div class="table-wrap"><table><thead><tr><th>From</th><th>Relationship</th><th>To</th><th>Basis and source</th></tr></thead><tbody>${rows}</tbody></table></div>
    <div class="notice"><strong>Discovery boundary</strong>${list([...context.sources.flatMap((source) => source.frontier), ...context.scope.excludedResources], 'No additional source boundary was declared.')}</div>
  </section>`;
}

function renderInvestigation(
  run: CancellationInvestigation,
  title: string,
  prefix: string,
): string {
  const summary = run.proposedFinding;
  const trace = run.events
    .map(
      (
        event,
      ) => `<tr><td>${event.sequence}</td><td><code>${escape(event.tool)}</code>${event.error ? `<p class="small">${escape(event.error.code)}</p>` : ''}</td>
    <td>${event.experimentId ? escape(event.experimentId) : event.citation ? sourceLink(event.citation, prefix) : 'Selected workflow/evidence metadata'}</td>
    <td><code class="fingerprint">${escape(event.argumentsDigest)}</code><br><code class="fingerprint">${escape(event.resultDigest)}</code></td></tr>`,
    )
    .join('');
  return `<article class="investigation"><div class="change-heading"><h3>${escape(title)}</h3>${badge(run.provider.mode === 'scripted' ? 'Scripted orchestration' : 'Live provider run')}${badge(run.status, run.status === 'completed' && run.validation.accepted ? 'observed' : 'review')}</div>
    <p class="small muted">${escape(run.provider.id)} · ${escape(run.provider.model)}</p>
    ${run.provider.mode === 'scripted' ? '<div class="notice">This run uses deterministic orchestration and actual synthetic HTTP effects. It does not establish live Meta reasoning.</div>' : '<p class="small muted">Provider mode is retained as recorded. Supplied report consistency does not independently authenticate a model provider.</p>'}
    ${summary ? `<div class="split"><div><div class="overline">Working hypothesis</div><p>${escape(summary.workingHypothesis)}</p></div><div><div class="overline">Alternative explanation</div><p>${escape(summary.alternativeExplanation)}</p></div></div>` : '<p class="muted">No model summary was produced.</p>'}
    <h3>Grounded finding</h3><p>${run.finding ? escape(run.finding.statement) : 'A grounded final finding is unavailable for this run.'}</p>
    ${run.validation.accepted ? '' : `<div class="notice"><strong>Finding validation requires attention</strong>${list(run.validation.issues, 'The finding has not been accepted.')}</div>`}
    ${summary?.missingEvidence.length ? `<h3>Requested missing evidence</h3>${list(summary.missingEvidence, '')}` : ''}
    ${run.error ? `<p class="small">Execution: <code>${escape(run.error.code)}</code> · ${escape(run.error.message)}</p>` : ''}
    ${run.finding?.citations.length ? `<details><summary>Exact citations behind the finding</summary>${run.finding.citations.map((citation) => `<div class="citation"><p>${sourceLink(citation, prefix)}</p><pre>${escape(citation.quote)}</pre></div>`).join('')}</details>` : ''}
    <details><summary>Actual tool order and retained commitments (${run.events.length})</summary><p class="small muted">Each row retains a tool-input digest and result digest. Private model continuation and credentials are excluded.</p>
    <div class="table-wrap"><table><thead><tr><th>Order</th><th>Tool</th><th>Observed selection</th><th>Input / result commitments</th></tr></thead><tbody>${trace}</tbody></table></div></details>
  </article>`;
}

interface TimelineEvent {
  sequence: number;
  label: string;
  detail: string;
  tone: Tone;
}
function timeline(capture: CancellationCapture, grounded: boolean): TimelineEvent[] {
  const result: TimelineEvent[] = [];
  const enqueued = new Set<string>();
  for (const attempt of capture.attempts) {
    const key = JSON.stringify([
      attempt.enqueueSequence,
      attempt.rootId,
      attempt.jobId,
      attempt.requestDigest,
    ]);
    if (!enqueued.has(key)) {
      result.push({
        sequence: attempt.enqueueSequence,
        label: 'Work enqueued',
        detail: `${attempt.rootId} · ${attempt.jobId}`,
        tone: 'neutral',
      });
      enqueued.add(key);
    }
    result.push({
      sequence: attempt.dispatchSequence,
      label: 'Dispatch attempted',
      detail: `${attempt.rootId} · ${attempt.attemptId}`,
      tone: 'neutral',
    });
  }
  if (capture.cut)
    result.push({
      sequence: capture.cut.ackSequence,
      label: 'Revocation acknowledged',
      detail: capture.cut.rootId,
      tone: 'review',
    });
  for (const effect of capture.effects) {
    const late =
      grounded &&
      !!capture.cut &&
      effect.rootId === capture.cut.rootId &&
      effect.acceptSequence > capture.cut.ackSequence;
    result.push({
      sequence: effect.acceptSequence,
      label: !grounded
        ? 'Recorded acceptance; correlation unresolved'
        : late
          ? 'Selected root accepted after revocation'
          : 'Destination acceptance observed',
      detail: `${effect.rootId} · ${effect.attemptId}`,
      tone: !grounded ? 'review' : late ? 'failure' : 'observed',
    });
  }
  return result.sort((a, b) => a.sequence - b.sequence);
}

function effectMeaning(
  capture: CancellationCapture,
  effect: CancellationCapture['effects'][number],
  grounded: boolean,
): string {
  if (!grounded) return badge('Acceptance awaiting correlation', 'review');
  if (!capture.cut) return badge('Revocation boundary unavailable', 'review');
  if (effect.rootId !== capture.cut.rootId)
    return badge(
      effect.rootId === 'root:independent' ? 'Independent work accepted' : 'Other root accepted',
      'observed',
    );
  if (effect.acceptSequence > capture.cut.ackSequence)
    return badge('Post-revocation acceptance', 'failure');
  if (effect.acceptSequence < capture.cut.ackSequence)
    return badge('Pre-revocation acceptance', 'observed');
  return badge('Sequence boundary inconsistent', 'review');
}

function renderCapture(capture: CancellationCapture, selected: boolean, open: boolean): string {
  const check = assessCancellationExperiment(capture);
  const grounded = check.status !== 'INCOMPLETE';
  const receipts = capture.effects
    .map(
      (effect) =>
        `<tr><td>${escape(effect.rootId)}<br><span class="small">${escape(effect.jobId)} · ${escape(effect.attemptId)}</span></td><td><strong>#${effect.acceptSequence}</strong></td><td>${effectMeaning(capture, effect, grounded)}</td><td><code class="fingerprint">${escape(effect.requestDigest)}</code></td></tr>`,
    )
    .join('');
  return `<details class="experiment"${open ? ' open' : ''}><summary><span>${escape(capture.experimentId)}</span>${badge(check.status, check.status === 'PASS' ? 'observed' : check.status === 'FAIL' ? 'failure' : 'review')}${badge(selected ? 'Model-selected experiment' : 'Host validation experiment')}</summary>
    <p>${escape(check.reason)}</p><p class="small muted">Run ${escape(capture.runId)} · capture ${escape(capture.observation.status)} · window ${capture.observation.windowClosed ? 'closed' : 'open'}</p>
    ${capture.cut ? `<div class="cut"><strong>Trusted acknowledgment: #${capture.cut.ackSequence}</strong><span>${escape(capture.cut.rootId)} · ${escape(capture.cut.observedAt)}</span></div>` : '<div class="notice"><strong>The trusted acknowledgment was not captured.</strong><p>A cancelled status does not supply a revocation boundary.</p></div>'}
    <div class="split"><div><h3>Supervisor event sequence</h3><ol class="event-timeline">${timeline(
      capture,
      grounded,
    )
      .map(
        (event) =>
          `<li class="${event.tone}"><span class="sequence">#${event.sequence}</span><div><strong>${escape(event.label)}</strong><span>${escape(event.detail)}</span></div></li>`,
      )
      .join('')}</ol></div>
    <div><h3>Worker status claims</h3>${capture.workerClaims.length ? `<ul>${capture.workerClaims.map((claim) => `<li><code>${escape(claim.rootId)}</code> · ${escape(claim.jobId)}: ${badge(claim.state)}</li>`).join('')}</ul>` : '<p class="muted">No worker status was saved.</p>'}<p class="small muted">Status claims are retained separately from the destination receipts.</p><h3>Capture limits</h3>${list(capture.observation.limitations, 'No additional capture limit was declared.')}</div></div>
    <h3>Independent destination receipts</h3>${capture.effects.length ? `<div class="table-wrap"><table><thead><tr><th>Qualified operation</th><th>Acceptance</th><th>Relation to revocation</th><th>Received request commitment</th></tr></thead><tbody>${receipts}</tbody></table></div>` : '<p class="muted">No destination acceptance is retained. The criterion result above also considers capture closure, the attempted operation and legitimate-work requirements.</p>'}
    <details><summary>Inspect exact captured metadata</summary><pre>${escape(JSON.stringify(capture, null, 2))}</pre></details>
  </details>`;
}

function renderCaptures(
  captures: readonly CancellationCapture[],
  run: CancellationInvestigation,
  title: string,
): string {
  const selected = new Set(run.captures.map((capture) => capture.experimentId));
  return `<h3 class="batch-title">${escape(title)}</h3>${captures.length ? captures.map((capture, index) => renderCapture(capture, selected.has(capture.experimentId), index === 0)).join('') : '<p class="muted">No experiment capture is retained.</p>'}`;
}

function observed(value: boolean, applicable = true): string {
  return !applicable
    ? 'No after investigation'
    : value
      ? 'Established in captured workload'
      : 'Not established';
}

function renderExecutionEvents(report: CancellationCase): string {
  const execution = report.execution;
  if (
    !execution.cancelled &&
    !execution.baselineErrors.length &&
    !execution.retestErrors.length &&
    !execution.repairError
  )
    return '';
  const experiments = (title: string, errors: typeof execution.baselineErrors): string =>
    errors.length
      ? `<h3>${escape(title)}</h3><ul>${errors.map((error) => `<li><code>${escape(error.experimentId)}</code> · <code>${escape(error.code)}</code>: ${escape(error.message)}</li>`).join('')}</ul>`
      : '';
  return `<div class="notice"><strong>Retained execution events</strong>
    ${execution.cancelled ? '<p>Execution was cancelled. Findings use only the observations retained in this case.</p>' : ''}
    <p class="small">Repair execution was ${execution.repairRequested ? 'requested' : 'not requested'}. An execution error does not establish that delegated work stopped.</p>
    ${experiments('Baseline collection errors', execution.baselineErrors)}
    ${experiments('Retest collection errors', execution.retestErrors)}
    ${execution.repairError ? `<h3>Repair execution error</h3><p><code>${escape(execution.repairError.code)}</code>: ${escape(execution.repairError.message)}</p>` : ''}
  </div>`;
}

function renderRepair(report: CancellationCase): string {
  const after = report.after !== null;
  return `<section id="repair"><div class="section-title"><span class="step">04</span><div><h2>The supported change and retest</h2><p class="muted">A repair needs a grounded failure, the exact source preimage and independently observed legitimate work.</p></div></div>
    <p>${badge(report.repair.status.replaceAll('-', ' '), report.verification.closedGap ? 'observed' : 'review')} ${escape(report.repair.reason)}</p>
    ${renderExecutionEvents(report)}
    <div class="table-wrap"><table><thead><tr><th>Verification</th><th>Recorded result</th></tr></thead><tbody>
      <tr><td>Baseline assessment</td><td>${verdict(report.verification.beforeVerdict)}</td></tr>
      <tr><td>After assessment</td><td>${verdict(report.verification.afterVerdict)}</td></tr>
      <tr><td>Identical attempted business workload</td><td>${observed(report.verification.unchangedWorkload, after)}</td></tr>
      <tr><td>Independent work before the change</td><td>${observed(report.verification.independentWorkBefore)}</td></tr>
      <tr><td>Independent work after the change</td><td>${observed(report.verification.independentWorkAfter, after)}</td></tr>
      <tr><td>Pre-revocation legitimate work preserved</td><td>${observed(report.verification.preCutWorkPreserved, after)}</td></tr>
      <tr><td>Observed control gap closed</td><td>${observed(report.verification.closedGap, after)}</td></tr>
      <tr><td>Synthetic raw content canary absent from exported case inputs</td><td>${report.verification.contentCanaryAbsent ? 'Yes' : 'No'}</td></tr>
    </tbody></table></div>
    ${report.change ? `<details><summary>Exact supported worker patch</summary><p><code>${escape(report.change.recipe)}</code> · ${escape(report.change.file)}</p><pre>${escape(report.change.diff)}</pre><p class="small muted">Before SHA-256 <code class="fingerprint">${escape(report.change.beforeDigest)}</code><br>After SHA-256 <code class="fingerprint">${escape(report.change.afterDigest)}</code></p></details>` : ''}
    ${report.after ? renderInvestigation(report.after, 'After-change investigation', 'after') + renderCaptures(report.retest, report.after, 'Fresh retest captures') : '<p class="muted">No after-change investigation is claimed in this case.</p>'}
  </section>`;
}

function renderSources(run: CancellationInvestigation, prefix: string, title: string): string {
  return `<h3>${escape(title)}</h3>${run.evidence.map((artifact) => `<details id="${prefix}-evidence-${escape(artifact.id)}"><summary>${escape(artifact.id)} · ${escape(artifact.coverage)} coverage</summary><p class="small">${escape(artifact.source.reference)} · captured ${escape(artifact.capturedAt)}</p><code class="fingerprint">SHA-256 ${escape(artifact.sha256)}</code><pre>${escape(artifact.content)}</pre></details>`).join('')}`;
}

const STYLES = `
:root { color-scheme: light; --ink: #17352e; --muted: #60756a; --line: #dce5dd; --paper: #f4f6ee; }
* { box-sizing: border-box; }
body { margin: 0; color: var(--ink); background: var(--paper); font: 15px/1.6 system-ui, -apple-system, sans-serif; }
header { padding: 45px max(24px, calc((100vw - 1160px) / 2)) 34px; background: #12372d; color: #f6fbef; }
.overline { color: var(--muted); font-size: 11px; font-weight: 750; text-transform: uppercase; letter-spacing: 1.6px; }
header .overline { color: #b6ddbf; }
h1 { max-width: 930px; margin: 15px 0; font-size: clamp(30px, 4vw, 47px); line-height: 1.12; letter-spacing: -1.4px; }
header p { max-width: 830px; color: #caddcd; }
nav { display: flex; flex-wrap: wrap; gap: 22px; margin-top: 25px; }
nav a { color: #d5efcc; font-size: 13px; text-decoration: none; }
main { max-width: 1208px; margin: auto; padding: 26px 24px 55px; }
.metrics { display: grid; grid-template-columns: repeat(3, 1fr); gap: 15px; margin-bottom: 20px; }
.metric { padding: 20px; border: 1px solid var(--line); border-radius: 12px; background: #fff; }
.metric strong { display: block; margin-bottom: 10px; font-size: 17px; letter-spacing: -.3px; }
.metric small { display: block; color: var(--muted); margin-top: 10px; font-size: 12px; }
section { padding: 27px; margin-bottom: 20px; border: 1px solid var(--line); border-radius: 13px; background: #fff; }
.section-title { display: flex; gap: 15px; align-items: flex-start; margin-bottom: 17px; }
.step { flex-shrink: 0; padding: 4px 7px; margin-top: 3px; border: 1px solid #dce9d9; border-radius: 6px; color: #176347; font-size: 11px; font-weight: 750; }
h2 { margin: 0 0 9px; font-size: 22px; line-height: 1.3; letter-spacing: -.5px; }
h3 { margin: 18px 0 8px; font-size: 15px; overflow-wrap: anywhere; }
p { margin: 10px 0; }
a { color: #176347; }
.muted { color: var(--muted); }
.small { font-size: 12px; }
.split { display: grid; grid-template-columns: 1fr 1fr; gap: 27px; }
.components { display: flex; flex-wrap: wrap; gap: 9px; margin: 18px 0; }
.components span { padding: 8px 12px; border: 1px solid var(--line); border-radius: 7px; background: #f4f8f0; font-size: 13px; }
.components small { display: block; color: var(--muted); font-size: 10px; }
.table-wrap { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; text-align: left; font-size: 13px; }
th, td { padding: 13px 11px; border-bottom: 1px solid var(--line); vertical-align: top; }
th { color: var(--muted); font-size: 10px; text-transform: uppercase; letter-spacing: .7px; }
.badge { display: inline-block; padding: 4px 8px; border-radius: 5px; font-size: 10px; font-weight: 750; line-height: 1.45; text-transform: uppercase; letter-spacing: .35px; }
.neutral { color: #496252; background: #edf2eb; }
.observed { color: #146047; background: #e0f2e5; }
.review { color: #8b611f; background: #fff1cf; }
.failure { color: #923b3e; background: #fbe8e8; }
.notice { padding: 14px 17px; margin: 17px 0; border-left: 3px solid #bf994d; border-radius: 0 7px 7px 0; background: #fffbf0; font-size: 13px; }
.notice ul { margin-bottom: 0; }
.change-heading { display: flex; flex-wrap: wrap; align-items: center; gap: 9px; margin: 15px 0; }
.change-heading h3 { margin: 0 8px 0 0; }
.investigation + .investigation { margin-top: 24px; }
.batch-title { margin-top: 27px; }
details { padding: 13px 0; margin-top: 11px; border-top: 1px solid var(--line); }
summary { cursor: pointer; font-size: 13px; font-weight: 650; }
summary .badge { margin-left: 8px; }
.experiment { padding: 17px; border: 1px solid var(--line); border-radius: 9px; background: #fcfdf9; }
.cut { display: flex; flex-wrap: wrap; gap: 12px; align-items: baseline; padding: 12px 14px; margin: 16px 0; border: 1px solid #ead7ad; border-radius: 7px; background: #fff8e5; font-size: 13px; }
.cut span { color: #86651e; font-size: 11px; }
.event-timeline { list-style: none; padding: 0; margin: 14px 0; }
.event-timeline li { display: flex; gap: 12px; align-items: flex-start; padding: 11px 12px; margin-bottom: 7px; border-radius: 7px; font-size: 12px; }
.event-timeline strong, .event-timeline div span { display: block; }
.event-timeline div span { font-size: 11px; margin-top: 3px; overflow-wrap: anywhere; }
.sequence { min-width: 28px; padding: 1px 5px; border: 1px solid currentColor; border-radius: 4px; font: 11px/1.6 ui-monospace, monospace; text-align: center; }
code { font: 11px/1.6 ui-monospace, SFMono-Regular, Consolas, monospace; }
.fingerprint { display: inline-block; max-width: 100%; overflow-wrap: anywhere; word-break: break-all; }
pre { padding: 15px; border: 1px solid #e4eadf; border-radius: 7px; background: #f3f6ef; font: 11px/1.65 ui-monospace, SFMono-Regular, Consolas, monospace; white-space: pre-wrap; overflow-wrap: anywhere; }
ul { padding-left: 19px; }
footer { padding: 6px 3px; color: var(--muted); font-size: 12px; }
@media(max-width: 760px) {
  header { padding: 32px 22px; }
  main { padding: 20px 15px 38px; }
  section { padding: 20px 17px; }
  .metrics, .split { grid-template-columns: 1fr; }
  th, td { padding: 11px 7px; }
  .experiment { padding: 13px; }
  summary .badge { margin: 7px 5px 0 0; }
}
`;

/** A self-contained escaped report. It never runs scripts, experiments or remote requests. */
export function renderCancellationHtml(input: CancellationCase): string {
  const report = verifyCancellationCase(input);
  const baseline = report.baseline;
  const knownLate = baseline.flatMap((capture) =>
    capture.cut && assessCancellationExperiment(capture).status === 'FAIL'
      ? capture.effects.filter(
          (effect) =>
            effect.rootId === capture.cut!.rootId &&
            effect.acceptSequence > capture.cut!.ackSequence,
        )
      : [],
  ).length;
  const missingCuts = baseline.filter((capture) => !capture.cut).length;
  const acknowledged = baseline.some((capture) => capture.cut !== null);
  return `<!doctype html>
<html lang="en"><head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
  <title>Delegated work revocation · Praesidia Investigator</title><style>${STYLES}</style>
</head><body><header>
  <div class="overline">Praesidia Investigator · independent workflow investigation</div>
  <h1>${acknowledged ? 'Cancellation acknowledged.<br>Did delegated work stop?' : 'Can revocation stop<br>delegated work?'}</h1>
  <p>A selected work root, a queued worker and an independent destination. Inspect the actual acknowledgment and acceptance boundary, the model-selected investigation and the supported retest.</p>
  <nav><a href="#context">Client context</a><a href="#investigation">Investigation</a><a href="#observations">Observed effects</a><a href="#repair">Repair &amp; retest</a><a href="#sources">Sources &amp; scope</a></nav>
</header><main>
  <div class="metrics"><div class="metric"><strong>Baseline control</strong>${verdict(report.verification.beforeVerdict)}<small>Finite authored workflow and registered destination</small></div>
    <div class="metric"><strong>${knownLate} post-cut acceptances observed</strong>${badge(missingCuts ? `${missingCuts} revocation boundaries unavailable` : 'Revocation boundaries retained', missingCuts ? 'review' : 'neutral')}<small>Only receipts with a captured matching boundary are counted.</small></div>
    <div class="metric"><strong>After the supported change</strong>${verdict(report.verification.afterVerdict)}<small>Historical findings and fresh observations remain distinct.</small></div></div>
  ${renderContext(report)}
  <section id="investigation"><div class="section-title"><span class="step">02</span><div><h2>How the investigation proceeded</h2><p class="muted">Hypothesis and alternative summaries are model-provided. Conclusive findings are constrained by exact citations, code-owned requirements and observed effects.</p></div></div>${renderInvestigation(report.before, 'Before-change investigation', 'before')}</section>
  <section id="observations"><div class="section-title"><span class="step">03</span><div><h2>What reached the destination</h2><p class="muted">Sequence numbers establish this supervisor's acknowledgment/acceptance ordering. Timestamps scope capture; they do not create a universal distributed clock.</p></div></div>${renderCaptures(report.baseline, report.before, 'Baseline observations')}</section>
  ${renderRepair(report)}
  <section id="sources"><h2>Saved sources and remaining limits</h2>${renderSources(report.before, 'before', 'Before-change sources and experiment records')}${report.after ? renderSources(report.after, 'after', 'After-change sources and experiment records') : ''}<h3>Scope</h3>${list(report.limitations, 'No additional limitation was supplied.')}<p class="small">Case commitment <code class="fingerprint">${escape(report.digest)}</code><br>Control profile commitment <code class="fingerprint">${escape(report.profileDigest)}</code></p></section>
  <footer>Supplied-record consistency is verifiable. Issuer authenticity, global idleness, rollback, production coverage and unobserved external paths are not established.</footer>
</main></body></html>`;
}
