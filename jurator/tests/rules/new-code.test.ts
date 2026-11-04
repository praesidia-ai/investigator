// WP-I (integrator): an each-near rule must also catch a NEW unguarded line, and a live rejection gets one retry.
import { describe, expect, it } from 'vitest';
import type { ModelClient, ModelJsonRequest } from '../../src/contracts.js';
import { proposeRule } from '../../src/rules/index.js';
import { COMMIT, promise } from './helpers.js';

const NOW = new Date('2026-11-04T04:00:00.000Z');
const files = [
  {
    path: 'src/routes/export.ts',
    text: "router.get('/export', async (req, res) => {\n  requireAdmin(req);\n  res.send('x');\n});\n",
  },
];
const p = promise('security.01', 'Only workspace admins can export customer data.', ['src/routes/**']);
const base = {
  feasible: true,
  reason: 'every export route checks the admin',
  mode: 'each-near',
  pattern: 'requireAdmin\\(',
  flags: null,
  within: 3,
  globs: ['src/routes/**'],
  description: 'Every export route calls requireAdmin( within 3 lines.',
  violationExamples: ["router.get('/export.csv', async (req, res) => {"],
  keptExamples: [],
};
const narrow = { ...base, anchor: "router\\.get\\('/export'" };
const wide = { ...base, anchor: "router\\.(?:get|post)\\(\\s*['\"]/export" };

function liveModel(answers: unknown[], inputs: string[]): ModelClient {
  let i = 0;
  return {
    id: 'fake-live',
    mode: 'live',
    async json<T>(req: ModelJsonRequest<T>) {
      inputs.push(req.input);
      const value = answers[Math.min(i++, answers.length - 1)];
      return { value: value as T, usage: { id: 'fake-live', mode: 'live', inputTokens: 10, outputTokens: 5, usd: 0.01 } };
    },
  };
}

describe('each-near rules catch new code', () => {
  it('rejects an anchor tied to the exact line today, and retries once with the reason', async () => {
    const inputs: string[] = [];
    const res = await proposeRule(p, files, COMMIT, liveModel([narrow, wide], inputs), NOW);
    expect(res.ok).toBe(true);
    expect(inputs).toHaveLength(2);
    expect(inputs[1]).toContain('the anchor misses new code');
    expect(res.usage?.usd).toBeCloseTo(0.02);
    if (res.ok) expect(res.rule.provenBy?.mutation).toContain("also failed on a new unguarded line `router.get('/export.csv'");
  });
  it('gives up after one retry', async () => {
    const res = await proposeRule(p, files, COMMIT, liveModel([narrow], []), NOW);
    expect(res).toMatchObject({ ok: false, reason: expect.stringContaining('(after one retry)') });
  });
});
