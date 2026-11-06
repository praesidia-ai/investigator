import { describe, expect, it } from 'vitest';
import { caseReuse, compareAssurance } from '../src/assurance/compare.js';
import type { AssuranceContract } from '../src/assurance/schemas.js';
import { runCollectors, toAssuranceInventory, type Collector } from '../src/context/collector.js';
import { importOtelTraces, OTEL_GENAI_PINNED_SCHEMA } from '../src/context/import-otel.js';
import { jsonDigest } from '../src/core/json.js';

const str = (stringValue: string) => ({ stringValue });
function otel(service: string, version: string, tool: string): Collector {
  const content = JSON.stringify({
    resourceSpans: [
      {
        resource: {
          attributes: [
            { key: 'service.name', value: str(service) },
            { key: 'service.version', value: str(version) },
          ],
        },
        scopeSpans: [
          {
            spans: [
              {
                traceId: 't',
                spanId: `s-${service}`,
                startTimeUnixNano: '1793534400000000000',
                attributes: [
                  { key: 'gen_ai.operation.name', value: str('execute_tool') },
                  { key: 'gen_ai.tool.name', value: str(tool) },
                ],
              },
            ],
          },
        ],
      },
    ],
  });
  return {
    id: `otel-${service}`,
    collect: async () =>
      importOtelTraces({
        sourceId: `src-${service}`,
        tenant: 'a',
        schemaVersion: OTEL_GENAI_PINNED_SCHEMA,
        window: { from: '2026-11-01T00:00:00.000Z', to: '2026-12-01T00:00:00.000Z' },
        coverage: { droppedSpans: 0, captureClosed: true },
        content,
        capturedAt: '2026-11-05T00:00:00.000Z',
      }),
  };
}
const scope = { tenantRef: 'a', workflowRef: 'export' };
const dep = (service: string) => `otel-deploy:${jsonDigest([`src-${service}`, 'a', service])}`;
const contract: AssuranceContract = {
  schemaVersion: 1,
  profileId: 'p',
  requirementsDigest: jsonDigest('r'),
  verifierVersion: 'v',
  scope,
  checks: [
    {
      id: 'export-case',
      historicalVerdict: 'supported',
      dependencyIds: [dep('exporter')],
      retestChecks: ['export-case'],
    },
    {
      id: 'billing-case',
      historicalVerdict: 'supported',
      dependencyIds: [dep('billing')],
      retestChecks: ['billing-case'],
    },
  ],
  exclusions: [],
};
const inv = async (exporterVersion: string, at: string, complete = true) =>
  toAssuranceInventory(
    await runCollectors([
      otel('exporter', exporterVersion, 'export'),
      otel('billing', '1', 'charge'),
    ]),
    { scope, capturedAt: at, operatorDeclaresComplete: complete },
  );

describe('imported dependency invalidation', () => {
  it('a new deployment revision needs a new test only for the affected case', async () => {
    const result = compareAssurance({
      baseline: await inv('1', '2026-11-05T00:00:00.000Z'),
      candidate: await inv('2', '2026-11-05T01:00:00.000Z'),
      contract,
    });
    expect(caseReuse(result)).toEqual({
      'export-case': 'needs-new-test',
      'billing-case': 'reusable',
    });
    expect(result.retestPlan.checkIds).toEqual(['export-case']);
  });

  it('unchanged imports are reusable; incomplete collection is never reusable', async () => {
    const base = await inv('1', '2026-11-05T00:00:00.000Z');
    expect(
      caseReuse(
        compareAssurance({
          baseline: base,
          candidate: await inv('1', '2026-11-05T01:00:00.000Z'),
          contract,
        }),
      ),
    ).toEqual({ 'export-case': 'reusable', 'billing-case': 'reusable' });
    const partial = await inv('1', '2026-11-05T01:00:00.000Z', false);
    expect(partial.coverage.status).toBe('partial');
    expect(
      Object.values(caseReuse(compareAssurance({ baseline: base, candidate: partial, contract }))),
    ).toEqual(['unresolved', 'unresolved']);
  });
});
