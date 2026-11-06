// Owner: WP-P. Wiring and printing shared by add/compile/promises/accept/conflicts.
import { resolve } from 'node:path';
import type { CommandContext } from '../cli/context.js';
import type { Config, Contradiction, ModelClient, PromiseRecord, Store } from '../contracts.js';
import { createModel, tryCreateModel } from '../model/index.js';
import { JuratorError } from '../util/errors.js';
import { findRepoRoot, openStore } from '../workspace/index.js';
import { structuredBasis } from './compare.js';
import type { ContradictionStats } from './contradictions.js';
import { BRAND } from '../brand.js';

export async function openWorkspace(ctx: CommandContext): Promise<{ root: string; store: Store }> {
  const root = await findRepoRoot(ctx.cwd);
  const store = openStore(root);
  if (!(await store.exists())) {
    throw new JuratorError('NO_WORKSPACE', `No ${BRAND.folder}/ folder in this repo. Run ${BRAND.command} init first.`);
  }
  return { root, store };
}

/** Scripted when --scripted is given (never the network), else live when a key is set, else null. */
export function modelFor(ctx: CommandContext, config: Config, scripted: string | undefined): ModelClient | null {
  if (scripted) return createModel({ config, env: ctx.env, scriptedDir: resolve(ctx.cwd, scripted) });
  return tryCreateModel({ config, env: ctx.env });
}

export function locatorOf(config: Config, alias: string): string {
  return config.sources.find((s) => s.alias === alias)?.locator ?? alias;
}

export function where(config: Config, p: PromiseRecord): string {
  const loc = locatorOf(config, p.quote.alias);
  const at = p.quote.jsonPointer !== undefined ? `#${p.quote.jsonPointer}` : '';
  return `${loc}${p.quote.line ? `:${p.quote.line}` : ''}${at}`;
}

/** How a quote reads in the terminal: "sentence" for text, `setting: value` for JSON settings. */
export function quoteDisplay(p: PromiseRecord): string {
  return p.quote.jsonPointer !== undefined ? `${p.quote.jsonPointer.slice(1)}: ${p.quote.text}` : `"${p.quote.text}"`;
}

/** Sort key: the position of the promise's source in config (the order people added them). */
export function sourceRank(config: Config, id: string): number {
  const i = config.sources.findIndex((src) => id.startsWith(`${src.alias}.`));
  return i < 0 ? config.sources.length : i;
}

export function money(usd: number): string {
  return `$${usd.toFixed(usd > 0 && usd < 0.01 ? 4 : 2)}`;
}

export function conflictLines(
  ctx: CommandContext,
  c: Contradiction,
  promises: ReadonlyMap<string, PromiseRecord>,
  config: Config,
): string[] {
  const s = ctx.style;
  const label = c.status === 'open' ? s.yellow('open') : c.status === 'real' ? s.red('real') : s.dim('not a conflict');
  const ids = [...c.promiseIds].sort((a, b) => sourceRank(config, a) - sourceRank(config, b) || (a < b ? -1 : 1));
  const out = [`  ${s.bold(c.id)}  ${label}  ${ids.join(' vs ')}`];
  for (const id of ids) {
    const p = promises.get(id);
    if (p) out.push(`      ${id.padEnd(14)} ${quoteDisplay(p)}  ${s.dim(where(config, p))}`);
  }
  out.push(`      Example: ${c.example}`);
  if (c.kind) {
    out.push(
      `      ${c.kind === 'configuration-violation' ? 'A setting breaks a requirement (the requirement itself is not contradicted).' : 'Two requirements that cannot both hold.'}`,
    );
  }
  out.push(`      ${s.dim(foundByLine(c, ids, promises))}`);
  if (c.ruling) out.push(`      Ruled by ${c.ruling.by}: ${c.ruling.why}`);
  return out;
}

/** "Found by comparing 30 days with 90 days (no AI)." for structured conflicts; the model's are labelled as such. */
export function foundByLine(c: Contradiction, ids: readonly string[], promises: ReadonlyMap<string, PromiseRecord>): string {
  if (c.foundBy !== 'structured') return 'Found by the model (AI read of the promises); check the example.';
  const [a, b] = ids.map((id) => promises.get(id));
  const basis = ids.length === 2 && a && b ? structuredBasis(a, b) : null;
  return basis ? `Found by comparing ${basis} (no AI).` : "Found by comparing the promises' typed fields (no AI).";
}

/** "Compared 55 pairs of promises by their typed fields (no AI): 1 conflict; 0 pairs left for the model." */
export function conflictCheckLine(stats: ContradictionStats, conflicts: number): string {
  const n = (k: number, word: string) => `${k} ${word}${k === 1 ? '' : 's'}`;
  const head = `Compared ${n(stats.decided, 'pair')} of promises by their typed fields (no AI): ${n(conflicts, 'conflict')}`;
  if (!stats.undecided) return `${head}.`;
  const tail = stats.modelChecked
    ? `${n(stats.undecided, 'pair')} the program could not decide went to the model`
    : `${n(stats.undecided, 'pair')} the program could not decide were not read (no model; set META_API_KEY or pass --scripted)`;
  return `${head}; ${tail}.`;
}

export function json(ctx: CommandContext, value: unknown): void {
  ctx.out(JSON.stringify(value, null, 2));
}
