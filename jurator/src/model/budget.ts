// R4-FIX: the run budget. Default $10 per run (config budgetUsdPerRun), `--budget <usd>` on compile, rule, bind, check
// and bench; when the budget stops a run, the command says how much more is needed and the exact command to continue.
import type { Config } from '../contracts.js';
import { JuratorError } from '../util/errors.js';

/** The error code the live client throws when a run reached its budget before a call. */
export const BUDGET_ERROR = 'MODEL_BUDGET_EXCEEDED';

/** True for the live client's budget stop (no call was made, nothing more was spent). */
export function isBudgetStop(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === BUDGET_ERROR;
}

/** `--budget` value -> dollars; undefined when the flag is absent. Throws BAD_INPUT on anything but an amount above 0. */
export function parseBudget(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw.replace(/^\$/u, ''));
  if (!Number.isFinite(n) || n <= 0) throw new JuratorError('BAD_INPUT', `--budget takes an amount in USD above 0, such as 10, not ${raw}`);
  return n;
}

/** The config with the run budget replaced when `--budget` was given. */
export function withBudget(config: Config, usd: number | undefined): Config {
  return usd === undefined ? config : { ...config, budgetUsdPerRun: usd };
}

export interface BudgetStop {
  /** Spent by this run. */
  readonly spentUsd: number;
  /** The budget it ran under. */
  readonly budgetUsd: number;
  /** Items finished (with a model answer) before the stop. */
  readonly done: number;
  /** Items not asked because of the stop. */
  readonly left: number;
  /** What an item is, singular (promise, source, pair). */
  readonly unit: string;
  /** The command that continues (without --budget); the suggested budget is appended. */
  readonly command: string;
  /** True when that command runs everything again (bench), so its budget covers what was already spent too. */
  readonly rerunsAll?: boolean;
}

const usd = (n: number): string => `$${n.toFixed(2)}`;

/** About how much the items left would cost (the average so far), and a budget that covers them with a margin. */
export function budgetNeeded(stop: Pick<BudgetStop, 'spentUsd' | 'budgetUsd' | 'done' | 'left'>): { moreUsd: number; suggestUsd: number } {
  const each = stop.done > 0 ? stop.spentUsd / stop.done : stop.budgetUsd;
  const moreUsd = Math.max(0.01, each * Math.max(1, stop.left));
  // A whole-dollar budget with a 25% margin, at least $1.
  const suggestUsd = Math.max(1, Math.ceil(moreUsd * 1.25));
  return { moreUsd, suggestUsd };
}

/** The plain lines a command prints when the budget stopped it: what was spent, what is needed, how to continue. */
export function budgetStopLines(stop: BudgetStop): string[] {
  const { moreUsd, suggestUsd: forLeft } = budgetNeeded(stop);
  const suggestUsd = stop.rerunsAll ? Math.max(1, Math.ceil((stop.spentUsd + moreUsd) * 1.25)) : forLeft;
  const units = (n: number): string => `${n} ${stop.unit}${n === 1 ? '' : 's'}`;
  return [
    `Budget reached: this run spent ${usd(stop.spentUsd)} of its ${usd(stop.budgetUsd)} budget after ${units(stop.done)}; ` +
      `${units(stop.left)} not asked.`,
    `About ${usd(moreUsd)} more is needed. Continue with: ${stop.command} --budget ${suggestUsd}`,
  ];
}

/** For a command that stops as a whole (compile): the budget reached, and the command again with twice the budget. */
export function budgetRetryLines(spentUsd: number, budgetUsd: number, command: string): string[] {
  return [
    `Budget reached: this run spent ${usd(spentUsd)} of its ${usd(budgetUsd)} budget before it finished.`,
    `Continue with: ${command} --budget ${Math.max(1, Math.ceil(budgetUsd * 2))}`,
  ];
}

/** A store whose config carries the `--budget` run budget (for code that reads the config itself, like check). */
export function storeWithBudget<S extends { readConfig(): Promise<Config> }>(store: S, budgetUsd: number | undefined): S {
  if (budgetUsd === undefined) return store;
  return new Proxy(store, {
    get(target, key) {
      if (key === 'readConfig') return async () => withBudget(await target.readConfig(), budgetUsd);
      const value = Reflect.get(target, key, target) as unknown;
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
}
