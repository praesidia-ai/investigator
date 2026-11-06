import { describe, expect, it } from 'vitest';
import {
  importOtelTraces,
  OTEL_GENAI_PINNED_SCHEMA,
  type ImportOtelOptions,
} from '../src/context/import-otel.js';
import { validateCollection } from '../src/context/collector.js';

const str = (stringValue: string) => ({ stringValue });
function span(id: string, extra: object = {}, attrs: object[] = []) {
  return {
    traceId: 't1',
    spanId: id,
    startTimeUnixNano: '1793534400000000000',
    status: { code: 1 },
    attributes: [
      { key: 'gen_ai.operation.name', value: str('execute_tool') },
      { key: 'gen_ai.tool.name', value: str('export_customer') },
      ...attrs,
    ],
    ...extra,
  };
}
const trace = (spans: object[]) =>
  JSON.stringify({
    resourceSpans: [
      {
        resource: {
          attributes: [
            { key: 'service.name', value: str('agent') },
            { key: 'service.version', value: str('1.2') },
          ],
        },
        scopeSpans: [{ spans }],
      },
    ],
  });
const opts = (content: string, over: Partial<ImportOtelOptions> = {}): ImportOtelOptions => ({
  sourceId: 'otel',
  tenant: 'a',
  schemaVersion: OTEL_GENAI_PINNED_SCHEMA,
  window: { from: '2026-11-01T00:00:00.000Z', to: '2026-12-01T00:00:00.000Z' },
  coverage: { droppedSpans: 0, captureClosed: true, retention: '7 days' },
  content,
  capturedAt: '2026-11-05T00:00:00.000Z',
  ...over,
});

describe('OTLP trace importer', () => {
  it('produces observed operations with no effect evidence, keeps unknown attributes', () => {
    const r = validateCollection(
      importOtelTraces(opts(trace([span('s1', {}, [{ key: 'vendor.x', value: str('keep') }])]))),
    );
    expect(r.operations[0]).toMatchObject({
      basis: 'observed',
      effectEvidence: 'none',
      status: 'ok',
    });
    expect(r.operations[0]!.retainedAttributes).toEqual({ 'vendor.x': { stringValue: 'keep' } });
    expect(r.assertions[0]).toMatchObject({ basis: 'observed', relation: 'CALLS' });
    expect(r.dependencies[0]).toMatchObject({ kind: 'application', revision: '1.2' });
    expect(r.frontier.every((f) => f.kind === 'caveat')).toBe(true);
  });

  it('dropped spans, unknown drops, open capture and missing parents are frontier', () => {
    const r = importOtelTraces(
      opts(trace([span('s1', { parentSpanId: 'gone' })]), {
        coverage: { droppedSpans: null, captureClosed: false },
      }),
    );
    const kinds = r.frontier.map((f) => f.kind);
    expect(kinds).toContain('dropped-data');
    expect(kinds.filter((k) => k === 'missing-trace')).toHaveLength(2);
    expect(r.sources[0]!.coverage).toBe('partial');
    expect(r.evidence[0]!.coverage).toBe('partial');
  });

  it('refuses unknown schema versions unless explicitly accepted', () => {
    const content = trace([span('s1')]);
    expect(() => importOtelTraces(opts(content, { schemaVersion: 'v9' }))).toThrow(/pinned/);
    expect(() =>
      importOtelTraces(opts(content, { schemaVersion: 'v9', acceptSchemaVersion: 'v8' })),
    ).toThrow(/pinned/);
    expect(
      importOtelTraces(opts(content, { schemaVersion: 'v9', acceptSchemaVersion: 'v9' }))
        .operations,
    ).toHaveLength(1);
  });

  it('rejects duplicate spans, bad input and deep nesting', () => {
    expect(() => importOtelTraces(opts(trace([span('s1'), span('s1')])))).toThrow(/unique/);
    expect(() => importOtelTraces(opts('{'))).toThrow();
    let deep: unknown = 'x';
    for (let i = 0; i < 100; i++) deep = [deep];
    const content = JSON.stringify({ resourceSpans: [], deep });
    expect(() => importOtelTraces(opts(content))).toThrow(/Trace export/);
  });
});

describe('OTLP importer review fixes', () => {
  it('redacts secrets from evidence, citations and retained attributes, keeping keys', () => {
    const content = trace([
      span('s1', {}, [
        { key: 'http.request.header.authorization', value: str('Bearer sk-live1234567890abcdef') },
        { key: 'gen_ai.tool.call.arguments', value: str('{"k":"v"}') },
        { key: 'note', value: str('used key sk-abcdefghijkl here') },
      ]),
    ]);
    const r = validateCollection(importOtelTraces(opts(content)));
    const all = JSON.stringify(r);
    expect(all).not.toMatch(/sk-live|sk-abcdef|Bearer sk|"k":"v"/u);
    expect(r.evidence[0]!.redacted).toBe(true);
    expect(Object.keys(r.operations[0]!.retainedAttributes!)).toEqual(
      expect.arrayContaining(['http.request.header.authorization', 'gen_ai.tool.call.arguments']),
    );
  });

  it('uninterpreted-only or unpinned import is blocking; pinned with some GenAI spans is a caveat', () => {
    const plain = {
      traceId: 't',
      spanId: 'p',
      startTimeUnixNano: '1',
      attributes: [{ key: 'http.method', value: str('GET') }],
    };
    const blind = importOtelTraces(opts(trace([plain])));
    expect(blind.frontier.some((f) => f.kind === 'dropped-data')).toBe(true);
    expect(blind.sources[0]!.coverage).toBe('partial');
    const mixed = importOtelTraces(opts(trace([span('s1'), plain])));
    expect(mixed.sources[0]!.coverage).toBe('complete');
    const unpinned = importOtelTraces(
      opts(trace([span('s1'), plain]), { schemaVersion: 'v9', acceptSchemaVersion: 'v9' }),
    );
    expect(unpinned.sources[0]!.coverage).toBe('partial');
  });

  it('missing service name, conflicting revisions and over-long names are not silently merged', () => {
    const rs = (attrs: object[]) => ({
      resource: { attributes: attrs },
      scopeSpans: [{ spans: [span(`s${Math.random()}`)] }],
    });
    const name = (v: string) => ({ key: 'service.name', value: str(v) });
    const ver = (v: string) => ({ key: 'service.version', value: str(v) });
    const noName = importOtelTraces(opts(JSON.stringify({ resourceSpans: [rs([])] })));
    expect(
      noName.frontier.some((f) => f.kind === 'unlisted' && /service\.name/u.test(f.detail)),
    ).toBe(true);
    const conflict = importOtelTraces(
      opts(
        JSON.stringify({ resourceSpans: [rs([name('a'), ver('1')]), rs([name('a'), ver('2')])] }),
      ),
    );
    expect(conflict.frontier.some((f) => /conflicting/u.test(f.detail))).toBe(true);
    expect(() =>
      importOtelTraces(opts(JSON.stringify({ resourceSpans: [rs([name('x'.repeat(600))])] }))),
    ).toThrow(/too long/u);
  });
});
