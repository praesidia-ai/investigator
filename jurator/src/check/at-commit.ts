// Owner: WP-K (FX-1). The workspace as git stores it at a commit (rules, promises, bindings), and the no-AI check of
// value bindings. Reading rules from git, not the working tree, means a branch cannot weaken its own rule before a
// push, and `verify` re-runs the rules a record was made with.
import { BRAND } from '../brand.js';
import {
  bindingSchema,
  itemsFile,
  promiseSchema,
  ruleSchema,
  type Binding,
  type Citation,
  type PromiseRecord,
  type Rule,
  type RuleRunResult,
} from '../contracts.js';
import type { GitRepo } from '../contracts.js';
import { anchorIn } from '../bindings/index.js';
import { codeView, describeOp, valueAssigned, valueProblem, type ValueConstraint } from '../rules/code-text.js';
import { numericConstraint } from '../rules/values.js';

export interface WorkspaceAt {
  /** null when the file is not in git at that commit (or is not valid). */
  readonly rules: Rule[] | null;
  readonly promises: PromiseRecord[] | null;
  readonly bindings: Binding[] | null;
}

async function itemsAt<T>(repo: GitRepo, commit: string, path: string, schema: ReturnType<typeof itemsFile>): Promise<T[] | null> {
  try {
    const parsed = schema.safeParse(JSON.parse(await repo.readFile(commit, path)));
    return parsed.success ? (parsed.data.items as T[]) : null;
  } catch {
    return null;
  }
}

/** Rules, promises and bindings committed at `commit` (each null when absent). Never throws. */
export async function workspaceAt(repo: GitRepo, commit: string): Promise<WorkspaceAt> {
  const dir = BRAND.folder;
  const rules = await itemsAt<Rule>(repo, commit, `${dir}/rules.json`, itemsFile(ruleSchema));
  const bindings = await itemsAt<Binding>(repo, commit, `${dir}/bindings.json`, itemsFile(bindingSchema));
  let promises: PromiseRecord[] | null = null;
  try {
    const paths = (await repo.listFiles(commit, [`${dir}/promises/*.json`])).sort();
    for (const path of paths) {
      const items = await itemsAt<PromiseRecord>(repo, commit, path, itemsFile(promiseSchema));
      if (items) promises = [...(promises ?? []), ...items];
    }
  } catch {
    promises = null;
  }
  return { rules, promises, bindings };
}

/** `primary` wins for an id both have; items only in `extra` are added (sorted by id). */
export function mergeById<T extends { id: string }>(primary: readonly T[], extra: readonly T[]): T[] {
  const ids = new Set(primary.map((x) => x.id));
  return [...primary, ...extra.filter((x) => !ids.has(x.id))].sort((a, b) => a.id.localeCompare(b.id));
}

/** The promise's number as a rule needs it (from its typed facets), or null. */
export function constraintOf(promise: Pick<PromiseRecord, 'facets'> | undefined): ValueConstraint | null {
  const c = promise ? numericConstraint(promise) : null;
  return c ? { op: c.op, value: c.value, unit: c.unit } : null;
}

function bindingConstraint(b: Binding): ValueConstraint | null {
  const e = b.expected;
  if (!e || e.value === null || (e.op !== '<=' && e.op !== '>=' && e.op !== '==')) return null;
  const raw = e.value.trim().replace(/_/gu, '');
  if (!/^\d+(?:\.\d+)?$/u.test(raw)) return null;
  return { op: e.op, value: Number(raw), unit: e.unit };
}
const VALUE_KINDS = new Set<Binding['kind']>(['constant', 'config']);

/** The value bindings of a promise that say what number the policy expects. */
export function valueBindings(promiseId: string, bindings: readonly Binding[]): Binding[] {
  return bindings
    .filter((b) => b.promiseId === promiseId && b.symbol !== null && VALUE_KINDS.has(b.kind) && bindingConstraint(b) !== null)
    .sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * No AI: each value binding of the promise, found again in the code at `commit`, and the literal it holds compared
 * with what the policy expects. A literal that breaks it fails ("CHAT_TTL_DAYS is 90; the policy allows at most 30
 * days"); a literal that keeps it passes. A binding that is lost, or holds an expression, gives no result here (the
 * rules judge expressions). `ruleId` is the binding id.
 */
export async function checkBindings(
  promiseId: string,
  bindings: readonly Binding[],
  read: (path: string) => Promise<string>,
  commit: string,
): Promise<RuleRunResult[]> {
  const out: RuleRunResult[] = [];
  for (const b of valueBindings(promiseId, bindings)) {
    const c = bindingConstraint(b) as ValueConstraint;
    const symbol = b.symbol as string;
    let text: string;
    try {
      text = await read(b.path);
    } catch {
      continue;
    }
    const at = anchorIn(b, text);
    if (!at) continue;
    const view = codeView(b.path, text);
    const raw = text.split(/\r?\n/u);
    let found: { line: number; value: Extract<ReturnType<typeof valueAssigned>, { kind: 'number' }> } | null = null;
    for (let n = at.startLine; n <= at.endLine && !found; n += 1) {
      const v = valueAssigned(view.code[n - 1] ?? '', symbol);
      if (v?.kind === 'number') found = { line: n, value: v };
      else if (v) break;
    }
    if (!found) continue;
    const why = valueProblem(symbol, found.value, c);
    const hit: Citation = { path: b.path, commit, startLine: found.line, endLine: found.line, quote: raw[found.line - 1] ?? '' };
    out.push({
      ruleId: b.id,
      promiseId,
      outcome: why ? 'fail' : 'pass',
      hits: [hit],
      message: why
        ? `${b.path}:${found.line}: ${why} (binding ${b.id})`
        : `${b.path}:${found.line}: ${symbol} is ${found.value.text}, which keeps ${describeOp(c)} (binding ${b.id})`,
    });
  }
  return out;
}
