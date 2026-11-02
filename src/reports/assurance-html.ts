import { verifyAssuranceChangeReport, type AssuranceChangeReport } from '../assurance/report.js';
import type { CheckFreshness, DependencyChange } from '../assurance/schemas.js';

function escape(value: unknown): string {
  return String(value).replace(
    /[&<>"']/g,
    (character) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[character]!,
  );
}

function badge(
  value: string,
  tone: 'neutral' | 'review' | 'observed' | 'failure' = 'neutral',
): string {
  return `<span class="badge ${tone}">${escape(value)}</span>`;
}

function list(values: readonly string[], empty: string): string {
  return values.length
    ? `<ul>${values.map((value) => `<li>${escape(value)}</li>`).join('')}</ul>`
    : `<p class="muted">${escape(empty)}</p>`;
}

function codeList(values: readonly string[], empty: string): string {
  return values.length
    ? `<div class="chips">${values.map((value) => `<code>${escape(value)}</code>`).join('')}</div>`
    : `<p class="muted">${escape(empty)}</p>`;
}

function historicalVerdict(verdict: CheckFreshness['historicalVerdict']): string {
  if (verdict === 'supported') return 'Supported in recorded workload';
  if (verdict === 'contradicted') return 'Contradicted in recorded workload';
  return 'Insufficient recorded evidence';
}

function validity(check: CheckFreshness): string {
  const labels = {
    'unchanged-recorded-dependencies': 'Recorded dependencies unchanged',
    stale: 'Historical applicability is stale',
    unknown: 'Applicability unresolved',
  };
  return badge(
    labels[check.validity],
    check.validity === 'unchanged-recorded-dependencies' ? 'neutral' : 'review',
  );
}

function action(value: CheckFreshness['requiredAction']): string {
  return {
    none: 'No mapped retest requested',
    retest: 'Run mapped checks',
    'profile-review': 'Review the control profile',
    'resolve-coverage': 'Resolve the discovery boundary',
  }[value];
}

function freshCheck(report: AssuranceChangeReport, check: CheckFreshness): string {
  const retest = report.retest;
  const observed = retest?.assessment.checks.find((candidate) => candidate.id === check.id);
  if (
    report.retestStatus !== 'completed' ||
    !retest ||
    !observed ||
    !retest.executedChecks.includes(check.id)
  )
    return '<span class="muted">No fresh observation for this check.</span>';
  return `${badge(observed.status, observed.status === 'PASS' ? 'observed' : observed.status === 'FAIL' ? 'failure' : 'review')}<p class="small">${escape(observed.reason)}</p>`;
}

function renderChecks(report: AssuranceChangeReport): string {
  return `<section id="findings">
    <div class="section-title"><span class="step">01</span><div><h2>Keep three facts separate</h2>
      <p class="muted">Historical findings stay intact. Dependency comparison never creates a current behavioral verdict. Fresh observations appear only when an actual retest exists.</p></div></div>
    <div class="table-wrap"><table><thead><tr>
      <th>Control check</th><th>Historical finding</th><th>Dependency applicability</th><th>Fresh retest evidence</th>
    </tr></thead><tbody>${report.investigation.checks
      .map(
        (check) => `<tr>
      <td><strong>${escape(check.id)}</strong><p class="small muted">${escape(action(check.requiredAction))}</p></td>
      <td>${badge(historicalVerdict(check.historicalVerdict))}</td>
      <td>${validity(check)}${list(check.reasons, 'No additional reason recorded.')}</td>
      <td>${freshCheck(report, check)}</td>
    </tr>`,
      )
      .join('')}</tbody></table></div>
  </section>`;
}

function dependencySnapshot(dependency: DependencyChange['before']): string {
  return dependency
    ? `<p class="small">${escape(dependency.kind)} · revision <code>${escape(dependency.revision)}</code></p><code class="fingerprint">${escape(dependency.fingerprint)}</code>`
    : '<span class="muted">Not present in this inventory.</span>';
}

function renderChanges(report: AssuranceChangeReport): string {
  const changes = report.investigation.changes;
  return `<section id="changes">
    <div class="section-title"><span class="step">02</span><div><h2>What changed in the declared system</h2>
      <p class="muted">These records explain why earlier evidence needs attention. A changed dependency does not itself establish unsafe behavior.</p></div></div>
    ${
      changes.length
        ? changes
            .map(
              (change) => `<article class="change">
      <div class="change-heading"><h3>${escape(change.dependencyId)}</h3>${badge(change.change.replaceAll('-', ' '))}${badge(change.disposition.replaceAll('-', ' '), change.disposition === 'out-of-declared-scope' ? 'neutral' : 'review')}</div>
      <p>${escape(change.reason)}</p>
      <div class="split"><div><div class="overline">Recorded baseline</div>${dependencySnapshot(change.before)}</div>
      <div><div class="overline">Candidate snapshot</div>${dependencySnapshot(change.after)}</div></div>
    </article>`,
            )
            .join('')
        : '<div class="notice">No dependency fingerprint, revision, kind or presence changes were recorded within this declared map. This does not establish current runtime behavior.</div>'
    }
  </section>`;
}

function renderPlan(report: AssuranceChangeReport): string {
  const investigation = report.investigation;
  const reviewChanges = investigation.changes.filter(
    (change) => change.disposition === 'profile-review',
  );
  const blockers = investigation.blockers
    .map(
      (blocker) =>
        `<article class="blocker">${badge(blocker.code.replaceAll('-', ' '), 'review')}<p>${escape(blocker.reason)}</p>${codeList(blocker.dependencyIds, 'This boundary affects the declared inventory as a whole.')}</article>`,
    )
    .join('');
  return `<section id="plan">
    <div class="section-title"><span class="step">03</span><div><h2>The next evidence work</h2>
      <p class="muted">The plan is the union of supported checks in the declared dependency mapping. It is not a globally minimal test suite or release approval.</p></div></div>
    <div class="split"><div><h3>Planned probes</h3>${codeList(investigation.retestPlan.checkIds, 'No automatic probe execution is requested by this comparison.')}
      <p class="small muted">Plan scope: ${escape(investigation.retestPlan.scope)}</p></div>
      <div><h3>Execution status</h3>${badge(report.retestStatus.replaceAll('-', ' '), report.retestStatus === 'blocked' || report.retestStatus === 'unsupported' ? 'review' : 'neutral')}
      <p>${investigation.retestPlan.blocked ? 'Automatic retesting is blocked by unresolved coverage or required profile review.' : 'The declared plan has no comparison-level blocker. This alone does not establish that a retest ran.'}</p></div></div>
    ${
      reviewChanges.length || investigation.retestPlan.profileReviewRequired
        ? `<div class="notice"><strong>Explicit profile review required</strong><p>A policy, instruction, tool-definition or authority change may alter what the control must establish. Repeating old probes cannot establish the new obligation.</p>${list(
            reviewChanges.map((change) => `${change.dependencyId}: ${change.reason}`),
            'The comparison requires profile review before automatic evidence reuse.',
          )}</div>`
        : ''
    }
    ${investigation.blockers.length ? `<h3>Blockers and unresolved boundaries</h3>${blockers}` : '<p class="small muted">No comparison blocker is recorded within the selected inventory. Unlisted environment behavior remains outside scope.</p>'}
  </section>`;
}

function renderRetest(report: AssuranceChangeReport): string {
  const retest = report.retest;
  if (!retest)
    return `<section id="retest"><h2>Fresh execution evidence</h2><p>No fresh retest is retained in this report. Historical findings have not been promoted to a new behavioral assessment.</p></section>`;
  const verdict = retest.assessment.verdict;
  const label =
    verdict === 'supported'
      ? 'Supported in this fresh workload'
      : verdict === 'contradicted'
        ? 'Contradicted in this fresh workload'
        : 'Insufficient fresh evidence';
  return `<section id="retest">
    <div class="section-title"><span class="step">04</span><div><h2>What the fresh workload established</h2>
      <p class="muted">The separate destination observer records effects independently of application responses. Findings remain scoped to the captured authored attempts.</p></div></div>
    ${badge(label, verdict === 'supported' ? 'observed' : verdict === 'contradicted' ? 'failure' : 'review')}
    <div class="split"><div><h3>Required by this retest</h3>${codeList(retest.requiredChecks, 'No required checks recorded.')}</div>
      <div><h3>Actually executed batch</h3>${codeList(retest.executedChecks, 'No executed checks recorded.')}</div></div>
    <p class="small muted">A supported adapter may execute a broader fixed batch than the mapped plan; the lists above retain that difference.</p>
    <div class="table-wrap"><table><thead><tr><th>Observed check</th><th>Result</th><th>Reason</th></tr></thead><tbody>${retest.assessment.checks.map((check) => `<tr><td><strong>${escape(check.id)}</strong></td><td>${badge(check.status, check.status === 'PASS' ? 'observed' : check.status === 'FAIL' ? 'failure' : 'review')}</td><td>${escape(check.reason)}</td></tr>`).join('')}</tbody></table></div>
    <details><summary>Capture identity and scope</summary><dl class="facts">
      <dt>Scope</dt><dd>${escape(retest.run.capture.scope)}</dd>
      <dt>Started</dt><dd>${escape(retest.run.startedAt)}</dd>
      <dt>Finished</dt><dd>${escape(retest.run.finishedAt)}</dd>
      <dt>Application source</dt><dd><code class="fingerprint">${escape(retest.run.sourceRevision)}</code></dd>
      <dt>Capture status</dt><dd>${escape(retest.run.capture.status)}</dd>
    </dl></details>
  </section>`;
}

function renderSources(report: AssuranceChangeReport): string {
  return `<section id="scope"><h2>Source boundaries and commitments</h2>
    <p class="muted">Fingerprints bind supplied snapshots. They do not authenticate an issuer, prove complete discovery or attest the currently deployed system.</p>
    <div class="split"><div><h3>Recorded baseline inventory</h3><p>Coverage: ${escape(report.checkpoint.inventory.coverage.status)} <span class="muted">(declared)</span></p>${list(report.checkpoint.inventory.coverage.frontier, 'No inventory frontier was declared.')}</div>
      <div><h3>Candidate inventory</h3><p>Coverage: ${escape(report.inventory.coverage.status)} <span class="muted">(declared)</span></p>${list(report.inventory.coverage.frontier, 'No inventory frontier was declared.')}</div></div>
    <details><summary>Inspect candidate dependency fingerprints</summary><div class="table-wrap"><table><thead><tr><th>Dependency</th><th>Kind / revision</th><th>Fingerprint</th></tr></thead><tbody>${report.inventory.dependencies.map((dependency) => `<tr><td>${escape(dependency.id)}</td><td>${escape(dependency.kind)}<br><code>${escape(dependency.revision)}</code></td><td><code class="fingerprint">${escape(dependency.fingerprint)}</code></td></tr>`).join('')}</tbody></table></div></details>
    <details><summary>Inspect declared control dependencies and exclusions</summary>${report.checkpoint.contract.checks.map((check) => `<h3>${escape(check.id)}</h3>${codeList(check.dependencyIds, 'No dependencies recorded.')}`).join('')}${
      report.checkpoint.contract.exclusions.length
        ? `<h3>Explicit document exclusions</h3>${list(
            report.checkpoint.contract.exclusions.map(
              (exclusion) => `${exclusion.dependencyId}: ${exclusion.reason}`,
            ),
            '',
          )}`
        : ''
    }</details>
    <h3>Limits of this report</h3>${list([...new Set([...report.investigation.limitations, ...report.limitations])], 'No additional limitations recorded.')}
    <details><summary>Integrity commitments</summary><dl class="facts">
      <dt>Baseline inventory</dt><dd><code class="fingerprint">${escape(report.investigation.baselineDigest)}</code></dd>
      <dt>Candidate inventory</dt><dd><code class="fingerprint">${escape(report.investigation.candidateDigest)}</code></dd>
      <dt>Control contract</dt><dd><code class="fingerprint">${escape(report.investigation.contractDigest)}</code></dd>
      <dt>Change investigation</dt><dd><code class="fingerprint">${escape(report.investigation.digest)}</code></dd>
      <dt>Supplied report</dt><dd><code class="fingerprint">${escape(report.digest)}</code></dd>
    </dl></details>
  </section>`;
}

const STYLES = `
:root { color-scheme: light; --ink: #17332d; --muted: #61746a; --line: #dce5dc; --cream: #f5f6ef; --green: #176347; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--cream); color: var(--ink); font: 15px/1.6 system-ui, -apple-system, sans-serif; }
header { padding: 46px max(24px, calc((100vw - 1160px) / 2)) 34px; background: #12372d; color: #f6fbef; }
.overline { font-size: 11px; font-weight: 750; letter-spacing: 1.5px; text-transform: uppercase; color: var(--muted); }
header .overline { color: #b3d9b9; }
h1 { max-width: 900px; margin: 15px 0; font-size: clamp(29px, 4vw, 46px); line-height: 1.12; letter-spacing: -1.4px; }
header p { max-width: 810px; color: #c9ddcb; margin: 18px 0 24px; }
nav { display: flex; flex-wrap: wrap; gap: 22px; }
nav a { color: #d5efcc; text-decoration: none; font-size: 13px; }
main { max-width: 1208px; margin: auto; padding: 26px 24px 54px; }
.metrics { display: grid; grid-template-columns: repeat(3, 1fr); gap: 14px; margin-bottom: 19px; }
.metric { padding: 19px 20px; background: #fff; border: 1px solid var(--line); border-radius: 12px; }
.metric strong { display: block; font-size: 25px; line-height: 1.3; letter-spacing: -.6px; }
.metric span { color: var(--muted); font-size: 12px; }
section { margin-bottom: 19px; padding: 27px; background: #fff; border: 1px solid var(--line); border-radius: 13px; }
.section-title { display: flex; align-items: flex-start; gap: 14px; margin-bottom: 13px; }
.step { flex-shrink: 0; margin-top: 3px; padding: 4px 7px; border: 1px solid #dce9d9; border-radius: 6px; color: var(--green); font-size: 11px; font-weight: 750; }
h2 { margin: 0 0 8px; font-size: 22px; line-height: 1.3; letter-spacing: -.5px; }
h3 { margin: 15px 0 7px; font-size: 14px; line-height: 1.5; overflow-wrap: anywhere; }
p { margin: 9px 0; }
.muted { color: var(--muted); }
.small { font-size: 12px; }
.table-wrap { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; text-align: left; font-size: 13px; }
th, td { padding: 14px 12px; border-bottom: 1px solid var(--line); vertical-align: top; }
th { color: var(--muted); font-size: 10px; font-weight: 750; letter-spacing: .8px; text-transform: uppercase; }
td:first-child { min-width: 130px; }
td ul { margin: 10px 0 0; padding-left: 15px; font-size: 12px; color: var(--muted); }
.badge { display: inline-block; border-radius: 5px; padding: 4px 8px; font-size: 10px; font-weight: 750; letter-spacing: .35px; line-height: 1.45; text-transform: uppercase; }
.neutral { color: #466052; background: #edf2eb; }
.review { color: #8b611f; background: #fff1cf; }
.observed { color: #146047; background: #e0f2e5; }
.failure { color: #923b3e; background: #fbe8e8; }
.split { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; }
.change { padding: 19px 0; border-top: 1px solid var(--line); }
.change-heading { display: flex; align-items: center; flex-wrap: wrap; gap: 9px; }
.change-heading h3 { margin: 0 8px 0 0; }
.change .overline { margin-top: 13px; }
.fingerprint { display: inline-block; max-width: 100%; overflow-wrap: anywhere; word-break: break-all; }
code { font: 11px/1.6 ui-monospace, SFMono-Regular, Consolas, monospace; }
.chips { display: flex; flex-wrap: wrap; gap: 7px; margin: 12px 0; }
.chips code { padding: 4px 8px; border: 1px solid var(--line); border-radius: 5px; background: #f5f8f2; overflow-wrap: anywhere; }
.notice { border-left: 3px solid #bf994d; border-radius: 0 7px 7px 0; padding: 14px 17px; background: #fffbf0; font-size: 13px; margin: 17px 0; }
.blocker { padding: 15px 0; border-top: 1px solid var(--line); }
.timeline { display: grid; grid-template-columns: repeat(3, 1fr); gap: 0; margin: 0 0 19px; padding: 0; list-style: none; background: #ecf0e5; border: 1px solid var(--line); border-radius: 12px; }
.timeline li { padding: 17px 21px; border-right: 1px solid var(--line); font-size: 12px; }
.timeline li:last-child { border-right: 0; }
.timeline strong { display: block; margin-bottom: 4px; }
details { margin: 13px 0 0; border-top: 1px solid var(--line); padding: 13px 0; }
summary { font-size: 13px; font-weight: 650; cursor: pointer; }
ul { padding-left: 20px; }
.facts { display: grid; grid-template-columns: minmax(130px, 1fr) 3fr; gap: 10px 16px; font-size: 12px; }
.facts dt { color: var(--muted); }
.facts dd { margin: 0; overflow-wrap: anywhere; }
footer { padding: 6px 3px; color: var(--muted); font-size: 12px; }
@media (max-width: 760px) {
  header { padding: 32px 23px 27px; }
  main { padding: 20px 16px 35px; }
  section { padding: 20px 17px; }
  .metrics, .split, .timeline { grid-template-columns: 1fr; }
  .timeline li { border-right: 0; border-bottom: 1px solid var(--line); }
  .timeline li:last-child { border-bottom: 0; }
  .facts { grid-template-columns: 1fr; gap: 3px; }
  .facts dd { margin-bottom: 9px; }
  th, td { padding: 12px 8px; }
}
`;

/** Escaped, self-contained and inert. Supplied consistency is verified before rendering. */
export function renderAssuranceHtml(input: AssuranceChangeReport): string {
  const report = verifyAssuranceChangeReport(input);
  const { investigation } = report;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
  <title>Change investigation · Praesidia Investigator</title>
  <style>${STYLES}</style>
</head>
<body>
  <header>
    <div class="overline">Praesidia Investigator · change investigation</div>
    <h1>Keep assurance tied to<br>the system that was tested.</h1>
    <p>${escape(investigation.scope.workflowRef)} · tenant ${escape(investigation.scope.tenantRef)}. Inspect which dependency changes affect recorded findings, what needs review, and which fresh observations were actually captured.</p>
    <nav><a href="#findings">Findings</a><a href="#changes">Dependency changes</a><a href="#plan">Evidence work</a><a href="#retest">Fresh observations</a><a href="#scope">Sources &amp; limits</a></nav>
  </header>
  <main>
    <div class="metrics">
      <div class="metric"><strong>${investigation.changes.length} changed dependencies</strong><span>Compared within a declared finite inventory</span></div>
      <div class="metric"><strong>${investigation.checks.length} recorded checks</strong><span>Historical verdicts retained separately</span></div>
      <div class="metric"><strong>${escape(report.retestStatus.replaceAll('-', ' '))}</strong><span>Fresh retest execution status</span></div>
    </div>
    <ol class="timeline" aria-label="Evidence timeline">
      <li><strong>Recorded baseline</strong><span>${escape(report.checkpoint.inventory.capturedAt)}</span></li>
      <li><strong>Candidate inventory</strong><span>${escape(report.inventory.capturedAt)}</span></li>
      <li><strong>Fresh workload</strong><span>${escape(report.retest?.run.finishedAt ?? 'No fresh execution retained')}</span></li>
    </ol>
    ${renderChecks(report)}
    ${renderChanges(report)}
    ${renderPlan(report)}
    ${renderRetest(report)}
    ${renderSources(report)}
    <footer>Standalone, supplied-record investigation. No production release authorization, issuer authenticity or whole-company completeness is established.</footer>
  </main>
</body>
</html>`;
}
