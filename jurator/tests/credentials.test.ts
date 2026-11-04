import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { withFileCredentials } from '../src/util/credentials.js';

describe('withFileCredentials', () => {
  const home = mkdtempSync(join(tmpdir(), 'jur-cred-'));
  writeFileSync(join(home, 'credentials.json'), JSON.stringify({ META_API_KEY: 'from-file', OTHER: 'ignored' }));
  it('fills a missing key from the credentials file', () => {
    expect(withFileCredentials({ JURATOR_HOME: home }).META_API_KEY).toBe('from-file');
  });
  it('lets the environment win', () => {
    expect(withFileCredentials({ JURATOR_HOME: home, META_API_KEY: 'from-env' }).META_API_KEY).toBe('from-env');
  });
  it('ignores keys it does not know and missing files', () => {
    expect(withFileCredentials({ JURATOR_HOME: home }).OTHER).toBeUndefined();
    expect(withFileCredentials({ JURATOR_HOME: join(home, 'nope') }).META_API_KEY).toBeUndefined();
  });
});
