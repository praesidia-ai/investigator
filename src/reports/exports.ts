import { z } from 'zod';
import { caseReportSchema, verifyCaseReport, type CaseReport } from './case-report.js';

/** Structural interchange schema; semantic, citation and digest checks still require verification. */
export function caseReportJsonSchema() {
  return {
    ...z.toJSONSchema(caseReportSchema, { target: 'draft-2020-12', io: 'output' }),
    $id: 'urn:praesidia:investigator:case-report:v1',
    title: 'Investigator portable case report v1',
    description:
      'Structural schema only. Use verifyCaseReport to check digests, citations, scope bindings, check consistency and run status invariants. Supplied-manifest-only integrity does not establish independently trusted authorship.',
  };
}

function escapeXml(value: string): string {
  return value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\uFFFE\uFFFF\uD800-\uDFFF]/gu, '\uFFFD')
    .replace(/[&<>"']/g, (character) => {
      const entities: Record<string, string> = {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&apos;',
      };
      return entities[character]!;
    });
}

type Outcome = 'passed' | 'failure' | 'error' | 'skipped';
interface TestCase {
  name: string;
  group: string;
  outcome: Outcome;
  message: string;
}

function junitCases(report: CaseReport): TestCase[] {
  const required = new Set(report.controlCase.requiredChecks);
  const ids = [
    ...required,
    ...report.run.checks.map((check) => check.id).filter((id) => !required.has(id)),
  ];
  const cases: TestCase[] = ids.map((id) => {
    const check = report.run.checks.find((item) => item.id === id);
    switch (check?.status) {
      case 'PASS':
        return { name: id, group: 'control', outcome: 'passed', message: '' };
      case 'FAIL':
        return {
          name: id,
          group: 'control',
          outcome: 'failure',
          message: 'Observed behavior violates the declared control expectations.',
        };
      case 'ERROR':
        return {
          name: id,
          group: 'control',
          outcome: 'error',
          message:
            'The control check could not be executed reliably; prevention is not established.',
        };
      default:
        return {
          name: id,
          group: 'control',
          outcome: 'skipped',
          message: check
            ? 'The control check is incomplete.'
            : 'No required check result was recorded.',
        };
    }
  });
  cases.push({
    name: 'claim-verdict',
    group: 'assessment',
    outcome:
      report.run.finding?.verdict === 'supported'
        ? 'passed'
        : report.run.finding?.verdict === 'contradicted'
          ? 'failure'
          : 'skipped',
    message:
      report.run.finding?.verdict === 'contradicted'
        ? 'The frozen claim is contradicted within its declared scope.'
        : 'The claim remains unresolved; this is not a passing control.',
  });
  cases.push({
    name: 'investigation-execution',
    group: 'execution',
    outcome:
      report.run.status === 'completed'
        ? 'passed'
        : report.run.status === 'failed'
          ? 'error'
          : 'skipped',
    message:
      report.run.status === 'failed'
        ? 'The investigation failed to execute. See the original case report for the recorded error.'
        : 'The investigation is incomplete. No successful execution is asserted.',
  });
  return cases;
}

/** CI projection deliberately omits evidence, quotations, observations and provider error bodies. */
export function renderJUnit(input: CaseReport): string {
  const report = verifyCaseReport(input);
  const cases = junitCases(report);
  const count = (outcome: Outcome) => cases.filter((item) => item.outcome === outcome).length;
  const seconds =
    Math.max(0, Date.parse(report.run.finishedAt) - Date.parse(report.run.startedAt)) / 1000;
  const counts = `tests="${cases.length}" failures="${count('failure')}" errors="${count('error')}" skipped="${count('skipped')}" time="${seconds.toFixed(3)}"`;
  const testCases = cases
    .map((item) => {
      const opening = `<testcase classname="investigator.${item.group}" name="${escapeXml(item.name)}">`;
      if (item.outcome === 'passed') return `${opening}</testcase>`;
      const type = item.outcome === 'skipped' ? '' : ` type="investigator.${item.group}"`;
      return `${opening}<${item.outcome}${type} message="${escapeXml(item.message)}"/></testcase>`;
    })
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<testsuites ${counts}>
<testsuite name="Investigator declared control case" ${counts}>
<properties>
<property name="case-id" value="${escapeXml(report.controlCase.id)}"/>
<property name="scope" value="${escapeXml(report.controlCase.subject.environment)}"/>
<property name="report-digest" value="${escapeXml(report.integrity.digest)}"/>
<property name="provider-mode" value="${escapeXml(report.run.provider.mode)}"/>
<property name="integrity-trust" value="supplied-manifest-only"/>
<property name="human-acceptance" value="not-established"/>
<property name="projection" value="Statuses only; inspect the original case report for evidence and scope limits."/>
</properties>
${testCases}
</testsuite>
</testsuites>\n`;
}
