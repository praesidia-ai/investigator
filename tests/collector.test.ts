import { mkdtemp, writeFile, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  apiExportCollector,
  mcpExportCollector,
  runCollectors,
  validateCollection,
  type Collector,
} from '../src/context/collector.js';

const window = { from: '2026-11-01T00:00:00.000Z', to: '2026-11-02T00:00:00.000Z' };
async function apiFile(value: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'collector-'));
  const file = join(dir, 'api.json');
  await writeFile(file, JSON.stringify(value));
  return file;
}
const listing = {
  schemaVersion: 1,
  entities: [
    {
      kind: 'agent',
      nativeId: 'support',
      name: 'support',
      revision: 'r1',
      extra: 'kept',
      relationships: [
        { relation: 'USES', toKind: 'tool', toNativeId: 'export', basis: 'declared' },
      ],
    },
    { kind: 'tool', nativeId: 'export', name: 'export', revision: 'r1' },
  ],
};

describe('collectors', () => {
  it('api export is inventory with exact citations and no observed claims', async () => {
    const result = validateCollection(
      await apiExportCollector({
        file: await apiFile(listing),
        sourceId: 'api-a',
        tenant: 'a',
        window,
      }).collect(),
    );
    expect(result.entities).toHaveLength(2);
    expect(result.operations).toEqual([]);
    expect(result.assertions[0]).toMatchObject({ basis: 'declared' });
    expect(result.frontier.some((f) => /not execution authority/.test(f.detail))).toBe(true);
  });

  it('rejects an api relationship claiming observed basis', async () => {
    const bad = structuredClone(listing);
    (bad.entities[0] as any).relationships[0].basis = 'observed';
    await expect(
      apiExportCollector({
        file: await apiFile(bad),
        sourceId: 'api-a',
        tenant: 'a',
        window,
      }).collect(),
    ).rejects.toMatchObject({ code: 'INVALID_API_EXPORT' });
  });

  it('same-named entities in different tenants stay distinct', async () => {
    const a = apiExportCollector({
      file: await apiFile(listing),
      sourceId: 'api-a',
      tenant: 'tenant-a',
      window,
    });
    const b = apiExportCollector({
      file: await apiFile(listing),
      sourceId: 'api-b',
      tenant: 'tenant-b',
      window,
    });
    const merged = await runCollectors([a, b]);
    expect(merged.entities.filter((e) => e.ref.nativeId === 'support')).toHaveLength(2);
    expect(merged.authority).toBe('inventory-only');
  });

  it('a nextCursor becomes missing-page frontier and partial coverage', async () => {
    const merged = await runCollectors([
      apiExportCollector({
        file: await apiFile({ ...listing, nextCursor: 'p2' }),
        sourceId: 'api-a',
        tenant: 'a',
        window,
      }),
    ]);
    expect(merged.frontier.some((f) => f.kind === 'missing-page')).toBe(true);
    expect(merged.coverage).toBe('partial');
  });

  it('a failing collector is visible frontier, not silence', async () => {
    const broken: Collector = {
      id: 'broken',
      collect: () => Promise.reject(new Error('secret /path')),
    };
    const merged = await runCollectors([broken]);
    expect(merged.coverage).toBe('unknown');
    expect(merged.frontier[0]).toMatchObject({ kind: 'collector-failed' });
    expect(JSON.stringify(merged)).not.toContain('secret');
  });

  it('duplicate ids across collectors are refused', async () => {
    const file = await apiFile(listing);
    const one = apiExportCollector({ file, sourceId: 'api-a', tenant: 'a', window });
    await expect(runCollectors([one, one])).rejects.toMatchObject({ code: 'COLLECTION_CONFLICT' });
  });

  it('saved MCP export collects tools as configured inventory', async () => {
    const merged = await runCollectors([
      mcpExportCollector(resolve(import.meta.dirname, '../examples/mcp-export')),
    ]);
    expect(merged.entities.length).toBeGreaterThan(1);
    expect(merged.assertions.every((a) => a.basis === 'configured')).toBe(true);
    expect(merged.coverage).not.toBe('complete');
  });

  it('bounds adversarial nesting', async () => {
    let deep: unknown = 'x';
    for (let i = 0; i < 100; i++) deep = [deep];
    await expect(
      apiExportCollector({
        file: await apiFile({ ...listing, deep }),
        sourceId: 'api-a',
        tenant: 'a',
        window,
      }).collect(),
    ).rejects.toMatchObject({ code: 'INVALID_API_EXPORT' });
  });
});

describe('assertion validation', () => {
  it('rejects an assertion naming an entity absent from the collection', async () => {
    const good = await apiExportCollector({
      file: await apiFile(listing),
      sourceId: 'api-a',
      tenant: 'a',
      window,
    }).collect();
    const tampered = structuredClone(good);
    tampered.assertions[0]!.subject.nativeId = 'ghost';
    expect(() => validateCollection(tampered)).toThrow(/assertion/u);
    const other = structuredClone(good);
    (other.assertions[0]!.object as { ref: { tenant: string } }).ref.tenant = 'b';
    expect(() => validateCollection(other)).toThrow(/assertion/u);
  });
});
void copyFile;
