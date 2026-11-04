import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createModel, ScriptedModelClient, scriptedFileName, tryCreateModel } from '../../src/model/index.js';
import { JuratorError } from '../../src/util/errors.js';
import { CONFIG, TEST_KEY } from './helpers.js';

const schema = z.object({ verdict: z.enum(['looks-kept', 'looks-broken', 'cant-tell']), why: z.string() });
const request = (task: string) => ({ task, instructions: 'x', input: 'y', schemaName: 'ai_read', schema });

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'kw-scripted-'));
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'ai-read__security.01.json'), JSON.stringify({ verdict: 'looks-broken', why: 'no guard' }));
  await writeFile(join(dir, 'ai-read__bad.01.json'), JSON.stringify({ verdict: 'holds', why: 'x' }));
  await writeFile(join(dir, 'ai-read__junk.01.json'), '{nope');
});

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof JuratorError) return `${error.code}: ${error.message}`;
    throw error;
  }
  return 'resolved';
}

describe('scripted client', () => {
  it('maps task keys to file names', () => {
    expect(scriptedFileName('compile:privacy')).toBe('compile__privacy.json');
    expect(scriptedFileName('ai-read:security.01')).toBe('ai-read__security.01.json');
    expect(() => scriptedFileName('../etc/passwd')).toThrowError(/cannot be used/u);
    expect(() => scriptedFileName('')).toThrowError(JuratorError);
  });

  it('answers from <dir>/<task>.json with zero usage', async () => {
    const model = new ScriptedModelClient(dir);
    const result = await model.json(request('ai-read:security.01'));
    expect(result.value).toEqual({ verdict: 'looks-broken', why: 'no guard' });
    expect(result.usage).toEqual({ id: 'scripted', mode: 'scripted', inputTokens: 0, outputTokens: 0, usd: 0 });
    expect(model.mode).toBe('scripted');
    expect(model.tasks).toEqual(['ai-read:security.01']);
  });

  it('fails plainly when the answer is missing, not JSON, or off-schema', async () => {
    const model = new ScriptedModelClient(dir);
    expect(await codeOf(model.json(request('ai-read:missing.01')))).toBe(
      `SCRIPTED_ANSWER_MISSING: No scripted answer for ai-read:missing.01 at ${join(dir, 'ai-read__missing.01.json')}`,
    );
    expect(await codeOf(model.json(request('ai-read:junk.01')))).toMatch(/^SCRIPTED_ANSWER_INVALID: .*not valid JSON/u);
    expect(await codeOf(model.json(request('ai-read:bad.01')))).toMatch(/^SCRIPTED_ANSWER_INVALID: .*verdict/u);
  });
});

describe('createModel / tryCreateModel', () => {
  it('uses the scripted client when a dir is given, even with a key, and never fetches', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const model = createModel({ config: CONFIG, env: { META_API_KEY: TEST_KEY }, scriptedDir: dir, fetch });
    expect(model.mode).toBe('scripted');
    await model.json(request('ai-read:security.01'));
    expect(fetch).not.toHaveBeenCalled();
  });

  it('resolves a relative scripted dir against cwd, and honours JURATOR_SCRIPTED_DIR', () => {
    const a = createModel({ config: CONFIG, env: {}, scriptedDir: 'fixtures/x', cwd: '/repo' }) as ScriptedModelClient;
    expect(a.dir).toBe('/repo/fixtures/x');
    const b = createModel({ config: CONFIG, env: { JURATOR_SCRIPTED_DIR: dir } });
    expect(b.mode).toBe('scripted');
  });

  it('is live with a key (META_API_KEY or MODEL_API_KEY) and uses the configured model id', () => {
    expect(createModel({ config: CONFIG, env: { META_API_KEY: TEST_KEY } }).mode).toBe('live');
    const spark = createModel({
      config: { ...CONFIG, model: { id: 'muse-spark-1.3' } },
      env: { MODEL_API_KEY: TEST_KEY },
    });
    expect(spark.id).toBe('muse-spark-1.3');
    const overridden = createModel({ config: CONFIG, env: { META_API_KEY: TEST_KEY, MODEL_ID: 'muse-spark-1.3' } });
    expect(overridden.id).toBe('muse-spark-1.3');
  });

  it('throws MODEL_KEY_REQUIRED without key or dir; tryCreateModel returns null', () => {
    expect(() => createModel({ config: CONFIG, env: {} })).toThrowError(
      'Set META_API_KEY to use AI steps, or pass --scripted <dir>, or use --no-ai.',
    );
    try {
      createModel({ config: CONFIG, env: {}, scriptedDir: undefined });
    } catch (error) {
      expect((error as JuratorError).code).toBe('MODEL_KEY_REQUIRED');
    }
    expect(tryCreateModel({ config: CONFIG, env: {} })).toBeNull();
    expect(tryCreateModel({ config: CONFIG, env: { META_API_KEY: TEST_KEY } })?.mode).toBe('live');
  });

  it('rejects two different keys without echoing either', () => {
    try {
      createModel({ config: CONFIG, env: { META_API_KEY: 'key-one-xyz', MODEL_API_KEY: 'key-two-xyz' } });
      expect.unreachable();
    } catch (error) {
      expect((error as JuratorError).code).toBe('MODEL_KEY_CONFLICT');
      expect((error as Error).message).not.toMatch(/key-one|key-two/u);
    }
  });
});
