// HZ-1: the rule propose screen in the new look (backlog 14-15): short ids, the promise's own words, one plain line of
// what the rule checks, plain reasons with the retry command, and the BROKEN NOW box (summary first, Found path:line
// before each code line, To fix, the policy sentence once). Summaries come from recorded answers (no network).
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runRuleCommand } from '../../src/cli/commands/rule.js';
import type { Config, ModelClient, ModelJsonRequest, ModelJsonResult, Rule, Store } from '../../src/contracts.js';
import { ScriptedModelClient } from '../../src/model/scripted.js';
import { stripAnsi } from '../../src/ui/index.js';
import { makeStyle } from '../../src/util/term.js';
import { promise } from '../rules/helpers.js';

const SHA = '1111111111111111111111111111111111111111';
const NOW = new Date('2026-11-04T04:00:00.000Z');
const facets = { facets: { subject: 'support chats', action: 'delete', constraint: { name: 'retention', op: '<=' as const, value: '30', unit: 'days' } } };
const code = [{ path: 'src/agent/chats.ts', text: 'export const CHAT_TTL_DAYS = 90;\n' }];
const promises = [
  promise('document-handling.01', 'Support chats are deleted after 30 days.', ['src/agent/**'], { ...facets, quote: { alias: 'document-handling', policySha256: '0'.repeat(64), text: 'Chats are deleted after 30 days.', line: 7 } }),
  promise('document-handling.16', 'Uploaded files are deleted after processing.', ['src/agent/**']),
];
const answers: Record<string, unknown> = {
  'rule-propose:document-handling.01': {
    feasible: true,
    reason: 'Breaks now: the value is over the limit',
    flags: null,
    anchor: null,
    within: null,
    description: 'must-match: The support chat lifetime CHAT_TTL_DAYS is set to 30 days or less.',
    violationExamples: [],
    keptExamples: [],
    mode: 'must-match',
    pattern: 'CHAT_TTL_DAYS\\s*=\\s*(?:[0-9]|[12][0-9]|30)\\b',
    globs: ['src/agent/**'],
  },
};

describe('rule propose screen (new look)', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function world() {
    const dir = mkdtempSync(join(tmpdir(), 'hz1-rule-'));
    dirs.push(dir);
    const recorded = join(dir, 'answers');
    let rules: Rule[] = [];
    const store = {
      dir: join(dir, '.jurator'),
      repoRoot: dir,
      exists: async () => true,
      readConfig: async () => ({ schemaVersion: 1, sources: [{ alias: 'document-handling', connector: 'file', locator: 'policies/document-handling.md' }], failMode: 'block', codeScope: ['src/**'], model: { id: 'm' }, budgetUsdPerRun: 10 }) as unknown as Config,
      readPromises: async () => promises,
      readRules: async () => rules,
      writeRules: async (items: Rule[]) => {
        rules = items;
      },
    } as unknown as Store;
    const repo = {
      root: dir,
      snapshot: async () => ({ repo: dir, branch: 'agent/retention', commit: SHA, dirty: false }),
      resolve: async () => SHA,
      listFiles: async () => code.map((f) => f.path),
      readFile: async (_c: string, path: string) => code.find((f) => f.path === path)?.text ?? '',
      changedFiles: async () => [],
    };
    const made: string[] = [];
    const deps = {
      findRepoRoot: async () => dir,
      openStore: () => store,
      openRepo: async () => repo,
      createModel: (o: { config: Config; scriptedDir?: string }): ModelClient => {
        made.push(o.scriptedDir ? `scripted:${o.config.model.id}` : o.config.model.id);
        if (o.scriptedDir) return new ScriptedModelClient(o.scriptedDir);
        return {
          id: 'fake-live',
          mode: 'live',
          async json<T>(request: ModelJsonRequest<T>): Promise<ModelJsonResult<T>> {
            const a = answers[request.task];
            if (!a) throw Object.assign(new Error(`The model's answer for "${request.task}" was cut off at its output limit (4096 tokens); nothing was saved.`), { code: 'MODEL_INCOMPLETE' });
            return { value: request.schema.parse(a), usage: { id: 'fake-live', mode: 'live', inputTokens: 1, outputTokens: 1, usd: 0.3 } };
          },
        };
      },
      infeasible: { read: async () => [], write: async () => true },
      mutants: { read: async () => ({ version: 1 as const, rules: {} }), write: async () => true },
    };
    return { deps, dir, recorded, made };
  }

  function ctx(argv: string[], env: NodeJS.ProcessEnv = { JURATOR_UI: '1', COLUMNS: '110' }) {
    const out: string[] = [];
    const c = { cwd: '/x', argv, env, out: (l: string) => out.push(l), err: (l: string) => out.push(l), style: makeStyle(false), now: () => NOW };
    return { c, out };
  }

  it('short ids, plain wording, a plain rule line, a plain reason with the retry command, and the BROKEN NOW box', async () => {
    const w = world();
    const { c, out } = ctx(['propose', 'doc.01,doc.16']);
    expect(await runRuleCommand(c, w.deps as never)).toBe(0);
    const lines = out.map(stripAnsi);
    const text = lines.join('\n');
    // Table: short id, result, the promise's words; under it what the rule checks (no mode jargon, no rule id column).
    expect(text).toMatch(/Promise\s+Result\s+What it promises/u);
    expect(text).toMatch(/doc\.01\s+✗ BROKEN NOW\s+Support chats are deleted after 30 days\./u);
    expect(text).toContain('Rule: The support chat lifetime CHAT_TTL_DAYS is set to 30 days or less.');
    expect(text).not.toContain('must-match:');
    expect(text).not.toMatch(/\bRule\s+Why\b/u);
    expect(text).toMatch(/doc\.16\s+· no rule this time\s+Uploaded files are deleted after processing\./u);
    expect(text.replace(/\s+/gu, ' ')).toContain("The model's answer was cut off before it finished. Retry: jurator rule propose doc.16");
    // The box: the summary first, then Found path:line, the code line, To fix, the policy sentence once.
    const at = (s: string): number => lines.findIndex((l) => l.includes(s));
    expect(at('BROKEN NOW ━ doc.01')).toBeGreaterThan(0);
    expect(at("Today's code breaks the promise")).toBe(at('BROKEN NOW ━ doc.01') + 1);
    expect(at('Found   src/agent/chats.ts:1 · has 90, allowed at most 30 days')).toBeGreaterThan(at("Today's code breaks"));
    expect(at('1 │ export const CHAT_TTL_DAYS = 90;')).toBe(at('Found   src/agent/chats.ts:1') + 1);
    expect(at('To fix  Set the value at src/agent/chats.ts:1 to at most 30 days.')).toBeGreaterThan(at('1 │ export'));
    expect(at('Policy  "Chats are deleted after 30 days."')).toBeGreaterThan(at('To fix'));
    expect(text).toContain('policies/document-handling.md:7');
    expect(text).not.toContain('Actual');
    expect(text).not.toContain('Proofs');
    expect(text).toContain('jurator explain <promise>');
    expect(text).toContain('Next: review .jurator/rules.json, then jurator rule accept --all');
    // No key, no scripted dir: the summaries come from the program.
    expect(text).toContain('summary by the program (no model key)');
  });

  it('recorded answers (--scripted) give AI summaries, labelled, with the AI note as a doubt', async () => {
    const w = world();
    const { mkdirSync } = await import('node:fs');
    mkdirSync(w.recorded, { recursive: true });
    writeFileSync(join(w.recorded, 'rule-propose__document-handling.01.json'), JSON.stringify(answers['rule-propose:document-handling.01']));
    writeFileSync(
      join(w.recorded, 'explain__broken-now__document-handling.01.json'),
      JSON.stringify({ summary: 'Support chats are kept for 90 days: CHAT_TTL_DAYS in src/agent/chats.ts is 90.', toFix: 'Set CHAT_TTL_DAYS back to 30 or less.', note: null }),
    );
    const { c, out } = ctx(['propose', 'document-handling.01', '--scripted', w.recorded]);
    expect(await runRuleCommand(c, w.deps as never)).toBe(0);
    const text = stripAnsi(out.join('\n'));
    expect(text).toContain('Support chats are kept for 90 days: CHAT_TTL_DAYS in src/agent/chats.ts is 90.');
    expect(text).toContain('summary by AI (recorded answer)');
    expect(text).toContain('To fix  Set CHAT_TTL_DAYS back to 30 or less.');
    // Plain output (no new look) and --json are unchanged: no summary calls.
    const plain = ctx(['propose', 'document-handling.01', '--scripted', w.recorded, '--json'], {});
    expect(await runRuleCommand(plain.c, w.deps as never)).toBe(0);
    expect(JSON.parse(plain.out.join('\n')).results[0].promiseId).toBe('document-handling.01');
  });

  it('--verbose shows the rule, its pattern and the proof inside the box', async () => {
    const w = world();
    const { c, out } = ctx(['propose', 'doc.01', '--verbose', '--no-ai-summary']);
    expect(await runRuleCommand(c, w.deps as never)).toBe(0);
    const text = stripAnsi(out.join('\n'));
    expect(text).toMatch(/Rule\s+R-document-handling\.01-1 \(must-match\)/u);
    expect(text).toMatch(/Pattern\s+CHAT_TTL_DAYS/u);
    expect(text).toContain('summary by the program (--no-ai-summary)');
  });
});
