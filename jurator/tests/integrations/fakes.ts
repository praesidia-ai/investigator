// Fakes for the hook tests: a CheckRun built by hand and an in-memory git.
import { checkRunSchema, type CheckResult, type CheckRun } from '../../src/contracts.js';
import type { HookGit } from '../../src/integrations/index.js';

export const SHA_MAIN = 'a'.repeat(40);
export const SHA_BASE = 'b'.repeat(40);
export const SHA_FEATURE = 'c'.repeat(40);
export const SHA_REMOTE = 'd'.repeat(40);
export const ZERO = '0'.repeat(40);

const policySha = 'e'.repeat(64);

export function brokenSecurityResult(): CheckResult {
  return {
    promiseId: 'security.01',
    wording: 'Only workspace admins can export customer data.',
    verdict: 'broken',
    level: 'rule',
    citations: [
      {
        path: 'src/routes/export.ts',
        commit: SHA_FEATURE,
        startLine: 17,
        endLine: 17,
        quote: "router.get('/export.csv', async (req, res) => {",
      },
    ],
    policyQuote: { alias: 'security', policySha256: policySha, text: 'Only workspace admins can export customer data.', line: 3 },
    ruleResults: [
      {
        ruleId: 'R-security.01-1',
        promiseId: 'security.01',
        outcome: 'fail',
        hits: [],
        message: 'src/routes/export.ts:17 defines a route with no requireAdmin( within 3 lines',
      },
    ],
    explanation: 'src/routes/export.ts:17 defines a route with no requireAdmin( within 3 lines',
  };
}

export function holdsResult(): CheckResult {
  return {
    promiseId: 'privacy.01',
    wording: 'Support chats are deleted after 30 days.',
    verdict: 'holds',
    level: 'rule',
    citations: [],
    policyQuote: { alias: 'privacy', policySha256: policySha, text: 'Support chats are deleted after 30 days.', line: 5 },
  };
}

export function fakeRun(results: CheckResult[], failMode: CheckRun['failMode'] = 'block'): CheckRun {
  const broken = results.filter((r) => r.verdict === 'broken').length;
  return checkRunSchema.parse({
    schemaVersion: 1,
    id: 'run-test',
    toolVersion: '0.1.0',
    createdAt: '2026-11-04T05:00:00.000Z',
    snapshot: { repo: 'acme-notes', branch: 'feature/csv-export', commit: SHA_FEATURE, dirty: false },
    target: { kind: 'diff', base: SHA_BASE, head: SHA_FEATURE, changedFiles: ['src/routes/export.ts'] },
    failMode,
    status: 'completed',
    results,
    checklist: [],
    summary: {
      promises: results.length,
      checked: results.length,
      holds: results.length - broken,
      broken,
      looksKept: 0,
      looksBroken: 0,
      cantTell: 0,
      notChecked: 0,
      coveredByRules: results.length,
      codePromises: results.length,
    },
    costUsd: 0,
    digest: 'f'.repeat(64),
  });
}

/** refs: name -> sha (shas resolve to themselves when listed in `objects`); bases: "a|b" -> merge-base. */
export function fakeGit(refs: Record<string, string>, bases: Record<string, string>, objects: string[] = []): HookGit {
  return {
    async resolveCommit(ref) {
      if (refs[ref]) return refs[ref] as string;
      return objects.includes(ref) ? ref : null;
    },
    async mergeBase(a, b) {
      return bases[`${a}|${b}`] ?? bases[`${b}|${a}`] ?? null;
    },
  };
}
