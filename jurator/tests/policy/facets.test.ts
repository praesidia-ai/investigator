import { describe, expect, it } from 'vitest';
import type { Contradiction, PromiseFacets, PromiseRecord } from '../../src/contracts.js';
import { toStrictJsonSchema } from '../../src/model/strict.js';
import { compareAll, comparePromises, subjectsOverlap } from '../../src/policy/compare.js';
import { findContradictions } from '../../src/policy/contradictions.js';
import { facetsLine, normaliseFacets } from '../../src/policy/facets.js';
import { compileOutputSchema, contradictionInput } from '../../src/policy/prompts.js';
import { NOW, scriptedModel } from './helpers.js';

type C = NonNullable<PromiseFacets['constraint']>;
const keep = (subject: string, days: string, op: C['op'] = '<='): PromiseFacets => ({
  subject,
  action: 'keep',
  constraint: { name: 'retention', op, value: days, unit: 'days' },
});
const never = (subject: string, action: string): PromiseFacets => ({
  subject,
  action,
  constraint: { name: 'allowed', op: 'never', value: null, unit: null },
});

function p(id: string, facets?: PromiseFacets, kind: PromiseRecord['kind'] = 'must', status: PromiseRecord['status'] = 'accepted'): PromiseRecord {
  return {
    id,
    status,
    wording: `${id} wording`,
    quote: { alias: id.split('.')[0] as string, policySha256: 'a'.repeat(64), text: `${id} quote` },
    kind,
    checkable: 'code',
    scope: [],
    foundBy: 'model',
    firstSeen: NOW.toISOString(),
    ...(facets ? { facets } : {}),
  };
}

describe('normaliseFacets', () => {
  it('lowercases and trims, and is idempotent', () => {
    const f = normaliseFacets({ subject: ' The Support  Chats. ', action: 'Retained', constraint: { name: 'Max Age', op: '<=', value: '30', unit: 'Days' } });
    expect(f).toEqual({ subject: 'support chats', action: 'keep', constraint: { name: 'retention', op: '<=', value: '30', unit: 'days' } });
    expect(normaliseFacets(f)).toEqual(f);
  });

  it('"deleted after 30 days" is the same as "kept for at most 30 days"', () => {
    for (const op of ['==', '<=', '>='] as const) {
      expect(normaliseFacets({ subject: 'support chats', action: 'deleted after', constraint: { name: 'deletion', op, value: '30', unit: 'days' } })).toEqual(
        keep('support chats', '30'),
      );
    }
  });

  it('turns weeks, months and years into days; hours stay hours; never drops any value', () => {
    expect(normaliseFacets({ subject: 'logs', action: 'keep', constraint: { name: 'r', op: '<=', value: '2', unit: 'weeks' } })?.constraint).toEqual({
      name: 'retention', op: '<=', value: '14', unit: 'days',
    });
    expect(normaliseFacets({ subject: 'x', action: 'keep', constraint: { name: 'r', op: '<=', value: '1', unit: 'year' } })?.constraint?.value).toBe('365');
    expect(normaliseFacets({ subject: 'breaches', action: 'notify users', constraint: { name: 'deadline', op: '<=', value: '72', unit: 'Hours' } })?.constraint).toEqual({
      name: 'deadline', op: '<=', value: '72', unit: 'hours',
    });
    expect(normaliseFacets({ subject: 'card numbers', action: 'log', constraint: { name: '', op: 'never', value: '0', unit: 'x' } })?.constraint).toEqual({
      name: 'allowed', op: 'never', value: null, unit: null,
    });
  });

  it('reads what a live model may write instead: "30 days" in the value, other delete verbs', () => {
    expect(normaliseFacets({ subject: 'Support chats', action: 'automatically deleted', constraint: { name: 'after', op: '==', value: '30 days', unit: null } })).toEqual(
      keep('support chats', '30'),
    );
    expect(normaliseFacets({ subject: 'chats', action: 'expire', constraint: { name: 'ttl', op: '<=', value: '4 weeks', unit: null } })?.constraint).toEqual({
      name: 'retention', op: '<=', value: '28', unit: 'days',
    });
  });

  it('gives undefined without a subject or an action', () => {
    expect(normaliseFacets(null)).toBeUndefined();
    expect(normaliseFacets({ subject: '  ', action: 'keep', constraint: null })).toBeUndefined();
    expect(normaliseFacets({ subject: 'notes', action: null, constraint: null })).toBeUndefined();
  });

  it('prints one line for people', () => {
    expect(facetsLine(keep('support chats', '30'))).toBe('support chats · keep · retention <= 30 days');
    expect(facetsLine(never('card numbers', 'log'))).toBe('card numbers · log · never');
  });
});

describe('comparePromises (no AI)', () => {
  it('finds the acme retention conflict with a computed example', () => {
    const r = comparePromises(p('privacy.01', keep('support chats', '30')), p('praesidia.01', keep('support chats', '90')));
    expect(r).toEqual({
      verdict: 'conflict',
      basis: '30 days with 90 days',
      example: 'A support chat from 1 March must be gone by 31 March under privacy.01 but may stay until 30 May under praesidia.01.',
    });
  });

  it('matches subjects that contain each other or are listed as the same data', () => {
    expect(subjectsOverlap('chats', 'support chats')).toBe(true);
    expect(subjectsOverlap('support chat', 'support chats')).toBe(true);
    expect(subjectsOverlap('customer data', 'support chats')).toBe(true);
    expect(subjectsOverlap('notes', 'chats')).toBe(true);
    expect(subjectsOverlap('passwords', 'card numbers and passwords')).toBe(true);
    expect(subjectsOverlap('personal data', 'customer data')).toBe(false);
    expect(subjectsOverlap('search_notes', 'notes')).toBe(false);
    const r = comparePromises(p('privacy.01', keep('chats', '30')), p('praesidia.01', keep('customer data', '90')));
    expect(r.verdict).toBe('conflict');
  });

  it('says ok for different subjects, different actions, or limits that can both hold', () => {
    expect(comparePromises(p('a.01', keep('support chats', '30')), p('b.01', keep('passwords', '90'))).verdict).toBe('ok');
    expect(comparePromises(p('a.01', keep('support chats', '30')), p('b.01', never('support chats', 'export'))).verdict).toBe('ok');
    expect(comparePromises(p('a.01', keep('support chats', '30')), p('b.01', keep('support chats', '30'))).verdict).toBe('ok');
    expect(comparePromises(p('a.01', keep('support chats', '30')), p('b.01', keep('support chats', '10', '>='))).verdict).toBe('ok');
    const role = (value: string): PromiseFacets => ({ subject: 'customer data', action: 'export', constraint: { name: 'role', op: '==', value, unit: null } });
    expect(comparePromises(p('a.01', role('admin')), p('b.01', role('admin'))).verdict).toBe('ok');
  });

  it('finds limits that cannot both hold and clashing words', () => {
    expect(comparePromises(p('a.01', keep('support chats', '30')), p('b.01', keep('support chats', '90', '>='))).verdict).toBe('conflict');
    // "kept exactly 30 days" against "at most 90 days" still names two different retentions.
    expect(comparePromises(p('a.01', keep('support chats', '30', '==')), p('b.01', keep('support chats', '90'))).verdict).toBe('conflict');
    const role = (value: string): PromiseFacets => ({ subject: 'customer data', action: 'export', constraint: { name: 'role', op: '==', value, unit: null } });
    expect(comparePromises(p('a.01', role('admin')), p('b.01', role('owner')))).toMatchObject({ verdict: 'conflict', basis: 'role admin with role owner' });
    const always: PromiseFacets = { subject: 'notes', action: 'share with advertisers', constraint: { name: 'allowed', op: 'always', value: null, unit: null } };
    expect(comparePromises(p('a.01', never('notes', 'share with advertisers')), p('b.01', always))).toMatchObject({ verdict: 'conflict', basis: 'never with always' });
    expect(comparePromises(p('a.01', never('notes', 'share with advertisers')), p('b.01', { subject: 'notes', action: 'share with advertisers', constraint: null }, 'may'))).toMatchObject({
      verdict: 'conflict',
      basis: 'never with may',
    });
    // Two deadlines for different actions are not a retention clash: "within 72 hours" and "within 30 days" both hold.
    const notify = (value: string, unit: string): PromiseFacets => ({ subject: 'breaches', action: 'notify users', constraint: { name: 'deadline', op: '<=', value, unit } });
    expect(comparePromises(p('a.01', notify('72', 'hours')), p('b.01', notify('30', 'days'))).verdict).toBe('ok');
  });

  it('leaves pairs it cannot weigh to the model', () => {
    expect(comparePromises(p('a.01'), p('b.01', keep('support chats', '30'))).verdict).toBe('undecided');
    const admins: PromiseFacets = { subject: 'notes', action: 'export', constraint: { name: 'role', op: '==', value: 'admin', unit: null } };
    expect(comparePromises(p('a.01', never('notes', 'export')), p('b.01', admins)).verdict).toBe('undecided');
  });

  it('compareAll skips retired promises and counts pairs', () => {
    const r = compareAll([
      p('privacy.01', keep('support chats', '30')),
      p('praesidia.01', keep('support chats', '90')),
      p('security.01', never('card numbers', 'log')),
      p('local.01'),
      p('old.01', keep('support chats', '1'), 'must', 'retired'),
    ]);
    expect(r.pairs).toBe(6);
    expect(r.conflicts.map((c) => c.promiseIds)).toEqual([['privacy.01', 'praesidia.01']]);
    expect(r.undecided).toEqual([['privacy.01', 'local.01'], ['praesidia.01', 'local.01'], ['security.01', 'local.01']]);
    expect(r.decided).toBe(3);
  });
});

describe('findContradictions: the program first, the model only for undecided pairs', () => {
  const typed = [p('privacy.01', keep('support chats', '30')), p('praesidia.01', keep('support chats', '90')), p('security.03', never('card numbers', 'log'))];

  it('finds C-1 with no model call when every pair is decided', async () => {
    const model = scriptedModel({});
    const r = await findContradictions(typed, [], model);
    expect(model.calls).toEqual([]);
    expect(r.contradictions).toEqual([
      {
        id: 'C-1',
        promiseIds: ['praesidia.01', 'privacy.01'],
        example: 'A support chat from 1 March must be gone by 31 March under privacy.01 but may stay until 30 May under praesidia.01.',
        status: 'open',
        foundBy: 'structured',
      },
    ]);
    expect(r.stats).toEqual({ pairs: 3, decided: 3, undecided: 0, modelChecked: false });
    // Same without any model at all.
    expect((await findContradictions(typed, [], null)).contradictions.map((c) => c.foundBy)).toEqual(['structured']);
  });

  it('asks the model only about undecided pairs and ignores its answers on decided ones', async () => {
    const promises = [...typed, p('local.01')];
    let input = '';
    const model = scriptedModel({
      contradictions: {
        conflicts: [
          { promiseIds: ['privacy.01', 'security.03'], example: 'The program already decided this pair.' },
          { promiseIds: ['local.01', 'security.03'], example: 'local.01 logs card numbers that security.03 forbids.' },
        ],
      },
    });
    const spy = { ...model, json: async <T,>(req: Parameters<typeof model.json<T>>[0]) => ((input = req.input), model.json(req)) };
    const r = await findContradictions(promises, [], spy);
    expect(input).toContain('Pairs to check:\nprivacy.01 vs local.01\npraesidia.01 vs local.01\nsecurity.03 vs local.01');
    expect(input).toContain('privacy.01 | must | privacy.01 wording | facets: support chats · keep · retention <= 30 days');
    expect(r.contradictions.map((c) => [c.id, c.promiseIds, c.foundBy])).toEqual([
      ['C-1', ['praesidia.01', 'privacy.01'], 'structured'],
      ['C-2', ['local.01', 'security.03'], 'model'],
    ]);
    expect(r.stats).toEqual({ pairs: 6, decided: 3, undecided: 3, modelChecked: true });
  });

  it('keeps ids and rulings, upgrades a model finding to structured, drops model findings the program now decides', async () => {
    const existing: Contradiction[] = [
      { id: 'C-3', promiseIds: ['privacy.01', 'praesidia.01'], example: 'old', status: 'real', foundBy: 'model', ruling: { by: 'reviewer', why: 'privacy wins', at: NOW.toISOString() } },
      { id: 'C-4', promiseIds: ['privacy.01', 'security.03'], example: 'model guess', status: 'open', foundBy: 'model' },
      { id: 'C-5', promiseIds: ['praesidia.01', 'security.03'], example: 'ruled fine', status: 'not-a-conflict', foundBy: 'model' },
    ];
    const r = await findContradictions(typed, existing, null);
    expect(r.contradictions.map((c) => [c.id, c.status, c.foundBy, c.example])).toEqual([
      ['C-3', 'real', 'structured', 'old'],
      ['C-5', 'not-a-conflict', 'model', 'ruled fine'],
    ]);
    expect(r.contradictions[0]?.ruling?.by).toBe('reviewer');
  });
});

describe('prompt schemas', () => {
  it('the compile schema with nullable facets fits Meta strict output', () => {
    const strict = toStrictJsonSchema(compileOutputSchema, 'policy_promises');
    const item = (strict.schema['properties'] as Record<string, { items: { required: string[] } }>)['promises']?.items;
    expect(item?.required).toContain('facets');
  });

  it('contradiction input without pairs stays a plain list', () => {
    expect(contradictionInput([{ id: 'a.01', kind: 'must', wording: 'w' }])).toBe('a.01 | must | w');
  });
});
