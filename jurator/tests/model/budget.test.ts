// R4-FIX: the run budget: $10 by default, --budget <usd>, and what to say when it stops a run.
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../../src/contracts.js';
import { budgetRetryLines, budgetStopLines, isBudgetStop, parseBudget, storeWithBudget, withBudget } from '../../src/model/budget.js';

describe('run budget', () => {
  it('defaults to $10 per run', () => {
    expect(DEFAULT_CONFIG.budgetUsdPerRun).toBe(10);
  });

  it('--budget takes an amount above 0', () => {
    expect(parseBudget(undefined)).toBeUndefined();
    expect(parseBudget('25')).toBe(25);
    expect(parseBudget('$7.5')).toBe(7.5);
    for (const bad of ['0', '-1', 'lots']) expect(() => parseBudget(bad)).toThrow(/--budget takes an amount in USD above 0/u);
    expect(withBudget(DEFAULT_CONFIG, 25).budgetUsdPerRun).toBe(25);
    expect(withBudget(DEFAULT_CONFIG, undefined)).toBe(DEFAULT_CONFIG);
  });

  it('the live run that stopped at 8 of 19 promises: how much more and the exact command', () => {
    const lines = budgetStopLines({ spentUsd: 2.44, budgetUsd: 2, done: 8, left: 11, unit: 'promise', command: 'jurator rule propose --all --accept' });
    expect(lines).toEqual([
      'Budget reached: this run spent $2.44 of its $2.00 budget after 8 promises; 11 promises not asked.',
      'About $3.35 more is needed. Continue with: jurator rule propose --all --accept --budget 5',
    ]);
    // A command that runs everything again (bench) needs a budget for what was spent too.
    const again = budgetStopLines({ spentUsd: 2.44, budgetUsd: 2, done: 8, left: 11, unit: 'model job', command: 'jurator bench', rerunsAll: true });
    expect(again[1]).toBe('About $3.35 more is needed. Continue with: jurator bench --budget 8');
    expect(budgetRetryLines(9.8, 10, 'jurator compile --accept')[1]).toBe('Continue with: jurator compile --accept --budget 20');
  });

  it('recognises the live client stop, and a store can carry the --budget run budget', async () => {
    expect(isBudgetStop(Object.assign(new Error('x'), { code: 'MODEL_BUDGET_EXCEEDED' }))).toBe(true);
    expect(isBudgetStop(new Error('x'))).toBe(false);
    class Store {
      readonly dir = '/x/.jurator';
      async readConfig() {
        return DEFAULT_CONFIG;
      }
      where() {
        return this.dir;
      }
    }
    const s = storeWithBudget(new Store(), 30);
    expect((await s.readConfig()).budgetUsdPerRun).toBe(30);
    expect(s.where()).toBe('/x/.jurator');
    const plain = new Store();
    expect(storeWithBudget(plain, undefined)).toBe(plain);
  });
});
