// R5-B: Ctrl-C always works, and scans over repo text stay fast on hostile lines.
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, type Rule } from '../../src/contracts.js';
import { codeView, valueAssigned } from '../../src/rules/code-text.js';
import { runRule } from '../../src/rules/engine.js';
import { setScanBudget } from '../../src/rules/sandbox.js';
import { simulateInterrupt, stoppedLine } from '../../src/ui/interrupt.js';
import { createLive } from '../../src/ui/live.js';
import { initWorkspace } from '../../src/workspace/index.js';
import { BIN, REPO_ROOT, TS_HOOK } from '../mcp/client.js';
import { RULES } from '../mcp/fakes.js';

const HERE = join(REPO_ROOT, 'tests', 'rules', 'r5b');
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** Spawns `node --import ts-hook <entry> args`, waits for `ready` on stdout, sends SIGINT, and times the exit. */
function interrupt(entry: string, args: string[], ready: RegExp, cwd = REPO_ROOT, delayMs = 0) {
  return new Promise<{ ms: number; code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>((resolve, reject) => {
    const proc = spawn(process.execPath, ['--import', TS_HOOK, entry, ...args], {
      cwd,
      env: { ...process.env, NODE_NO_WARNINGS: '1', NO_COLOR: '1', VITEST: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let sentAt = 0;
    const kill = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error(`no "${ready}" within 20 s; stdout: ${stdout}; stderr: ${stderr}`));
    }, 20_000);
    proc.stdout.on('data', (c: Buffer) => {
      stdout += String(c);
      if (sentAt === 0 && ready.test(stdout)) {
        sentAt = -1;
        setTimeout(() => {
          sentAt = Date.now();
          proc.kill('SIGINT');
        }, delayMs);
      }
    });
    proc.stderr.on('data', (c: Buffer) => (stderr += String(c)));
    proc.on('close', (code, signal) => {
      clearTimeout(kill);
      resolve({ ms: sentAt > 0 ? Date.now() - sentAt : -1, code, signal, stdout, stderr });
    });
  });
}

const stoppedBySigint = (r: { code: number | null; signal: NodeJS.Signals | null }): boolean => r.code === 130 || r.signal === 'SIGINT';

describe('R5-B: scans stay fast on hostile lines', () => {
  it('a long backslash-heavy line, trailing spaces and a long type annotation are read in linear time', () => {
    const backslashes = `"${'\\\\b'.repeat(50_000)}|x" +`;
    const spaces = `"a"${' '.repeat(200_000)}x`;
    const typed = `TTL: number${' '.repeat(200_000)}x`;
    const started = Date.now();
    const view = codeView('src/a.ts', [backslashes, spaces, typed, `const TTL: number = 30;`].join('\n'));
    expect(view.live[0]).toBe(backslashes);
    valueAssigned(typed, 'TTL'); // read as `TTL:` (a key), but in linear time
    expect(valueAssigned('const TTL: number = 30;', 'TTL')).toMatchObject({ kind: 'number', value: 30 });
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('a hostile rule pattern stops at the scan budget and the rule is an error, not a hang', () => {
    const prev = setScanBudget(200);
    try {
      const rule: Rule = {
        id: 'R-x.01-1',
        promiseId: 'x.01',
        description: 'hostile',
        mode: 'must-match',
        pattern: '.*.*.*.*.*x',
        globs: ['src/**'],
        status: 'accepted',
        author: 'model',
      } as unknown as Rule;
      const started = Date.now();
      const res = runRule(rule, [{ path: 'src/a.ts', text: 'a'.repeat(5000) }], 'c'.repeat(40));
      expect(res.outcome).toBe('error');
      expect(Date.now() - started).toBeLessThan(1500);
    } finally {
      setScanBudget(prev);
    }
  });
});

describe('R5-B: Ctrl-C', () => {
  it('the handler clears live views, says what the run spent and exits 130', () => {
    const chunks: string[] = [];
    const tty = { isTTY: true, columns: 80, rows: 24, write: (s: string) => chunks.push(s) };
    const live = createLive({ title: 'bind', unit: 'promises', stream: tty as never, env: { TERM: 'xterm-256color' }, timer: false });
    live.add('a');
    live.start('a');
    live.addCost(0.5);
    live.render();
    const lines: string[] = [];
    let code = -1;
    simulateInterrupt({ write: (s: string) => lines.push(s) }, (c) => (code = c));
    expect(code).toBe(130);
    expect(chunks.join('')).toContain('\u001b[?25h');
    expect(lines.join('')).toContain('Stopped (Ctrl-C). This run spent $0.5');
    expect(stoppedLine(1.5)).toBe('Stopped (Ctrl-C). This run spent $1.50; nothing more was started.');
    live.finish();
  });

  it('a process waiting on the model prints the stopped line with its cost and exits 130 at once', async () => {
    const r = await interrupt(join(HERE, 'waiting.ts'), [], /waiting/u);
    expect(r.code).toBe(130);
    expect(r.stderr).toContain('Stopped (Ctrl-C). This run spent $0.1234');
    expect(r.ms).toBeLessThan(1000);
    expect(r.stdout).not.toContain('finished');
  }, 30_000);

  it('a process busy in hostile rule scans (main thread blocked) still stops within 1 s', async () => {
    const r = await interrupt(join(HERE, 'busy-scan.ts'), [], /busy/u, REPO_ROOT, 300);
    expect(stoppedBySigint(r)).toBe(true);
    expect(r.ms).toBeLessThan(1000);
    expect(r.stdout).not.toContain('finished');
  }, 30_000);

  it('a spawned `rule test` on hostile rules receives SIGINT and exits within 1 s', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'kw-r5b-')));
    dirs.push(root);
    const git = (...a: string[]) => execFileSync('git', a, { cwd: root, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }, stdio: 'ignore' });
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    const files: Record<string, string> = {};
    for (let i = 0; i < 20; i += 1) files[`src/f${i}.ts`] = `${'a'.repeat(2000)}\n`;
    for (const [p, t] of Object.entries(files)) {
      mkdirSync(dirname(join(root, p)), { recursive: true });
      writeFileSync(join(root, p), t);
    }
    const store = await initWorkspace(root, { ...DEFAULT_CONFIG, codeScope: ['src/**'], sources: [] });
    const { anchor: _anchor, within: _within, ...base } = RULES[0] as Rule & { anchor?: string; within?: number };
    const rules = Array.from({ length: 10 }, (_, i) => ({ ...base, id: `R-x.0${i}-1`, promiseId: `x.0${i}`, description: 'hostile', mode: 'must-match', pattern: '.*.*.*.*.*x', globs: ['src/**'] })) as unknown as Rule[];
    await store.writeRules(rules);
    git('add', '-A');
    git('commit', '-q', '-m', 'hostile');
    // `rule test` prints nothing until it ends; send Ctrl-C once its first scans are running.
    const r = await new Promise<{ ms: number; code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      const proc = spawn(process.execPath, ['--import', TS_HOOK, BIN, 'rule', 'test'], { cwd: root, env: { ...process.env, NODE_NO_WARNINGS: '1', NO_COLOR: '1' }, stdio: 'ignore' });
      let sentAt = 0;
      setTimeout(() => {
        sentAt = Date.now();
        proc.kill('SIGINT');
      }, 2500);
      proc.on('close', (code, signal) => resolve({ ms: Date.now() - sentAt, code, signal }));
    });
    expect(stoppedBySigint(r)).toBe(true);
    expect(r.ms).toBeLessThan(1000);
  }, 30_000);
});
