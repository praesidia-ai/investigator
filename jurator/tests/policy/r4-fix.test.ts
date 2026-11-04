// R4-FIX: backlog items 3 (typed actions normalised before the no-AI comparison), 4 (a number needs a unit) and 6 (staff
// behaviour is a process promise, a compile prompt hint).
import { describe, expect, it } from 'vitest';
import type { PromiseFacets, PromiseRecord } from '../../src/contracts.js';
import { compareAll, comparePromises } from '../../src/policy/compare.js';
import { compilePolicy } from '../../src/policy/compile.js';
import { normaliseAction, normaliseFacets, requireUnit } from '../../src/policy/facets.js';
import { COMPILE_INSTRUCTIONS } from '../../src/policy/prompts.js';
import { doc, NOW, scriptedModel } from './helpers.js';

function p(id: string, facets: PromiseFacets, kind: PromiseRecord['kind'] = 'must'): PromiseRecord {
  return {
    id,
    status: 'accepted',
    wording: `${id} wording`,
    quote: { alias: id.split('.')[0] as string, policySha256: 'a'.repeat(64), text: `${id} quote` },
    kind,
    checkable: 'code',
    scope: [],
    foundBy: 'model',
    firstSeen: NOW.toISOString(),
    facets,
  };
}

describe('typed actions are normalised before the no-AI comparison', () => {
  it('maps keep and delete verbs, even with a qualifier', () => {
    for (const a of ['store', 'stores in cloud storage', 'store in cloud storage', 'retain', 'persist to disk', 'save', 'write to the database', 'are stored on our servers', 'keep']) {
      expect(normaliseAction(a), a).toBe('keep');
    }
    for (const a of ['delete', 'removed from the server', 'purge', 'erase', 'are deleted within']) expect(normaliseAction(a), a).toBe('delete');
    expect(normaliseAction('write to logs')).toBe('log');
    expect(normaliseAction('share with marketing partners')).toBe('share with marketing partners');
  });

  it('"deleted within 30 days" is keep <= 30 days', () => {
    expect(normaliseFacets({ subject: 'documents', action: 'deleted within', constraint: { name: 'deadline', op: '<=', value: '30', unit: 'days' } })).toEqual({
      subject: 'documents',
      action: 'keep',
      constraint: { name: 'retention', op: '<=', value: '30', unit: 'days' },
    });
  });

  it('finds "never stores in cloud storage" vs "deleted within 30 days" with no AI', () => {
    const never = p('documents.02', { subject: 'documents', action: 'store in cloud storage', constraint: { name: 'allowed', op: 'never', value: null, unit: null } }, 'must-not');
    const thirty = p('documents.05', { subject: 'documents', action: 'delete', constraint: { name: 'retention', op: '<=', value: '30', unit: 'days' } });
    const r = comparePromises(never, thirty);
    expect(r).toEqual({
      verdict: 'conflict',
      basis: 'never with at most 30 days',
      example: 'documents.02 says documents are never kept; documents.05 allows keeping them for at most 30 days.',
    });
    const all = compareAll([never, thirty]);
    expect(all.conflicts).toHaveLength(1);
    expect(all.undecided).toEqual([]);
  });

  it('never against a minimum, or against an action that is not keep, stays for the model', () => {
    const never = p('a.01', { subject: 'documents', action: 'store', constraint: { name: 'allowed', op: 'never', value: null, unit: null } });
    const min = p('a.02', { subject: 'documents', action: 'keep', constraint: { name: 'retention', op: '>=', value: '7', unit: 'days' } });
    expect(comparePromises(never, min).verdict).toBe('undecided');
    const exp = p('a.03', { subject: 'documents', action: 'export', constraint: { name: 'limit', op: '<=', value: '5', unit: 'days' } });
    const neverExport = p('a.04', { subject: 'documents', action: 'export', constraint: { name: 'allowed', op: 'never', value: null, unit: null } });
    expect(comparePromises(neverExport, exp).verdict).toBe('undecided');
  });
});

describe('a numeric constraint must carry a unit', () => {
  const noUnit: PromiseFacets = { subject: 'download links', action: 'expire', constraint: { name: 'retention', op: '<=', value: '15', unit: null } };

  it('repairs the unit from the quote', () => {
    const r = requireUnit(normaliseFacets(noUnit), 'Download links expire within 15 minutes.');
    expect(r.note).toBeNull();
    expect(r.facets?.constraint).toEqual({ name: 'retention', op: '<=', value: '15', unit: 'minutes' });
    // "2 weeks" in the quote becomes days, as every duration does.
    const w = requireUnit(normaliseFacets({ ...noUnit, constraint: { name: 'retention', op: '<=', value: '2', unit: null } }), 'Links are deleted after 2 weeks.');
    expect(w.facets?.constraint).toMatchObject({ value: '14', unit: 'days' });
  });

  it('drops the constraint and says so when the quote has no unit', () => {
    const r = requireUnit(normaliseFacets(noUnit), 'Download links expire after 15 or fewer.');
    expect(r.facets?.constraint).toBeNull();
    expect(r.note).toMatch(/has no unit in the quote, so that typed limit was dropped/u);
  });

  it('compile repairs or drops it, and reports the drop as a note', async () => {
    const text = '# Links\n\nDownload links expire within 15 minutes.\n\nAt most 3 or fewer exports run at once.\n';
    const model = scriptedModel({
      'compile:links': {
        promises: [
          {
            wording: 'Download links must expire within 15 minutes.',
            quote: 'Download links expire within 15 minutes.',
            kind: 'must',
            checkable: 'code',
            scope: [],
            params: [],
            sameAs: null,
            facets: { subject: 'download links', action: 'expire', constraint: { name: 'retention', op: '<=', value: '15', unit: null } },
          },
          {
            wording: 'At most 3 exports may run at once.',
            quote: 'At most 3 or fewer exports run at once.',
            kind: 'must',
            checkable: 'code',
            scope: [],
            params: [],
            sameAs: null,
            facets: { subject: 'exports', action: 'run', constraint: { name: 'parallel', op: '<=', value: '3', unit: null } },
          },
        ],
      },
    });
    const r = await compilePolicy(doc('links', 'file', 'docs/links.md', text), [], model, NOW, { codeFiles: [] });
    expect(r.promises[0]?.facets?.constraint).toMatchObject({ value: '15', unit: 'minutes' });
    expect(r.promises[1]?.facets?.constraint).toBeNull();
    expect(r.notes).toEqual([
      '"At most 3 exports may run at once.": the number in "parallel <= 3" has no unit in the quote, so that typed limit was dropped (the promise stays)',
    ]);
  });
});

describe('staff behaviour is a process promise (compile prompt)', () => {
  it('says so, with the example from the dry run', () => {
    expect(COMPILE_INSTRUCTIONS).toContain('What staff, employees or support agents do or must not do');
    expect(COMPILE_INSTRUCTIONS).toContain('staff never open a customer document without an open support ticket');
  });
});
