// FX-3: `jurator bench`. Rules only needs no model; the AI rows use fake or scripted answers (never the network).
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  aiReadTaskKey,
  applyCase,
  loadBench,
  plainTaskKey,
  promisesForSentence,
  renderBenchText,
  runBench,
  touchedPromises,
  unifiedDiff,
  type LabelledModel,
} from '../../src/bench/index.js';
import command from '../../src/cli/commands/bench.js';
import type { CommandContext } from '../../src/cli/context.js';
import type { ModelClient, ModelJsonRequest, ModelJsonResult } from '../../src/contracts.js';
import { makeStyle } from '../../src/util/term.js';

const data = await loadBench();
const now = () => new Date('2026-11-04T06:00:00Z');

/** Answers by task key; anything not listed is "kept" (AI read) or no findings (plain). */
function fakeModel(id: string, answers: Record<string, unknown>, tasks: string[] = []): ModelClient {
  return {
    id,
    mode: 'scripted',
    async json<T>(request: ModelJsonRequest<T>): Promise<ModelJsonResult<T>> {
      tasks.push(request.task);
      const fallback = request.task.startsWith('bench:plain:')
        ? { violations: [] }
        : request.task.startsWith('redteam:') && !request.task.startsWith('redteam:judge:')
          ? { evasions: [] }
          : { verdict: 'kept', explanation: 'looks fine', citations: [] };
      return {
        value: request.schema.parse(answers[request.task] ?? fallback),
        usage: { id, mode: 'scripted', inputTokens: 100, outputTokens: 10, usd: 0.01 },
      };
    },
  };
}
const broken = (path: string, line: number) => ({
  verdict: 'broken',
  explanation: 'breaks it',
  citations: [{ path, startLine: line, endLine: line }],
});

describe('bench data', () => {
  it('loads 5 breaks and 3 harmless changes that all apply to the baseline', () => {
    expect(data.cases.filter((c) => c.kind === 'break')).toHaveLength(5);
    expect(data.cases.filter((c) => c.kind === 'harmless')).toHaveLength(3);
    for (const c of data.cases) expect(applyCase(data, c).changed.length).toBeGreaterThan(0);
    expect(data.files.map((f) => f.path)).toContain('src/agent/chats.ts');
    expect(data.policies.map((p) => p.alias)).toEqual(['privacy', 'security', 'praesidia']);
  });

  it('selects the promises a change touches, like check --diff', () => {
    const b4 = applyCase(data, data.cases.find((c) => c.id === 'B4')!);
    expect(touchedPromises(data, b4).map((p) => p.id).sort()).toEqual(['praesidia.01', 'praesidia.02', 'praesidia.03', 'privacy.01', 'security.03']);
  });
});

describe('runBench', () => {
  it('rules only: catches B1-B3, never the promise with no rule (B5), no false alarms, $0', async () => {
    const report = await runBench({ data, budgetUsd: 1, now });
    const rules = report.methods[0]!;
    expect(rules.method.kind).toBe('rules');
    const caught = rules.cases.filter((c) => c.caught).map((c) => c.caseId);
    // B4 (30 * 3) depends on whether the engine evaluates simple arithmetic (FX-1); B5 has no rule at all.
    expect(caught).toEqual(expect.arrayContaining(['B1', 'B2', 'B3']));
    expect(caught).not.toContain('B5');
    expect([rules.breaks, rules.falseAlarms, rules.harmless, rules.wrongFlags, rules.usd]).toEqual([5, 0, 3, 0, 0]);
    expect(rules.baselineFlags).toEqual([]);
    expect(report.mode).toBe('offline');
    expect(renderBenchText(report)).toMatch(/Rules only \(no AI\)\s+[34]\/5\s+0\/3/u);
  });

  it('scores AI reads against the unchanged code, derives the Jurator row, and maps plain findings to promises', async () => {
    const wonder = fakeModel('w', {
      // An old finding: flagged on the unchanged code and on every change, so it is never counted.
      [aiReadTaskKey('BASE', 'praesidia.02')]: broken('src/agent/tools.ts', 5),
      ...Object.fromEntries(data.cases.map((c) => [aiReadTaskKey(c.id, 'praesidia.02'), broken('src/agent/tools.ts', 5)])),
      [aiReadTaskKey('B4', 'privacy.01')]: broken('src/agent/chats.ts', 2),
      [aiReadTaskKey('B5', 'privacy.03')]: broken('src/routes/notes.ts', 6),
      // A false alarm on a harmless change.
      [aiReadTaskKey('H3', 'security.03')]: broken('src/auth/passwords.ts', 12),
      // "broken" with a line that does not exist is not evidence.
      [aiReadTaskKey('B1', 'privacy.01')]: broken('src/agent/chats.ts', 99),
    });
    const tasks: string[] = [];
    const plain = fakeModel(
      'p',
      {
        [plainTaskKey('B2')]: {
          violations: [{ policyFile: 'docs/security.md', policySentence: '- Only workspace admins can export customer data.', file: 'src/routes/export.ts', explanation: 'no admin check' }],
        },
        [plainTaskKey('H2')]: {
          violations: [{ policyFile: 'docs/security.md', policySentence: 'Be careful with exports.', file: 'src/routes/export.ts', explanation: 'vague' }],
        },
      },
      tasks,
    );
    const readers: LabelledModel[] = [{ label: 'muse-wonder-1.0', client: wonder }];
    const report = await runBench({ data, readers, plain: { label: 'muse-wonder-1.0', client: plain }, budgetUsd: 5, now });
    const by = Object.fromEntries(report.methods.map((m) => [m.method.kind, m]));

    expect(by['ai-read']!.baselineFlags).toEqual(['praesidia.02']);
    expect(by['ai-read']!.cases.filter((c) => c.caught).map((c) => c.caseId)).toEqual(['B4', 'B5']);
    expect(by['ai-read']!.cases.find((c) => c.caseId === 'B1')!.promises.find((p) => p.promiseId === 'privacy.01')!.verdict).toBe('cant-tell');
    expect(by['ai-read']!.falseAlarms).toBe(1);
    expect(by['ai-read']!.wrongFlags).toBe(1);

    // Jurator: the rules decide where a rule exists (B1-B3, and security.03 on H3), the AI read elsewhere (B5).
    expect(by['jurator']!.cases.filter((c) => c.caught).map((c) => c.caseId)).toEqual(expect.arrayContaining(['B1', 'B2', 'B3', 'B5']));
    expect(by['jurator']!.falseAlarms).toBe(0);
    expect(by['jurator']!.baselineFlags).toEqual(['praesidia.02']);

    expect(by['plain']!.cases.find((c) => c.caseId === 'B2')!.flagged).toEqual(['security.01']);
    expect(by['plain']!.cases.find((c) => c.caseId === 'H2')!.flagged).toEqual(['?']);
    expect([by['plain']!.catches, by['plain']!.falseAlarms, by['plain']!.calls]).toEqual([1, 1, 8]);
    expect(tasks).toHaveLength(8);
    expect(report.mode).toBe('scripted');
    expect(report.costUsd).toBeGreaterThan(0);

    const text = renderBenchText(report);
    expect(text).toContain('Old flags, AI read, muse-wonder-1.0: praesidia.02');
    expect(text).toMatch(/B4 Chat lifetime written as 30 \* 3 \(90 days\)\s+(missed|caught)\s+caught/u);
  });

  it('stops starting model calls once the budget is spent', async () => {
    const reader: LabelledModel = { label: 'muse-spark-1.3', client: fakeModel('s', {}) };
    const report = await runBench({ data, readers: [reader], budgetUsd: 0.05, concurrency: 1, now });
    expect(report.skippedForBudget).toBeGreaterThan(0);
    expect(report.costUsd).toBeLessThanOrEqual(0.06);
    expect(renderBenchText(report)).toContain('skipped for budget');
  });

  it('runs the red team over every accepted rule', async () => {
    const attacker = fakeModel('a', {
      'redteam:R-privacy.01-1': {
        evasions: [{ path: 'src/agent/chats.ts', find: 'CHAT_TTL_DAYS * 24', replace: '365 * 24', why: 'x' }],
      },
    });
    const judge = fakeModel('j', { 'redteam:judge:R-privacy.01-1:1': broken('src/agent/chats.ts', 2) });
    const report = await runBench({
      data,
      rules: false,
      redteam: { attacker: { label: 'muse-spark-1.3', client: attacker }, judge: { label: 'muse-wonder-1.0', client: judge } },
      budgetUsd: 1,
      now,
    });
    expect(report.redteam!.reports).toHaveLength(data.rules.length);
    expect(report.redteam!.reports.filter((r) => r.verdict === 'weak').map((r) => r.ruleId)).toEqual(['R-privacy.01-1']);
    expect(renderBenchText(report)).toContain('1 of 6 rules weak');
  });
});

describe('helpers', () => {
  it('maps a plain finding to promises by its policy sentence or JSON setting', () => {
    const accepted = data.promises.filter((p) => p.status === 'accepted');
    expect(promisesForSentence('1. Support chats are deleted after 30 days.', accepted)).toEqual(['privacy.01']);
    expect(promisesForSentence('"dataRetentionDays": 90', accepted)).toEqual(['praesidia.01']);
    expect(promisesForSentence('"allowedTools": ["search_notes", "export_notes"]', accepted).sort()).toEqual(['praesidia.02', 'praesidia.03']);
    expect(promisesForSentence('Never be evil.', accepted)).toEqual([]);
  });

  it('writes a unified diff', () => {
    const diff = unifiedDiff('src/a.ts', 'a\nb\nc\n', 'a\nB\nc\nd\n');
    expect(diff).toBe(['--- a/src/a.ts', '+++ b/src/a.ts', '@@ -1,3 +1,4 @@', ' a', '-b', '+B', ' c', '+d'].join('\n'));
    expect(unifiedDiff('x', 'same', 'same')).toBe('');
    expect(unifiedDiff('n.ts', null, 'new\n')).toContain('--- /dev/null');
  });
});

describe('bench command', () => {
  function ctx(argv: string[], env: NodeJS.ProcessEnv = {}) {
    const out: string[] = [];
    const err: string[] = [];
    const c: CommandContext = {
      cwd: process.cwd(),
      argv,
      env,
      out: (l) => out.push(l),
      err: (l) => err.push(l),
      style: makeStyle(false),
      now,
    };
    return { c, out, err };
  }

  it('runs the rules only without a key and says so', async () => {
    const { c, out, err } = ctx([]);
    expect(await command.run(c)).toBe(0);
    expect(err.join('\n')).toContain('No model key found');
    expect(out.join('\n')).toContain('Rules only (no AI)');
    expect(out.join('\n')).toContain('Next:');
  });

  it('rejects unknown cases and bad numbers with exit 2', async () => {
    expect(await command.run(ctx(['--cases', 'Z9', '--no-ai']).c)).toBe(2);
    expect(await command.run(ctx(['--budget', '-1']).c)).toBe(2);
    expect(await command.run(ctx(['--bogus']).c)).toBe(2);
  });

  it('runs every row from a scripted folder and prints JSON', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bench-scripted-'));
    const kept = { verdict: 'kept', explanation: 'fine', citations: [] };
    const codePromises = data.promises.filter((p) => p.status === 'accepted' && p.checkable === 'code');
    for (const p of codePromises) {
      for (const id of ['BASE', 'B4']) writeFileSync(join(dir, `${aiReadTaskKey(id, p.id).replaceAll(':', '__')}.json`), JSON.stringify(kept));
    }
    writeFileSync(join(dir, 'bench__ai-read__B4__privacy.01.json'), JSON.stringify(broken('src/agent/chats.ts', 2)));
    writeFileSync(
      join(dir, 'bench__plain__B4.json'),
      JSON.stringify({ violations: [{ policyFile: 'docs/privacy.md', policySentence: 'Support chats are deleted after 30 days.', file: 'src/agent/chats.ts', explanation: '90 days' }] }),
    );
    const { c, out } = ctx(['--cases', 'B4', '--no-redteam', '--scripted', dir, '--json']);
    expect(await command.run(c)).toBe(0);
    const report = JSON.parse(out.join('\n'));
    expect(report.mode).toBe('scripted');
    const rows = Object.fromEntries(report.methods.map((m: { method: { id: string }; catches: number }) => [m.method.id, m.catches]));
    expect(Object.keys(rows)).toEqual(['rules', 'ai-read:muse-wonder-1.0', 'ai-read:muse-spark-1.3', 'plain:muse-wonder-1.0', 'jurator:muse-wonder-1.0']);
    expect([rows['ai-read:muse-wonder-1.0'], rows['ai-read:muse-spark-1.3'], rows['plain:muse-wonder-1.0']]).toEqual([1, 1, 1]);
    // privacy.01 has a rule, so the Jurator row follows the rule on B4.
    expect(rows['jurator:muse-wonder-1.0']).toBe(rows['rules']);
  });
});
