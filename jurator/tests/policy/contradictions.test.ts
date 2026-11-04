import { describe, expect, it } from 'vitest';
import type { Contradiction, PromiseRecord } from '../../src/contracts.js';
import { findContradictions } from '../../src/policy/contradictions.js';
import { ACME_FIXTURES, NOW, scriptedModel } from './helpers.js';

function promise(id: string, wording: string, status: PromiseRecord['status'] = 'accepted'): PromiseRecord {
  return {
    id,
    status,
    wording,
    quote: { alias: id.split('.')[0] as string, policySha256: 'a'.repeat(64), text: wording },
    kind: 'must',
    checkable: 'code',
    scope: [],
    foundBy: 'model',
    firstSeen: NOW.toISOString(),
  };
}
const PROMISES = [
  promise('privacy.01', 'Support chats are deleted after 30 days.'),
  promise('privacy.02', 'Exports never include deleted or archived notes.'),
  promise('praesidia.01', 'Data is kept for at most 90 days.'),
  promise('security.01', 'Only workspace admins can export customer data.'),
  promise('security.02', 'Old retired promise.', 'retired'),
];

describe('findContradictions', () => {
  it('finds the acme retention conflict from the scripted answer', async () => {
    const model = scriptedModel(ACME_FIXTURES);
    const r = await findContradictions(PROMISES, [], model);
    expect(model.calls).toEqual(['contradictions']);
    expect(r.contradictions).toEqual([
      {
        id: 'C-1',
        promiseIds: ['praesidia.01', 'privacy.01'],
        example: expect.stringContaining('31 March'),
        status: 'open',
        foundBy: 'model',
      },
    ]);
  });

  it('drops sets with unknown, retired or too few ids, and duplicates', async () => {
    const model = scriptedModel({
      contradictions: {
        conflicts: [
          { promiseIds: ['privacy.01', 'nope.01'], example: 'made up id' },
          { promiseIds: ['privacy.01', 'security.02'], example: 'retired promise' },
          { promiseIds: ['privacy.01', 'privacy.01'], example: 'same id twice' },
          { promiseIds: ['privacy.02', 'security.01'], example: 'Exports by admins could include archived notes.' },
          { promiseIds: ['security.01', 'privacy.02'], example: 'the same set again' },
          { promiseIds: ['privacy.01', 'praesidia.01'], example: '' },
        ],
      },
    });
    const r = await findContradictions(PROMISES, [], model);
    expect(r.contradictions.map((c) => [c.id, c.promiseIds])).toEqual([['C-1', ['privacy.02', 'security.01']]]);
  });

  it('keeps existing C-n ids and rulings for the same set, numbers new ones next, drops stale open and real ones', async () => {
    const existing: Contradiction[] = [
      { id: 'C-1', promiseIds: ['privacy.01', 'praesidia.01'], example: 'old example', status: 'not-a-conflict', foundBy: 'model', ruling: { by: 'reviewer', why: 'different data', at: NOW.toISOString() } },
      { id: 'C-2', promiseIds: ['privacy.02', 'security.01'], example: 'stale', status: 'open', foundBy: 'model' },
      { id: 'C-3', promiseIds: ['privacy.02', 'praesidia.01'], example: 'ruled real, since fixed at the source', status: 'real', foundBy: 'model' },
      { id: 'C-4', promiseIds: ['security.02', 'privacy.01'], example: 'about a retired promise', status: 'not-a-conflict', foundBy: 'model' },
      { id: 'C-6', promiseIds: ['security.01', 'privacy.01'], example: 'ruled fine', status: 'not-a-conflict', foundBy: 'model' },
    ];
    const model = scriptedModel({
      contradictions: {
        conflicts: [
          { promiseIds: ['praesidia.01', 'privacy.01'], example: 'new example text' },
          { promiseIds: ['security.01', 'praesidia.01'], example: 'A brand new clash with real values.' },
        ],
      },
    });
    const r = await findContradictions(PROMISES, existing, model);
    expect(r.contradictions.map((c) => [c.id, c.status, c.example])).toEqual([
      ['C-1', 'not-a-conflict', 'old example'],
      ['C-6', 'not-a-conflict', 'ruled fine'],
      ['C-7', 'open', 'A brand new clash with real values.'],
    ]);
    expect(r.contradictions[0]?.ruling?.by).toBe('reviewer');
  });

  it('without a model keeps existing conflicts whose promises are all live', async () => {
    const existing: Contradiction[] = [
      { id: 'C-1', promiseIds: ['privacy.01', 'praesidia.01'], example: 'kept', status: 'open', foundBy: 'model' },
      { id: 'C-2', promiseIds: ['security.02', 'privacy.01'], example: 'gone', status: 'open', foundBy: 'model' },
    ];
    const r = await findContradictions(PROMISES, existing, null);
    expect(r.contradictions.map((c) => c.id)).toEqual(['C-1']);
    expect(r.usage).toEqual([]);
  });
});
