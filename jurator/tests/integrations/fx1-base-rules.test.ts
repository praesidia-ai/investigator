// FX-1: the pre-push check runs the rules committed at the push base, so a branch cannot weaken its own rule.
// A real git repo in a temp folder; no network.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCheck } from '../../src/check/index.js';
import { DEFAULT_CONFIG, type PromiseRecord, type Rule } from '../../src/contracts.js';
import { openRepo } from '../../src/git/index.js';
import { rulesCheck } from '../../src/integrations/checker.js';
import { initWorkspace, openStore } from '../../src/workspace/index.js';

let root: string;
const git = (...args: string[]): string => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
const now = () => new Date('2026-11-04T06:00:00.000Z');

const promise: PromiseRecord = {
  id: 'privacy.01',
  status: 'accepted',
  wording: 'Support chats are deleted within 30 days.',
  quote: { alias: 'privacy', policySha256: 'a'.repeat(64), text: 'Support chats are deleted after 30 days.', line: 3 },
  kind: 'must',
  checkable: 'code',
  scope: ['src/agent/**'],
  foundBy: 'model',
  firstSeen: '2026-11-04T03:00:00.000Z',
};
const rule = (pattern: string): Rule => ({
  id: 'R-privacy.01-1',
  promiseId: 'privacy.01',
  description: 'The chat TTL constant is 30 days or less.',
  mode: 'must-match',
  pattern,
  globs: ['src/agent/**'],
  provenBy: { mutation: 'changed 30 to 31; the rule failed', failedAsExpected: true, at: '2026-11-04T03:00:00.000Z' },
  status: 'accepted',
  author: 'model',
  createdAt: '2026-11-04T03:00:00.000Z',
});

beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'kw-base-rules-')));
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');
  mkdirSync(join(root, 'src/agent'), { recursive: true });
  writeFileSync(join(root, 'src/agent/chats.ts'), 'export const CHAT_TTL_DAYS = 30;\n');
  const store = await initWorkspace(root, { ...DEFAULT_CONFIG, codeScope: ['src/**'] });
  await store.writePromises('privacy', [promise]);
  await store.writeRules([rule('CHAT_TTL_DAYS\\s*=\\s*30\\b')]);
  git('add', '-A');
  git('commit', '-q', '-m', 'main with promises and rules');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('pre-push reads the rules from the base commit', () => {
  it('a branch that sets 90 and weakens its rule to the bare name is still BROKEN on push', async () => {
    const base = git('rev-parse', 'HEAD');
    git('checkout', '-q', '-b', 'agent/retention');
    writeFileSync(join(root, 'src/agent/chats.ts'), 'export const CHAT_TTL_DAYS = 90;\n');
    await openStore(root).writeRules([rule('CHAT_TTL_DAYS')]); // the agent "fixes" the rule
    git('add', '-A');
    git('commit', '-q', '-m', 'longer retention');
    const head = git('rev-parse', 'HEAD');
    const target = { kind: 'diff' as const, base, head };

    // Without the fix, the weakened working-tree rule would pass:
    const repo = await openRepo(root);
    const weak = await runCheck({ repo, store: openStore(root), model: null, target, aiRead: false, now });
    expect(weak.results[0]?.verdict).toBe('holds');

    const outcome = await rulesCheck(root, target, now);
    expect(outcome.rulesFrom).toBe(base);
    expect(outcome.run?.results[0]).toMatchObject({ promiseId: 'privacy.01', verdict: 'broken', level: 'rule' });
  });

  it('when the base has no committed rules, the workspace rules are used', async () => {
    git('rm', '-q', '--cached', '.jurator/rules.json');
    git('commit', '-q', '-m', 'rules not committed');
    const base = git('rev-parse', 'HEAD');
    writeFileSync(join(root, 'src/agent/chats.ts'), 'export const CHAT_TTL_DAYS = 90;\n');
    git('add', 'src');
    git('commit', '-q', '-m', 'longer retention');
    const outcome = await rulesCheck(root, { kind: 'diff', base, head: git('rev-parse', 'HEAD') }, now);
    expect(outcome.rulesFrom).toBeUndefined();
    expect(outcome.run?.results[0]?.verdict).toBe('broken');
  });
});
