// Owner: WP-P. Contradictions between promises. The program compares typed facets first (no AI, foundBy
// 'structured'); the model reads only the pairs the program could not decide. The program checks every id the model
// names and keeps C-n ids stable.
import type { Contradiction, ModelClient, ModelUsage, PromiseRecord } from '../contracts.js';
import { compareAll } from './compare.js';
import { CONTRADICTION_INSTRUCTIONS, contradictionInput, contradictionOutputSchema } from './prompts.js';

function setKey(ids: readonly string[]): string {
  return [...new Set(ids)].sort().join('+');
}
function contradictionNumber(id: string): number {
  return Number(id.slice(2)) || 0;
}

export interface ContradictionStats {
  /** Pairs of live promises. */
  readonly pairs: number;
  /** Pairs the program decided by comparing typed facets (no AI). */
  readonly decided: number;
  /** Pairs left for the model. */
  readonly undecided: number;
  /** True when the model read the undecided pairs in this run. */
  readonly modelChecked: boolean;
}

export async function findContradictions(
  promises: readonly PromiseRecord[],
  existing: readonly Contradiction[],
  model: ModelClient | null,
): Promise<{ contradictions: Contradiction[]; usage: ModelUsage[]; stats: ContradictionStats }> {
  const active = promises.filter((p) => p.status !== 'retired');
  const activeIds = new Set(active.map((p) => p.id));
  const stillValid = (c: Contradiction) => c.promiseIds.every((id) => activeIds.has(id));

  const compared = compareAll(active);
  const undecided = new Set(compared.undecided.map((pair) => setKey(pair)));
  /** True when at least one pair inside the set is one the program could not decide. */
  const needsModel = (ids: readonly string[]) => {
    for (let i = 0; i < ids.length; i += 1) {
      for (let j = i + 1; j < ids.length; j += 1) if (undecided.has(setKey([ids[i] as string, ids[j] as string]))) return true;
    }
    return false;
  };

  const byKey = new Map(existing.map((c) => [setKey(c.promiseIds), c]));
  let next = existing.reduce((max, c) => Math.max(max, contradictionNumber(c.id)), 0) + 1;
  const out = new Map<string, Contradiction>();
  const add = (ids: string[], example: string, foundBy: Contradiction['foundBy']) => {
    const key = setKey(ids);
    if (out.has(key)) return;
    const prev = byKey.get(key);
    if (prev) {
      out.set(key, { ...prev, foundBy, example: prev.status === 'open' ? example : prev.example });
    } else {
      out.set(key, { id: `C-${next}`, promiseIds: [...ids].sort(), example, status: 'open', foundBy });
      next += 1;
    }
  };

  // 1. The program: same subject and action, constraints that cannot both hold.
  for (const c of compared.conflicts) add([...c.promiseIds], c.example, 'structured');

  // 2. The model, only for the pairs the program could not decide.
  const usage: ModelUsage[] = [];
  let modelChecked = false;
  if (model && compared.undecided.length) {
    const involved = new Set(compared.undecided.flat());
    const result = await model.json({
      task: 'contradictions',
      instructions: CONTRADICTION_INSTRUCTIONS,
      input: contradictionInput(
        active.filter((p) => involved.has(p.id)),
        compared.undecided,
      ),
      schemaName: 'promise_conflicts',
      schema: contradictionOutputSchema,
      maxOutputTokens: 4000,
    });
    usage.push(result.usage);
    modelChecked = true;
    for (const found of result.value.conflicts) {
      // The program decides: every id must be a live promise, at least two distinct, with an example, and the set
      // must hold a pair the comparator left open (the model cannot overrule a pair the program decided).
      const named = [...new Set(found.promiseIds.map((id) => id.trim()))];
      const ids = named.filter((id) => activeIds.has(id)).sort();
      const example = found.example.trim();
      if (ids.length < 2 || ids.length !== named.length || example.length < 3) continue;
      if (!needsModel(ids)) continue;
      add(ids, example, 'model');
    }
  }

  // 3. Carry over what this run did not re-decide. A "not a conflict" ruling stays while its promises are live (so it
  // is not raised again). A model finding stays when the model did not run and its pair is still undecided. Open and
  // "real" conflicts nobody reports any more go away: the sources were changed so they agree.
  for (const c of existing) {
    const key = setKey(c.promiseIds);
    if (out.has(key) || !stillValid(c)) continue;
    if (c.status === 'not-a-conflict') out.set(key, c);
    else if (!modelChecked && c.foundBy === 'model' && needsModel(c.promiseIds)) out.set(key, c);
  }
  const contradictions = [...out.values()].sort((a, b) => contradictionNumber(a.id) - contradictionNumber(b.id));
  return {
    contradictions,
    usage,
    stats: { pairs: compared.pairs, decided: compared.decided, undecided: compared.undecided.length, modelChecked },
  };
}
