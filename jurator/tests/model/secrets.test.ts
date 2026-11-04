import { describe, expect, it } from 'vitest';
import { isSecretFile, maskFileForModel, maskSecrets, MASK } from '../../src/model/index.js';

const lines = (s: string): number => s.split('\n').length;

describe('isSecretFile', () => {
  it('skips env files, keys and certificates', () => {
    for (const p of ['.env', '.env.local', '.envrc', 'config/.env.production', 'certs/server.pem', 'keys/app.key', '.ssh/id_rsa', 'a/b.p12']) {
      expect(isSecretFile(p), p).toBe(true);
    }
    for (const p of ['src/env.ts', 'src/environment.ts', 'src/keys.ts', 'docs/env.md', 'src/key-store.ts', 'README.md']) {
      expect(isSecretFile(p), p).toBe(false);
    }
  });
  it('maskFileForModel returns null for a secret file', () => {
    expect(maskFileForModel('.env', 'A=1')).toBeNull();
    expect(maskFileForModel('src/a.ts', 'const a = 1;')?.text).toBe('const a = 1;');
  });
});

describe('maskSecrets', () => {
  it('masks passwords, tokens and API keys in assignments without changing line counts', () => {
    const text = [
      "const adminPassword = 'hunter2';",
      'export const SESSION_SECRET = "s3cr3t-value";',
      "const config = { apiKey: 'abc123def456', db: { password: \"pw\" } };",
      'GITHUB_TOKEN := "tok_1"',
      "$conn = ['client_secret' => 'xyz'];",
      '',
    ].join('\n');
    const out = maskSecrets(text, 'src/config.ts');
    expect(lines(out.text)).toBe(lines(text));
    expect(out.text).not.toMatch(/hunter2|s3cr3t|abc123def456|"pw"|tok_1|xyz/u);
    expect(out.text).toContain(`adminPassword = '${MASK}'`);
    expect(out.text).toContain(`password: "${MASK}"`);
    expect(out.masked).toBe(6);
  });

  it('masks known token shapes anywhere, bearer tokens and URL passwords', () => {
    const text = [
      'const k = "AKIAABCDEFGHIJKLMNOP"; // AWS',
      '// old key: sk-proj-abcdefghijklmnopqrstuvwxyz0123',
      "fetch(url, { headers: { Authorization: 'Bearer abcdefghijklmnop1234' } });",
      'const db = "postgres://app:supersecret@db.internal:5432/notes";',
      'const gh = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";',
    ].join('\n');
    const out = maskSecrets(text, 'src/a.ts');
    expect(lines(out.text)).toBe(5);
    expect(out.text).not.toMatch(/AKIAABCD|sk-proj|abcdefghijklmnop1234|supersecret|ghp_/u);
    expect(out.text).toContain('postgres://app:[masked]@db.internal');
  });

  it('masks a private key block line by line, keeping every line break', () => {
    const text = ['const key = `', '-----BEGIN RSA PRIVATE KEY-----', 'MIIEowIBAAKCAQEA', 'q1w2e3r4t5', '-----END RSA PRIVATE KEY-----', '`;'].join('\n');
    const out = maskSecrets(text, 'src/a.ts');
    expect(lines(out.text)).toBe(lines(text));
    expect(out.text).not.toMatch(/MIIEow|q1w2e3/u);
    expect(out.text).toContain('-----BEGIN RSA PRIVATE KEY-----');
    const oneLine = 'const k = "-----BEGIN PRIVATE KEY-----\\nMIIEabc\\n-----END PRIVATE KEY-----";';
    expect(maskSecrets(oneLine).text).toBe(`const k = "-----BEGIN PRIVATE KEY-----${MASK}-----END PRIVATE KEY-----";`);
  });

  it('keeps what promises are checked against: numbers, settings, references, names, algorithms', () => {
    const text = [
      'export const TOKEN_TTL_SECONDS = 3600;',
      "const PASSWORD_MIN_LENGTH = '12';",
      "return hash(plain, { type: 'argon2id', memoryCost: 19_456 });",
      "const SECRET_KEYS = ['password', 'cardNumber', 'cvc'];",
      'const apiKey = process.env.API_KEY;',
      'const token = `Bearer ${session.token}`;',
      "const tokenType = 'Bearer';",
      "const passwordHashAlgorithm = 'bcrypt';",
      "const sortKey = 'createdAt';",
      "if (password === '') throw new Error('Password is required');",
      "const secret = '${SECRET}';",
      "const msg = 'Invalid token, try again';",
      'export const CHAT_TTL_DAYS = 30;',
    ].join('\n');
    const out = maskSecrets(text, 'src/a.ts');
    expect(out.text).toBe(text);
    expect(out.masked).toBe(0);
  });

  it('masks bare NAME=value lines only in config files', () => {
    const yaml = ['db:', '  password: hunter2', '  token_ttl: 3600', '  host: db.internal', 'export API_SECRET=abc'].join('\n');
    const out = maskSecrets(yaml, 'deploy/values.yaml');
    expect(out.text).toBe(['db:', `  password: ${MASK}`, '  token_ttl: 3600', '  host: db.internal', `export API_SECRET=${MASK}`].join('\n'));
    expect(maskSecrets('const token = getToken();', 'src/a.ts').text).toBe('const token = getToken();');
    expect(maskSecrets('token = get_token()', 'app/auth.py').text).toBe('token = get_token()');
  });

  it('masks a generic *_KEY only when the value looks random', () => {
    expect(maskSecrets("const STRIPE_KEY = 'pk9f8a7b6c5d4e3f2a1b';").text).toBe(`const STRIPE_KEY = '${MASK}';`);
    expect(maskSecrets("const CACHE_KEY = 'notes';").text).toBe("const CACHE_KEY = 'notes';");
  });

  it('keeps \\r\\n line endings', () => {
    const text = "const password = 'x1';\r\nconst a = 1;\r\n";
    const out = maskSecrets(text);
    expect(out.text).toBe(`const password = '${MASK}';\r\nconst a = 1;\r\n`);
  });
});
