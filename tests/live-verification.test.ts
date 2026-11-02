import { describe, expect, it } from 'vitest';
const verification = (await import(
  new URL('../scripts/verify-meta.mjs', import.meta.url).href
)) as {
  verificationOptions(args: string[]): {
    cases: number;
    repetitions: number;
    outputDirectory: string;
  };
  liveChildEnvironment(env: Record<string, string>): Record<string, string>;
};

describe('explicit live verification entry point', () => {
  it('bounds the requested suite and requires a deliberate output location', () => {
    expect(verification.verificationOptions(['--out', 'new-results'])).toMatchObject({
      cases: 5,
      repetitions: 1,
    });
    expect(
      verification.verificationOptions([
        '--out',
        'new-results',
        '--cases',
        '12',
        '--repetitions',
        '3',
      ]),
    ).toMatchObject({ cases: 12, repetitions: 3 });
    for (const args of [
      [],
      ['--out', 'x', '--cases', '13'],
      ['--out', 'x', '--repetitions', '4'],
      ['--out', 'x', '--cases', ''],
      ['--out', 'x', '--unknown', 'true'],
    ])
      expect(() => verification.verificationOptions(args)).toThrow();
  });

  it('only forwards model credentials to the explicit live CLI child', () => {
    const env = verification.liveChildEnvironment({
      META_API_KEY: 'synthetic-meta',
      MODEL_ID: 'muse-wonder-1.0',
      MODEL_REASONING_EFFORT: 'high',
      PRAESIDIA_API_KEY: 'private-platform',
      NODE_AUTH_TOKEN: 'private-registry',
      NODE_OPTIONS: '--require=other.js',
      NODE_PATH: 'private-siblings',
      PATH: '/test/bin',
    });
    expect(env).toMatchObject({
      META_API_KEY: 'synthetic-meta',
      MODEL_ID: 'muse-wonder-1.0',
      MODEL_REASONING_EFFORT: 'high',
      PATH: '/test/bin',
    });
    expect(JSON.stringify(env)).not.toMatch(
      /private-platform|private-registry|NODE_OPTIONS|NODE_PATH/,
    );
  });
});
