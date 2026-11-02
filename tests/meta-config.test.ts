import { describe, expect, it, vi } from 'vitest';
import {
  createMetaProvider,
  diagnoseMeta,
  readMetaEnvironment,
} from '../src/providers/meta-config.js';
import { investigate } from '../src/core/coordinator.js';
import { referenceCase } from './helpers.js';

describe('explicit Meta configuration and account preflight', () => {
  it('supports the requested key name and the official compatible name', () => {
    expect(readMetaEnvironment({ META_API_KEY: 'synthetic-key' }).apiKey).toBe('synthetic-key');
    expect(readMetaEnvironment({ MODEL_API_KEY: 'synthetic-key' }).apiKey).toBe('synthetic-key');
    expect(
      readMetaEnvironment({ MODEL_API_KEY: 'synthetic-key', META_API_KEY: 'synthetic-key' }).model,
    ).toBe('muse-wonder-1.0');
    expect(() =>
      readMetaEnvironment({ MODEL_API_KEY: 'private-a', META_API_KEY: 'private-b' }),
    ).toThrow('different credentials');
    expect(() => createMetaProvider({})).toThrow('Set META_API_KEY');
    expect(JSON.stringify(createMetaProvider({ META_API_KEY: 'synthetic-secret' }))).not.toContain(
      'synthetic-secret',
    );
  });

  it('does not make network requests or disclose keys in an offline diagnostic', async () => {
    const fetch = vi.fn();
    const diagnostic = await diagnoseMeta({ META_API_KEY: 'synthetic-secret' }, { fetch });
    expect(fetch).not.toHaveBeenCalled();
    expect(diagnostic).toMatchObject({
      selectedModel: 'muse-wonder-1.0',
      keyConfigured: true,
      accountAccess: 'not-checked',
      generationVerification: 'not-performed',
    });
    expect(JSON.stringify(diagnostic)).not.toContain('synthetic-secret');
  });

  it('checks only the catalog and never silently substitutes an unavailable model', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      expect(String(input)).toBe('https://api.meta.ai/v1/models');
      expect(init?.method).toBe('GET');
      expect(init?.redirect).toBe('error');
      expect(init?.headers).toMatchObject({ Authorization: 'Bearer synthetic-key' });
      return new Response(
        JSON.stringify({ object: 'list', data: [{ id: 'muse-spark-1.3', created: 1 }] }),
      );
    });
    const diagnostic = await diagnoseMeta({ META_API_KEY: 'synthetic-key' }, { live: true, fetch });
    expect(diagnostic.accountAccess).toBe('selected-model-unavailable');
    expect(diagnostic.selectedModel).toBe('muse-wonder-1.0');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('records availability without claiming generation or tool compatibility was tested', async () => {
    const diagnostic = await diagnoseMeta(
      {
        MODEL_API_KEY: 'synthetic-key',
        MODEL_ID: 'muse-spark-1.3',
        MODEL_REASONING_EFFORT: 'high',
      },
      {
        live: true,
        fetch: async () =>
          new Response(JSON.stringify({ object: 'list', data: [{ id: 'muse-spark-1.3' }] })),
      },
    );
    expect(diagnostic).toMatchObject({
      selectedModel: 'muse-spark-1.3',
      reasoningEffort: 'high',
      accountAccess: 'selected-model-available',
      generationVerification: 'not-performed',
    });
  });

  it.each([
    'http://127.0.0.1:4000/v1',
    'https://user:secret@api.meta.ai/v1',
    'https://api.meta.ai/v1?key=secret',
  ])('rejects unsafe credential destinations %s', (baseUrl) => {
    expect(() => readMetaEnvironment({ MODEL_BASE_URL: baseUrl })).toThrow('HTTPS');
  });

  it('sanitizes upstream failures and rejects malformed or oversized catalogs', async () => {
    await expect(
      diagnoseMeta(
        { META_API_KEY: 'synthetic-key' },
        {
          live: true,
          fetch: async () => {
            throw new Error('private provider details');
          },
        },
      ),
    ).rejects.toThrow('no response content');
    await expect(
      diagnoseMeta(
        { META_API_KEY: 'synthetic-key' },
        { live: true, fetch: async () => new Response('private account data', { status: 401 }) },
      ),
    ).rejects.toThrow('verify credentials');
    await expect(
      diagnoseMeta(
        { META_API_KEY: 'synthetic-key' },
        { live: true, fetch: async () => new Response(JSON.stringify({ data: [] })) },
      ),
    ).rejects.toThrow('unsupported shape');
    await expect(
      diagnoseMeta(
        { META_API_KEY: 'synthetic-key' },
        { live: true, fetch: async () => new Response('x'.repeat(262_145)) },
      ),
    ).rejects.toThrow('exceeds');
  });

  it('cancels a catalog request even when an injected transport ignores the signal', async () => {
    await expect(
      diagnoseMeta(
        { META_API_KEY: 'synthetic-key' },
        { live: true, timeoutMs: 10, fetch: () => new Promise(() => {}) },
      ),
    ).rejects.toMatchObject({ code: 'MODEL_CATALOG_ABORTED' });
  });

  it('passes the actual configured reasoning effort into the coordinator and report', async () => {
    const calls: string[] = [];
    const run = await investigate({
      ...(await referenceCase()),
      provider: {
        id: 'test-live',
        model: 'test-model',
        mode: 'live',
        reasoningEffort: 'high',
        async complete(request) {
          calls.push(request.reasoningEffort ?? 'missing');
          return {
            text: JSON.stringify({
              verdict: 'insufficient_evidence',
              statement: 'Unresolved',
              citations: [],
              missingEvidence: ['Execute checks'],
            }),
            state: [],
            toolCalls: [],
          };
        },
      },
    });
    expect(calls).toEqual(['high', 'high']);
    expect(run.provider.reasoningEffort).toBe('high');
  });
});
