import { describe, expect, it, vi } from 'vitest';
import { promiseSchema, type PromiseRecord } from '../../src/contracts.js';
import { compilePolicy } from '../../src/policy/compile.js';
import { ACME_CODE_FILES, ACME_FIXTURES, doc, fakePraesidia, NOW, PRAESIDIA_JSON, PRIVACY_MD, scriptedModel } from './helpers.js';

vi.mock('../../src/connectors/index.js', async () => {
  const h = await import('./helpers.js');
  return {
    getConnector: (id: string) => {
      if (id === 'praesidia') return h.fakePraesidia;
      if (id === 'file') return { id: 'file', readOnly: true, fetch: async () => { throw new Error('unused'); } };
      throw new Error(`unknown connector ${id}`);
    },
  };
});

const LATER = new Date('2026-11-05T09:00:00.000Z');
const privacy = () => doc('privacy', 'file', 'docs/privacy.md', PRIVACY_MD);

function draft(wording: string, quote: string, sameAs: string | null = null) {
  return { wording, quote, kind: 'must', checkable: 'code', scope: [], params: [], sameAs, facets: null };
}

describe('compilePolicy (text, scripted model)', () => {
  it('compiles the acme privacy policy: 4 promises, quotes located, 1 paraphrase dropped', async () => {
    const model = scriptedModel(ACME_FIXTURES);
    const r = await compilePolicy(privacy(), [], model, NOW, { codeFiles: ACME_CODE_FILES });
    expect(model.calls).toEqual(['compile:privacy']);
    expect(r.promises.map((p) => p.id)).toEqual(['privacy.01', 'privacy.02', 'privacy.03', 'privacy.04']);
    for (const p of r.promises) {
      expect(promiseSchema.parse(p)).toEqual(p);
      expect(p.status).toBe('draft');
      expect(p.foundBy).toBe('model');
      expect(p.firstSeen).toBe(NOW.toISOString());
      expect(p.quote.policySha256).toBe(privacy().sha256);
      expect(PRIVACY_MD.slice(p.quote.start, p.quote.end)).toBe(p.quote.text);
    }
    const p1 = r.promises[0] as PromiseRecord;
    expect(p1.quote.line).toBe(7);
    expect(p1.scope).toEqual(['src/agent/**']);
    expect(p1.params).toEqual([{ name: 'retentionDays', value: '30', unit: 'days' }]);
    expect(r.promises[3]?.checkable).toBe('process');
    expect(r.dropped).toEqual([
      { wording: 'Deleted notes are removed from backups within 30 days.', reason: 'quote not found word for word in docs/privacy.md' },
    ]);
  });

  it('drops scope globs that match no code file and keeps at most 6 (AC-C: was 3)', async () => {
    const scope = ['./src/agent/**', 'lib/**', '../x', 'src/**', 'src/log.ts', 'src/http.ts', 'src/auth/**', 'src/routes/**', 'src/export/**'];
    const model = scriptedModel({
      'compile:privacy': {
        promises: [{ ...draft('Chats are deleted after 30 days.', 'Support chats are deleted after 30 days.'), scope }],
      },
    });
    const r = await compilePolicy(privacy(), [], model, NOW, { codeFiles: ACME_CODE_FILES });
    expect(r.promises[0]?.scope).toEqual(['src/agent/**', 'src/**', 'src/log.ts', 'src/http.ts', 'src/auth/**', 'src/routes/**']);
  });

  it('needs a model for text sources', async () => {
    await expect(compilePolicy(privacy(), [], null, NOW)).rejects.toMatchObject({ code: 'MODEL_KEY_REQUIRED' });
  });
});

describe('stable ids', () => {
  async function first(): Promise<PromiseRecord[]> {
    return (await compilePolicy(privacy(), [], scriptedModel(ACME_FIXTURES), NOW)).promises;
  }

  it('recompiling the same policy keeps ids, status and firstSeen; accepted keeps reviewed fields', async () => {
    const before = (await first()).map((p) => (p.id === 'privacy.01' ? { ...p, status: 'accepted' as const, scope: ['src/agent/chats.ts'] } : p));
    const again = await compilePolicy(privacy(), before, scriptedModel(ACME_FIXTURES), LATER);
    expect(again.promises.map((p) => [p.id, p.status, p.firstSeen])).toEqual(before.map((p) => [p.id, p.status, NOW.toISOString()]));
    expect(again.promises[0]?.scope).toEqual(['src/agent/chats.ts']);
  });

  it('same quote with different spacing or a list marker keeps the id', async () => {
    const before = await first();
    const model = scriptedModel({
      'compile:privacy': { promises: [draft('Chats go after 30 days.', '1.   Support chats are deleted  after 30 days.')] },
    });
    const r = await compilePolicy(privacy(), before, model, LATER);
    const live = r.promises.filter((p) => p.status !== 'retired');
    expect(live.map((p) => p.id)).toEqual(['privacy.01']);
    expect(live[0]?.quote.text).toBe('Support chats are deleted after 30 days.');
  });

  it('a reworded policy sentence keeps its id (model sameAs), goes back to draft and records the old quote', async () => {
    const before = (await first()).map((p) => ({ ...p, status: 'accepted' as const }));
    const edited = PRIVACY_MD.replace('Exports never include deleted or archived notes.', 'Exports never contain notes you deleted or archived.');
    const model = scriptedModel({
      'compile:privacy': {
        promises: [
          draft('Support chats are deleted after 30 days.', 'Support chats are deleted after 30 days.'),
          draft('Exports never contain deleted or archived notes.', 'Exports never contain notes you deleted or archived.', 'privacy.02'),
          draft('Notes are never sold.', 'We never sell your notes or share them with advertisers.'),
          draft('Breach notice in 72 hours.', 'We tell you within 72 hours of a breach that affects your data.'),
        ],
      },
    });
    const r = await compilePolicy(doc('privacy', 'file', 'docs/privacy.md', edited), before, model, LATER);
    const p2 = r.promises.find((p) => p.id === 'privacy.02')!;
    expect(p2.status).toBe('draft');
    expect(p2.quote.text).toBe('Exports never contain notes you deleted or archived.');
    expect(p2.rewordedFrom).toEqual(['Exports never include deleted or archived notes.']);
    expect(p2.firstSeen).toBe(NOW.toISOString());
    expect(r.promises.filter((p) => p.status === 'accepted').map((p) => p.id)).toEqual(['privacy.01', 'privacy.03', 'privacy.04']);
  });

  it('ignores a sameAs that points at an unknown or already matched id', async () => {
    const before = await first();
    const model = scriptedModel({
      'compile:privacy': {
        promises: [
          draft('Support chats are deleted after 30 days.', 'Support chats are deleted after 30 days.'),
          draft('Exports skip archived notes.', 'Exports never include deleted or archived notes.', 'privacy.01'),
          draft('Nothing sold.', 'We never sell your notes or share them with advertisers.', 'security.09'),
        ],
      },
    });
    const r = await compilePolicy(privacy(), before, model, LATER);
    expect(r.promises.filter((p) => p.status !== 'retired').map((p) => p.id)).toEqual(['privacy.01', 'privacy.02', 'privacy.03']);
  });

  it('a removed sentence retires its promise; a new one gets the next number, never a retired one', async () => {
    const before = await first();
    const edited = PRIVACY_MD.replace('3. We never sell your notes or share them with advertisers.\n', '').concat('\n5. We delete your account data within 14 days of closing it.\n');
    const model = scriptedModel({
      'compile:privacy': {
        promises: [
          draft('Support chats are deleted after 30 days.', 'Support chats are deleted after 30 days.'),
          draft('Exports skip deleted and archived notes.', 'Exports never include deleted or archived notes.'),
          draft('Breach notice in 72 hours.', 'We tell you within 72 hours of a breach that affects your data.'),
          draft('Account data is deleted within 14 days of closing.', 'We delete your account data within 14 days of closing it.'),
        ],
      },
    });
    const r = await compilePolicy(doc('privacy', 'file', 'docs/privacy.md', edited), before, model, LATER);
    expect(r.promises.map((p) => [p.id, p.status])).toEqual([
      ['privacy.01', 'draft'],
      ['privacy.02', 'draft'],
      ['privacy.03', 'retired'],
      ['privacy.04', 'draft'],
      ['privacy.05', 'draft'],
    ]);
    expect(r.promises[4]?.firstSeen).toBe(LATER.toISOString());

    // Retired numbers are never reused, even when the newest promise retires too.
    const third = await compilePolicy(
      doc('privacy', 'file', 'docs/privacy.md', PRIVACY_MD),
      r.promises,
      scriptedModel({ 'compile:privacy': { promises: [draft('Chats go after 30 days.', 'Support chats are deleted after 30 days.'), draft('Exports skip archived notes.', 'Exports never include deleted or archived notes.'), draft('Breach notice.', 'We tell you within 72 hours of a breach that affects your data.')] } }),
      LATER,
    );
    expect(third.promises.find((p) => p.id === 'privacy.05')?.status).toBe('retired');
    const fourth = await compilePolicy(
      doc('privacy', 'file', 'docs/privacy.md', `${PRIVACY_MD}\n6. Notes are encrypted at rest.\n`),
      third.promises,
      scriptedModel({ 'compile:privacy': { promises: [draft('Notes are encrypted at rest.', 'Notes are encrypted at rest.')] } }),
      LATER,
    );
    expect(fourth.promises.filter((p) => p.status !== 'retired').map((p) => p.id)).toEqual(['privacy.06']);
  });

  it('a retired sentence that comes back is revived under its old id as a draft', async () => {
    const before = (await first()).map((p) => (p.id === 'privacy.03' ? { ...p, status: 'retired' as const } : p));
    const r = await compilePolicy(privacy(), before, scriptedModel(ACME_FIXTURES), LATER);
    expect(r.promises.find((p) => p.id === 'privacy.03')?.status).toBe('draft');
    expect(r.promises.some((p) => p.id === 'privacy.05')).toBe(false);
  });
});

describe('structured sources (no AI)', () => {
  const praesidia = (text = PRAESIDIA_JSON) => doc('praesidia', 'praesidia', 'policies/praesidia-support-agent.json', text);

  it('turns Praesidia settings into promises without calling the model, with JSON pointers verified', async () => {
    const model = scriptedModel({});
    const r = await compilePolicy(praesidia(), [], model, NOW);
    expect(model.calls).toEqual([]);
    expect(r.promises.map((p) => [p.id, p.wording])).toEqual([
      ['praesidia.01', 'Data is kept for at most 90 days.'],
      ['praesidia.02', 'search_notes needs approval before it runs.'],
      ['praesidia.03', 'export_notes needs approval before it runs.'],
      ['praesidia.04', 'Personal data is blocked from agent output.'],
    ]);
    expect(r.promises[0]?.quote).toMatchObject({ jsonPointer: '/dataRetentionDays', text: '90', line: 5 });
    expect(r.promises.every((p) => p.foundBy === 'structured')).toBe(true);
    expect(r.dropped).toEqual([]);
  });

  it('drops a structured draft whose setting does not hold that value', async () => {
    const spy = vi.spyOn(fakePraesidia, 'toPromises').mockImplementationOnce((d) => [
      { wording: 'Data is kept for at most 30 days.', quote: { alias: 'praesidia', policySha256: d.sha256, text: '30', jsonPointer: '/dataRetentionDays' }, kind: 'must', checkable: 'code', scope: [], foundBy: 'structured' },
      { wording: 'Something missing.', quote: { alias: 'praesidia', policySha256: d.sha256, text: 'x', jsonPointer: '/nope' }, kind: 'must', checkable: 'code', scope: [], foundBy: 'structured' },
    ]);
    const r = await compilePolicy(praesidia(), [], null, NOW);
    expect(spy).toHaveBeenCalled();
    expect(r.promises).toEqual([]);
    expect(r.dropped.map((d) => d.reason)).toEqual([
      'setting /dataRetentionDays is not 30 in policies/praesidia-support-agent.json',
      'setting /nope not found in policies/praesidia-support-agent.json',
    ]);
  });

  it('a changed setting value keeps the id, goes back to draft and records the old value', async () => {
    const before = (await compilePolicy(praesidia(), [], null, NOW)).promises.map((p) => ({ ...p, status: 'accepted' as const }));
    const v8 = PRAESIDIA_JSON.replace('"version": 7', '"version": 8').replace('"dataRetentionDays": 90', '"dataRetentionDays": 30');
    const r = await compilePolicy(praesidia(v8), before, null, LATER);
    const p1 = r.promises.find((p) => p.id === 'praesidia.01')!;
    expect(p1).toMatchObject({ status: 'draft', wording: 'Data is kept for at most 30 days.', rewordedFrom: ['90'] });
    expect(r.promises.filter((p) => p.status === 'accepted').map((p) => p.id)).toEqual(['praesidia.02', 'praesidia.03', 'praesidia.04']);
  });

  it('a reordered or extended tool list keeps every id; a new tool gets the next number', async () => {
    const before = (await compilePolicy(praesidia(), [], null, NOW)).promises.map((p) => ({ ...p, status: 'accepted' as const }));
    const v8 = PRAESIDIA_JSON.replace('["search_notes", "export_notes"]', '["delete_account", "export_notes", "search_notes"]');
    const r = await compilePolicy(praesidia(v8), before, null, LATER);
    expect(r.promises.map((p) => [p.id, p.status, p.wording])).toEqual([
      ['praesidia.01', 'accepted', 'Data is kept for at most 90 days.'],
      ['praesidia.02', 'accepted', 'search_notes needs approval before it runs.'],
      ['praesidia.03', 'accepted', 'export_notes needs approval before it runs.'],
      ['praesidia.04', 'accepted', 'Personal data is blocked from agent output.'],
      ['praesidia.05', 'draft', 'delete_account needs approval before it runs.'],
    ]);
    expect(r.promises[1]?.quote.jsonPointer).toBe('/allowedTools/2');
  });

  it('compiles `add --promise` sentences word for word with no AI', async () => {
    const text = '# Local promises\n\n- We never log access tokens.\n- Admin actions are recorded in the audit log.\n';
    const r = await compilePolicy(doc('local', 'file', '.jurator/sources/local.md', text), [], null, NOW);
    expect(r.promises.map((p) => [p.id, p.kind, p.foundBy, p.quote.line])).toEqual([
      ['local.01', 'must-not', 'human', 3],
      ['local.02', 'must', 'human', 4],
    ]);
  });
});
