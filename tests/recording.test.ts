import { describe, expect, it } from 'vitest';
import { isAbsolute, join } from 'node:path';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const recording = (await import(new URL('../scripts/record-demo.mjs', import.meta.url).href)) as {
  parseRecordingOptions(args: string[]): {
    outputDirectory?: string;
    live: boolean;
    auto: boolean;
    help: boolean;
  };
  recordingEnvironment(source: Record<string, string>, live: boolean): Record<string, string>;
  redactRecordingText(text: string, secrets: readonly string[]): string;
  recordingCredentialValues(source: Record<string, string>): string[];
  isRecordingEntrypoint(entry?: string): Promise<boolean>;
};

describe('demo recording boundaries', () => {
  it('does not classify ordinary tokenization settings as credentials', () => {
    expect(
      recording.recordingCredentialValues({
        META_API_KEY: 'synthetic-model-secret',
        MODEL_API_KEY: 'synthetic-compatible-secret',
        NPM_TOKEN: 'synthetic-registry-secret',
        TOKENIZERS_PARALLELISM: 'false',
        MAX_TOKENS: '4096',
        KEYBOARD_LAYOUT: 'us',
      }),
    ).toEqual([
      'synthetic-model-secret',
      'synthetic-compatible-secret',
      'synthetic-registry-secret',
    ]);
  });

  it('recognizes a symlinked entry point without running when imported by another program', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'investigator-recording-entry-'));
    try {
      const entry = join(directory, 'record-link.mjs');
      await symlink(fileURLToPath(new URL('../scripts/record-demo.mjs', import.meta.url)), entry);
      expect(await recording.isRecordingEntrypoint(entry)).toBe(true);
      expect(await recording.isRecordingEntrypoint(fileURLToPath(import.meta.url))).toBe(false);
      expect(await recording.isRecordingEntrypoint(join(directory, 'missing.mjs'))).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('requires a deliberate destination and explicit live execution', () => {
    const rehearsal = recording.parseRecordingOptions(['--out', 'artifacts/new-recording']);
    expect(rehearsal).toMatchObject({ live: false, auto: false, help: false });
    expect(isAbsolute(rehearsal.outputDirectory!)).toBe(true);
    expect(
      recording.parseRecordingOptions(['--out', 'artifacts/new-live', '--live', '--auto']),
    ).toMatchObject({ live: true, auto: true });
    expect(recording.parseRecordingOptions(['--help']).help).toBe(true);
    for (const args of [
      [],
      ['--out'],
      ['--out', 'first', '--out', 'second'],
      ['--out', 'first', '--unknown'],
      ['--out', 'first', '--live', '--live'],
    ])
      expect(() => recording.parseRecordingOptions(args)).toThrow();
  });

  it('does not send model credentials during rehearsal or propagate unrelated credentials/preloads', () => {
    const source = {
      PATH: '/synthetic/bin',
      META_API_KEY: 'synthetic-meta-credential',
      MODEL_API_KEY: 'synthetic-model-credential',
      MODEL_ID: 'operator-selected-model',
      PRAESIDIA_API_KEY: 'synthetic-platform-credential',
      NODE_AUTH_TOKEN: 'synthetic-registry-credential',
      NPM_TOKEN: 'synthetic-npm-credential',
      NODE_OPTIONS: '--require=/synthetic/private-module.js',
      NODE_PATH: '/synthetic/private-modules',
    };
    const rehearsal = recording.recordingEnvironment(source, false);
    expect(rehearsal.PATH).toBe(source.PATH);
    expect(rehearsal.META_API_KEY).toBeUndefined();
    expect(rehearsal.MODEL_API_KEY).toBeUndefined();
    const live = recording.recordingEnvironment(source, true);
    expect(live.META_API_KEY).toBe(source.META_API_KEY);
    expect(live.MODEL_API_KEY).toBe(source.MODEL_API_KEY);
    expect(live.MODEL_ID).toBe(source.MODEL_ID);
    for (const environment of [rehearsal, live])
      for (const name of [
        'PRAESIDIA_API_KEY',
        'NODE_AUTH_TOKEN',
        'NPM_TOKEN',
        'NODE_OPTIONS',
        'NODE_PATH',
      ])
        expect(environment[name]).toBeUndefined();
  });

  it('redacts literal credential values in complete buffered output without regex interpretation', () => {
    const key = 'synthetic.key+with[regex]$';
    const raw = `first ${key}; split-assembled ${key}; final`;
    const cleaned = recording.redactRecordingText(raw, ['', key]);
    expect(cleaned).not.toContain(key);
    expect(cleaned).toContain('first');
    expect(cleaned).toContain('final');
    expect(recording.redactRecordingText('ordinary visible output', [])).toBe(
      'ordinary visible output',
    );
  });
});
