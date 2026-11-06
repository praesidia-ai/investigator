// End to end: the real `jurator mcp` command (src/bin.ts) in a temp git repo with a real .jurator/ store.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../../src/contracts.js';
import { initWorkspace } from '../../src/workspace/index.js';
import { BIN, McpTestClient, textOf } from './client.js';
import { FILES_BASE, PROMISES, RULES } from './fakes.js';

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function write(root: string, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
}

describe('jurator mcp (real store, real git, real check)', () => {
  let root: string;
  let client: McpTestClient;

  beforeAll(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'kw-mcp-')));
    git(root, 'init', '-q', '-b', 'main');
    git(root, 'config', 'user.email', 'test@example.com');
    git(root, 'config', 'user.name', 'Test');
    write(root, FILES_BASE);
    const store = await initWorkspace(root, {
      ...DEFAULT_CONFIG,
      codeScope: ['src/**'],
      sources: [
        { alias: 'privacy', connector: 'file', locator: 'docs/privacy.md' },
        { alias: 'security', connector: 'file', locator: 'docs/security.md' },
        { alias: 'praesidia', connector: 'praesidia', locator: 'policies/praesidia-support-agent.json' },
      ],
    });
    for (const alias of ['privacy', 'security', 'praesidia']) {
      await store.writePromises(alias, PROMISES.filter((p) => p.id.startsWith(`${alias}.`)));
    }
    await store.writeRules(RULES);
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'app + promises');
    git(root, 'checkout', '-q', '-b', 'feature/csv-export');
    write(root, {
      'src/routes/export.ts': `${FILES_BASE['src/routes/export.ts']}\nrouter.get('/export.csv', async (req, res) => {\n  res.send('csv');\n});\n`,
    });
    git(root, 'commit', '-q', '-am', 'csv export');
    client = McpTestClient.start(BIN, ['mcp'], { cwd: join(root, 'src') }); // started from a subfolder on purpose
    await client.initialize();
  });

  afterAll(async () => {
    await client?.close();
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it('promises_for_change reads the committed promises and rules', async () => {
    const r = await client.callTool('promises_for_change', { files: ['src/routes/export.ts'] });
    expect(r.isError).toBe(false);
    expect((r.structuredContent?.promises as Array<{ id: string }>).map((p) => p.id)).toEqual([
      'praesidia.01',
      'privacy.02',
      'security.01',
      'security.02',
    ]);
  });

  it('check_change finds the broken promise on the feature branch and saves a verifiable run', async () => {
    const r = await client.callTool('check_change', { base: 'main' });
    expect(r.isError).toBe(false);
    const s = r.structuredContent as { passed: boolean; runPath: string; results: Array<{ promiseId: string; verdict: string }> };
    expect(s.passed).toBe(false);
    expect(s.results.find((x) => x.promiseId === 'security.01')?.verdict).toBe('broken');
    expect(textOf(r)).toMatch(/Code {5}src\/routes\/export\.ts:9\n\S+ +router\.get\('\/export\.csv'/u);
    expect(existsSync(join(root, s.runPath))).toBe(true);
    // The tools never touch the reviewed files: the working tree is still clean (local/ is gitignored).
    expect(git(root, 'status', '--porcelain')).toBe('');
  });

  it('explain_promise reads the last verdict from the saved run on disk', async () => {
    const r = await client.callTool('explain_promise', { id: 'security.01' });
    expect(textOf(r)).toContain('Last verdict: BROKEN (rule, no AI)');
  });

  it('exits 0 when the agent closes stdin, and stdout carried only JSON', async () => {
    expect(await client.close()).toBe(0);
    expect(client.stderr).toContain('MCP server ready');
  });
});
