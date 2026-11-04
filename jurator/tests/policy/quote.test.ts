import { describe, expect, it } from 'vitest';
import { copySpan, jsonValueMatches, locateQuote, quoteKey, resolveJsonPointer } from '../../src/policy/quote.js';
import { PRIVACY_MD, SECURITY_MD } from './helpers.js';

describe('locateQuote', () => {
  it('finds an exact sentence and returns raw offsets and the 1-based line', () => {
    const q = 'Support chats are deleted after 30 days.';
    const at = locateQuote(PRIVACY_MD, q);
    expect(at).not.toBeNull();
    expect(PRIVACY_MD.slice(at!.start, at!.end)).toBe(q);
    expect(at!.line).toBe(7);
  });

  it('collapses whitespace runs on both sides, across line breaks', () => {
    const text = 'Intro.\n\nWe tell you within\n   72 hours of a breach.\n';
    const at = locateQuote(text, 'We  tell you within 72\thours of a breach.');
    expect(at).not.toBeNull();
    expect(text.slice(at!.start, at!.end)).toBe('We tell you within\n   72 hours of a breach.');
    expect(copySpan(text, at!.start, at!.end)).toBe('We tell you within 72 hours of a breach.');
    expect(at!.line).toBe(3);
  });

  it('ignores a leading list marker in the quote and markdown emphasis', () => {
    expect(locateQuote(PRIVACY_MD, '2. Exports never include deleted or archived notes.')?.line).toBe(8);
    expect(locateQuote(SECURITY_MD, '- Only workspace admins can export customer data.')?.line).toBe(3);
    const text = 'Rule: **Only admins** can export `customer` data.';
    const at = locateQuote(text, 'Only admins can export customer data.');
    expect(at).not.toBeNull();
    expect(text.slice(at!.start, at!.end)).toBe('Only admins** can export `customer` data.');
  });

  it('treats curly quotes and straight quotes alike', () => {
    expect(locateQuote('We don’t sell notes.', "We don't sell notes.")).not.toBeNull();
  });

  it('returns null when a word differs (no paraphrases)', () => {
    expect(locateQuote(PRIVACY_MD, 'Support chats are removed after 30 days.')).toBeNull();
    expect(locateQuote(PRIVACY_MD, 'Deleted notes are removed from backups within 30 days.')).toBeNull();
    expect(locateQuote(PRIVACY_MD, '   ')).toBeNull();
  });
});

describe('quote helpers', () => {
  it('quoteKey ignores spacing, case, list markers and the final period', () => {
    expect(quoteKey('1.  Support chats are deleted after 30 days.')).toBe(quoteKey('support chats are deleted after 30 days'));
  });
  it('resolves JSON pointers and matches setting values', () => {
    const root = { dataRetentionDays: 90, allowedTools: ['search_notes', 'export_notes'], 'a/b': true };
    expect(resolveJsonPointer(root, '/dataRetentionDays')).toEqual({ found: true, value: 90 });
    expect(resolveJsonPointer(root, '/allowedTools/1').value).toBe('export_notes');
    expect(resolveJsonPointer(root, '/a~1b').value).toBe(true);
    expect(resolveJsonPointer(root, '/missing').found).toBe(false);
    expect(resolveJsonPointer(root, '/allowedTools/5').found).toBe(false);
    expect(jsonValueMatches(90, '90')).toBe(true);
    expect(jsonValueMatches(['search_notes', 'export_notes'], 'export_notes')).toBe(true);
    expect(jsonValueMatches(90, '30')).toBe(false);
  });
});
