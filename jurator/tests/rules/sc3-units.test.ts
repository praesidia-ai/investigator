// AC-B (SC-3 fix 6): value rules know units. A ttl, expire or max_age with no unit in its name is read as seconds
// (said in the evidence), the prompt gives a seconds pattern next to the hours one, and the value proof breaks the
// promise in the code's unit. SC-1/SC-2's .20 (results kept at most 24 hours): the TTL is set in config, in seconds
// (`backend-api/src/config.py:89` = 1209600, 14 days); the rule copied the hours-only pattern and named nothing.
import { describe, expect, it } from 'vitest';
import type { Rule } from '../../src/contracts.js';
import { nameUnit, readsAsSeconds, SECONDS_NOTE, unitNote, valueProblem } from '../../src/rules/code-text.js';
import { requiredName, runRule } from '../../src/rules/engine.js';
import { deriveFix } from '../../src/rules/fix.js';
import { breakingValueFor, constraintPromptLines, inSeconds, keptNumberPattern, proveValueChecked } from '../../src/rules/values.js';

const C = 'c'.repeat(40);
const H24 = { name: 'retention', op: '<=' as const, value: 24, unit: 'hours' };
const SECS = keptNumberPattern({ ...H24, value: 86_400, unit: 'seconds' }) as string;
const CONFIG = 'backend-api/src/config.py';
const config = (ttl: string) => [
  {
    path: CONFIG,
    text: [
      '    EXTRACTION_RESULT_CACHE_ENABLED: bool = True',
      `    EXTRACTION_RESULT_CACHE_TTL: int = ${ttl}  # 14 days in seconds (24 hours max)`,
      '    EXTRACTION_RESULT_CACHE_ORG_IDS: list[str] = [',
    ].join('\n'),
  },
];
const valueRule = (pattern: string): Rule =>
  ({
    id: 'R-document-handling.20-1',
    promiseId: 'document-handling.20',
    description: 'the result cache ttl stays within 24 hours',
    mode: 'must-match',
    pattern,
    flags: null,
    globs: ['backend-api/src/**/*.py'],
    anchor: null,
    within: null,
  }) as unknown as Rule;
const NAMED = valueRule(`EXTRACTION_RESULT_CACHE_TTL\\s*(?::\\s*\\w+)?\\s*=\\s*${SECS}`);

describe('a unitless ttl, expire or max_age reads as seconds', () => {
  it('names with no unit word', () => {
    for (const name of ['EXTRACTION_RESULT_CACHE_TTL', 'ttl', 'cacheTtl', 'max_age', 'cookieMaxAge', 'MAX_AGE', 'expiresIn', 'EXPIRE', 'token_expiry']) {
      expect(readsAsSeconds(name), name).toBe(true);
      expect(nameUnit(name), name).toBe(1);
    }
  });
  it('a stated unit wins; points in time and other names are not durations in seconds', () => {
    expect(nameUnit('CHAT_TTL_DAYS')).toBe(86_400);
    expect(nameUnit('ttlMs')).toBe(0.001);
    expect(nameUnit('TTL_HOURS')).toBe(3600);
    for (const name of ['expires_at', 'EXPIRATION_DATE', 'expiry_time', 'retention', 'timeout', 'RESULT_CACHE']) {
      expect(readsAsSeconds(name), name).toBe(false);
      expect(nameUnit(name), name).toBeNull();
    }
  });
  it('the note is said only when seconds were assumed for a longer unit', () => {
    expect(unitNote('EXTRACTION_RESULT_CACHE_TTL', 'hours')).toBe(SECONDS_NOTE);
    expect(unitNote('EXTRACTION_RESULT_CACHE_TTL', 'seconds')).toBeNull();
    expect(unitNote('CHAT_TTL_DAYS', 'hours')).toBeNull();
    expect(unitNote('ttl', 'MB')).toBeNull();
  });
  it('.20: config.py:89 (1209600) is 336 hours, with the note', () => {
    expect(valueProblem('EXTRACTION_RESULT_CACHE_TTL', { kind: 'number', value: 1_209_600, text: '1209600' }, H24)).toBe(
      'EXTRACTION_RESULT_CACHE_TTL is 1209600, which is 336 hours (read as seconds: the name has no unit); the policy allows at most 24 hours',
    );
    expect(valueProblem('EXTRACTION_RESULT_CACHE_TTL', { kind: 'number', value: 86_400, text: '86400' }, H24)).toBeNull();
    expect(valueProblem('ttl', { kind: 'number', value: 3600, text: '60 * 60' }, H24)).toBeNull();
  });
});

describe('.20 with a named rule in seconds', () => {
  it('fails on 14 days and names the setting and the hours', () => {
    const r = runRule(NAMED, config('1209600'), C, { constraint: H24 });
    expect(r.outcome).toBe('fail');
    expect(r.hits.map((h) => h.startLine)).toEqual([2]);
    expect(r.message).toContain('EXTRACTION_RESULT_CACHE_TTL is 1209600, which is 336 hours (read as seconds: the name has no unit)');
  });
  it('passes on 24 hours in seconds (86400), which the old reading called 86400 hours', () => {
    expect(runRule(NAMED, config('86400'), C, { constraint: H24 }).outcome).toBe('pass');
    const loose = valueRule('EXTRACTION_RESULT_CACHE_TTL\\s*(?::\\s*\\w+)?\\s*=\\s*\\d+');
    expect(runRule(loose, config('86400'), C, { constraint: H24 }).outcome).toBe('pass');
    expect(runRule(loose, config('60 * 60 * 24 * 14'), C, { constraint: H24 }).message).toContain('which is 336 hours');
  });
  it("the proof breaks the value in the code's unit (86401, not 25), and skips the 24 in the comment", () => {
    const proof = proveValueChecked(NAMED, config('86400'), C, H24);
    expect(proof).toMatchObject({ applies: true, ok: true });
    expect(proof.mutation).toContain('changed 86400 to 86401 at backend-api/src/config.py:2');
    const short = proveValueChecked(NAMED, config('3600'), C, H24);
    expect(short.mutation).toContain('changed 3600 to 86401');
    expect(short.ok).toBe(true);
  });
  it('the fix sets 24 hours in seconds', () => {
    const failed = runRule(NAMED, config('1209600'), C, { constraint: H24 });
    const fix = deriveFix(NAMED, config('1209600'), C, failed, { constraint: H24, keptExamples: [] });
    expect(fix?.files[0]?.text.split('\n')[1]).toBe('    EXTRACTION_RESULT_CACHE_TTL: int = 86400  # 14 days in seconds (24 hours max)');
  });
  it("the rule a real run kept names no setting: requiredName is null, so AC-A rejects it", () => {
    expect(requiredName('\\w*(?:ttl|retention|hours?|expir\\w*)\\w*["\']?\\s*(?::\\s*\\w+)?\\s*[:=]\\s*(?:[0-9]|1[0-9]|2[0-3]|24)\\b')).toBeNull();
    expect(requiredName(NAMED.pattern)).toBe('EXTRACTION_RESULT_CACHE_TTL');
  });
});

describe('the prompt gives a seconds pattern next to the hours one', () => {
  const lines = constraintPromptLines({
    facets: { subject: 'extraction results', action: 'keep', constraint: { name: 'retention', op: '<=', value: '24', unit: 'hours' } },
  } as never);
  it('says 24 hours is 86400 seconds, with the pattern and the seconds break', () => {
    const text = lines.join('\n');
    expect(text).toContain(`Numbers that keep it are matched by ${keptNumberPattern(H24)}`);
    expect(text).toContain(`24 hours is 86400 seconds: match ${SECS} instead`);
    expect(text).toContain('changes the number on the matched line to 25 (86401 in seconds)');
    expect(text).toContain('The pattern must contain that name');
  });
  it('the seconds pattern matches exactly 0..86400', () => {
    const re = new RegExp(`^x = ${SECS}`, 'u');
    for (const v of [0, 59, 3600, 86_399, 86_400]) expect(re.test(`x = ${v}`), String(v)).toBe(true);
    for (const v of [86_401, 90_000, 172_800, 1_209_600]) expect(re.test(`x = ${v}`), String(v)).toBe(false);
  });
  it('no seconds line for seconds, non-time units or no number', () => {
    expect(inSeconds({ ...H24, unit: 'seconds' })).toBeNull();
    expect(inSeconds({ ...H24, unit: 'MB' })).toBeNull();
    expect(inSeconds({ ...H24, value: 30, unit: 'days' })?.value).toBe(2_592_000);
    expect(breakingValueFor(H24, 86_400, 'CACHE_TTL')).toBe(86_401);
    expect(breakingValueFor({ ...H24, op: '>=' }, 86_400, 'CACHE_TTL')).toBe(86_399);
    expect(breakingValueFor(H24, 24, 'RETENTION_HOURS')).toBe(25);
    expect(breakingValueFor(H24, 24, null)).toBe(25);
  });
});
