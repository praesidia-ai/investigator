// SARIF 2.1.0 export of one CheckRun. Rule-level BROKEN is the only error. Advisory AI reads are 'note' and labelled.
// Model text is never evidence: messages come from the program (rule messages, policy quote, wording), never `explanation`.
import { BRAND } from '../brand.js';
import type { CheckResult, CheckRun } from '../contracts.js';

export const SARIF_SCHEMA = 'https://json.schemastore.org/sarif-2.1.0.json';

interface SarifLocation {
  physicalLocation: {
    artifactLocation: { uri: string };
    region: { startLine: number; endLine: number; snippet: { text: string } };
  };
}
export interface SarifResult {
  ruleId: string;
  level: 'error' | 'note';
  message: { text: string };
  locations: SarifLocation[];
  relatedLocations?: SarifLocation[];
  properties: Record<string, unknown>;
}
export interface SarifLog {
  $schema: string;
  version: '2.1.0';
  runs: {
    tool: { driver: { name: string; version: string; rules: { id: string; shortDescription: { text: string } }[] } };
    results: SarifResult[];
    properties: Record<string, unknown>;
  }[];
}

const uri = (path: string) =>
  path.split('\\').join('/').replace(/^\/+/u, '').split('/').map(encodeURIComponent).join('/');
const locationsOf = (cites: CheckResult['citations']): SarifLocation[] =>
  cites.map((c) => ({
    physicalLocation: {
      artifactLocation: { uri: uri(c.path) },
      region: { startLine: c.startLine, endLine: c.endLine, snippet: { text: c.quote } },
    },
  }));

function base(run: CheckRun, r: CheckResult): Record<string, unknown> {
  return {
    promiseId: r.promiseId,
    level: r.level,
    verdict: r.verdict,
    commit: run.snapshot.commit,
    policyQuote: r.policyQuote,
    ...(r.assurance ? { detectorScope: r.assurance.coverage, openCounterexamples: r.assurance.openCounterexamples, ...(r.assurance.warning ? { detectorWarning: r.assurance.warning } : {}) } : {}),
    ...(r.ruleResults ? { rules: r.ruleResults.map((x) => ({ ruleId: x.ruleId, outcome: x.outcome, coverageGaps: x.coverageGaps ?? [] })) } : {}),
  };
}

/** Pure: same run in, same log out. Results that are neither rule-broken nor advisory looks-broken are not alerts. */
export function runToSarif(run: CheckRun): SarifLog {
  const results: SarifResult[] = [];
  const noLocation: { promiseId: string; verdict: string; level: string; reason: string }[] = [];
  const ruleIds = new Map<string, string>();
  for (const r of run.results) {
    const ruleBroken = r.level === 'rule' && r.verdict === 'broken';
    const advisory = r.level === 'ai-read' && r.verdict === 'looks-broken';
    if (!ruleBroken && !advisory) continue;
    // Only head-commit citations are lines of this PR; base-side lines would annotate the wrong code.
    const head = r.citations.filter((c) => c.commit === run.snapshot.commit);
    const other = r.citations.filter((c) => c.commit !== run.snapshot.commit);
    if (!head.length) {
      noLocation.push({ promiseId: r.promiseId, verdict: r.verdict, level: r.level, reason: 'no citation at the head commit' });
      continue;
    }
    ruleIds.set(r.promiseId, r.wording);
    results.push({
      ruleId: r.promiseId,
      level: ruleBroken ? 'error' : 'note',
      message: {
        text: ruleBroken
          ? `Broken by a rule (no AI): ${r.wording}`
          : `Advisory AI read, not verified: looks broken: ${r.wording}`,
      },
      locations: locationsOf(head),
      ...(other.length ? { relatedLocations: locationsOf(other) } : {}),
      properties: {
        ...base(run, r),
        scope: ruleBroken ? 'rule-level' : 'advisory-ai-read',
        independentlyVerified: false,
      },
    });
  }
  const notEvaluated = run.results.filter((r) => r.verdict === 'cant-tell' || r.verdict === 'not-checked').map((r) => ({ promiseId: r.promiseId, verdict: r.verdict, level: r.level }));
  return {
    $schema: SARIF_SCHEMA,
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: BRAND.name,
            version: run.toolVersion,
            rules: [...ruleIds].map(([id, text]) => ({ id, shortDescription: { text } })),
          },
        },
        results,
        properties: {
          runId: run.id,
          commit: run.snapshot.commit,
          dirty: run.snapshot.dirty,
          ...(run.snapshot.dirty ? { reproducible: false, label: 'dirty working tree: not reproducible' } : {}),
          runStatus: run.status,
          target: run.target,
          scope: 'Rule-level and advisory code findings only. Runtime/behavioral promises are not evaluated here.',
          notEvaluated: [...notEvaluated, ...noLocation],
        },
      },
    ],
  };
}
